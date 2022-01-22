import "module-alias/register";

import { solidityKeccak256 } from "ethers/lib/utils";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { FeeSplitExtension, StreamingFeeModule, DebtIssuanceModule, BaseManagerV2 } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getSetFixture,
  getStreamingFee,
  getStreamingFeeInflationAmount,
  getTransactionTimestamp,
  getWaffleExpect,
  increaseTimeAsync,
  preciseMul,
  getRandomAccount
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("FeeSplitExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let operatorFeeRecipient: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManagerV2;
  let feeExtension: FeeSplitExtension;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      operatorFeeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();

    const feeRecipient = baseManagerV2.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(.1),
      ether(.01),
      ether(.005),
      baseManagerV2.address,
      ADDRESS_ZERO
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectStreamingFeeModule: Address;
    let subjectDebtIssuanceModule: Address;
    let subjectOperatorFeeSplit: BigNumber;
    let subjectOperatorFeeRecipient: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
      subjectDebtIssuanceModule = setV2Setup.debtIssuanceModule.address;
      subjectOperatorFeeSplit = ether(.7);
      subjectOperatorFeeRecipient = operatorFeeRecipient.address;
    });

    async function subject(): Promise<FeeSplitExtension> {
      return await deployer.extensions.deployFeeSplitExtension(
        subjectManager,
        subjectStreamingFeeModule,
        subjectDebtIssuanceModule,
        subjectOperatorFeeSplit,
        subjectOperatorFeeRecipient
      );
    }

    it("should set the correct SetToken address", async () => {
      const feeExtension = await subject();

      const actualToken = await feeExtension.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const feeExtension = await subject();

      const actualManager = await feeExtension.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct streaming fee module address", async () => {
      const feeExtension = await subject();

      const actualStreamingFeeModule = await feeExtension.streamingFeeModule();
      expect(actualStreamingFeeModule).to.eq(subjectStreamingFeeModule);
    });

    it("should set the correct debt issuance module address", async () => {
      const feeExtension = await subject();

      const actualDebtIssuanceModule = await feeExtension.issuanceModule();
      expect(actualDebtIssuanceModule).to.eq(subjectDebtIssuanceModule);
    });

    it("should set the correct operator fee split", async () => {
      const feeExtension = await subject();

      const actualOperatorFeeSplit = await feeExtension.operatorFeeSplit();
      expect(actualOperatorFeeSplit).to.eq(subjectOperatorFeeSplit);
    });

    it("should set the correct operator fee recipient", async () => {
      const feeExtension = await subject();

      const actualOperatorFeeRecipient = await feeExtension.operatorFeeRecipient();
      expect(actualOperatorFeeRecipient).to.eq(subjectOperatorFeeRecipient);
    });
  });

  context("when fee extension is deployed and system fully set up", async () => {
    const operatorSplit: BigNumber = ether(.7);

    beforeEach(async () => {
      feeExtension = await deployer.extensions.deployFeeSplitExtension(
        baseManagerV2.address,
        setV2Setup.streamingFeeModule.address,
        setV2Setup.debtIssuanceModule.address,
        operatorSplit,
        operatorFeeRecipient.address
      );

      await baseManagerV2.connect(operator.wallet).addExtension(feeExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);

      // Protect StreamingFeeModule
      await baseManagerV2
        .connect(operator.wallet)
        .protectModule(setV2Setup.streamingFeeModule.address, [feeExtension.address]);

      // Set extension as fee recipient
      await feeExtension.connect(operator.wallet).updateFeeRecipient(feeExtension.address);
      await feeExtension.connect(methodologist.wallet).updateFeeRecipient(feeExtension.address);
    });

    describe("#accrueFeesAndDistribute", async () => {
      let mintedTokens: BigNumber;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.accrueFeesAndDistribute();
      }

      it("should send correct amount of fees to operator fee recipient and methodologist", async () => {
        const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const totalSupply = await setToken.totalSupply();

        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          setV2Setup.streamingFeeModule,
          setToken.address,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );

        const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

        const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
        const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
        const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

        const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
        const methodologistBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
        expect(methodologistBalance).to.eq(expectedMethodologistTake);
      });

      it("should emit a FeesDistributed event", async () => {
        await expect(subject()).to.emit(feeExtension, "FeesDistributed");
      });

      describe("when methodologist fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updateFeeSplit(ether(1));
          await feeExtension.connect(methodologist.wallet).updateFeeSplit(ether(1));
        });

        it("should not send fees to methodologist", async () => {
          const preMethodologistBalance = await setToken.balanceOf(methodologist.address);

          await subject();

          const postMethodologistBalance = await setToken.balanceOf(methodologist.address);
          expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
        });
      });

      describe("when operator fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updateFeeSplit(ZERO);
          await feeExtension.connect(methodologist.wallet).updateFeeSplit(ZERO);
        });

        it("should not send fees to operator fee recipient", async () => {
          const preOperatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);

          await subject();

          const postOperatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
          expect(postOperatorFeeRecipientBalance.sub(preOperatorFeeRecipientBalance)).to.eq(ZERO);
        });
      });

      describe("when extension has fees accrued, is removed and no longer the feeRecipient", () => {
        let txnTimestamp: BigNumber;
        let feeState: any;
        let expectedFeeInflation: BigNumber;
        let totalSupply: BigNumber;

        beforeEach(async () => {
          feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
          totalSupply = await setToken.totalSupply();

          // Accrue fees to extension by StreamingFeeModule by direct call
          txnTimestamp = await getTransactionTimestamp(
            setV2Setup.streamingFeeModule.accrueFee(setToken.address)
          );

          expectedFeeInflation = await getStreamingFee(
            setV2Setup.streamingFeeModule,
            setToken.address,
            feeState.lastStreamingFeeTimestamp,
            txnTimestamp
          );

          // Change fee recipient to baseManagerV2;
          await feeExtension.connect(operator.wallet).updateFeeRecipient(baseManagerV2.address);
          await feeExtension.connect(methodologist.wallet).updateFeeRecipient(baseManagerV2.address);

          // Revoke extension authorization
          await baseManagerV2.connect(operator.wallet).revokeExtensionAuthorization(
            setV2Setup.streamingFeeModule.address,
            feeExtension.address
          );

          await baseManagerV2.connect(methodologist.wallet).revokeExtensionAuthorization(
            setV2Setup.streamingFeeModule.address,
            feeExtension.address
          );

          // Remove extension
          await baseManagerV2.connect(operator.wallet).removeExtension(feeExtension.address);
        });

        it("should send residual fees to operator fee recipient and methodologist", async () => {
          await subject();

          const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

          const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
          const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
          const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

          const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
          const methodologistBalance = await setToken.balanceOf(methodologist.address);

          expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
          expect(methodologistBalance).to.eq(expectedMethodologistTake);
        });
      });
    });

    describe("#initializeIssuanceModule", () => {
      let subjectSetToken: Address;
      let subjectExtension: FeeSplitExtension;
      let subjectIssuanceModule: DebtIssuanceModule;
      let subjectStreamingFeeModule: StreamingFeeModule;
      let subjectManager: Address;
      let subjectOperatorFeeSplit: BigNumber;
      let subjectOperatorFeeRecipient: Address;
      let subjectMaxManagerFee: BigNumber;
      let subjectManagerIssueFee: BigNumber;
      let subjectManagerRedeemFee: BigNumber;
      let subjectManagerIssuanceHook: Address;

      beforeEach( async () => {
        subjectSetToken = setToken.address;
        subjectManager = baseManagerV2.address;
        subjectStreamingFeeModule = setV2Setup.streamingFeeModule;
        subjectOperatorFeeSplit = ether(.7);
        subjectOperatorFeeRecipient = operator.address;
        subjectMaxManagerFee = ether(.1);
        subjectManagerIssueFee = ether(.01);
        subjectManagerRedeemFee = ether(.005);
        subjectManagerIssuanceHook = ADDRESS_ZERO;

        // Protect current issuance Module
        await baseManagerV2.connect(operator.wallet).protectModule(setV2Setup.debtIssuanceModule.address, []);

        // Deploy new issuance module
        subjectIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(setV2Setup.controller.address);
        await setV2Setup.controller.addModule(subjectIssuanceModule.address);

        // Deploy new issuance extension
        subjectExtension = await deployer.extensions.deployFeeSplitExtension(
          subjectManager,
          subjectStreamingFeeModule.address,
          subjectIssuanceModule.address,
          subjectOperatorFeeSplit,
          subjectOperatorFeeRecipient,
        );

        // Replace module and extension
        await baseManagerV2.connect(operator.wallet).replaceProtectedModule(
          setV2Setup.debtIssuanceModule.address,
          subjectIssuanceModule.address,
          [subjectExtension.address]
        );

        await baseManagerV2.connect(methodologist.wallet).replaceProtectedModule(
          setV2Setup.debtIssuanceModule.address,
          subjectIssuanceModule.address,
          [subjectExtension.address]
        );

        // Authorize new extension for StreamingFeeModule too..
        await baseManagerV2.connect(operator.wallet).authorizeExtension(
          subjectStreamingFeeModule.address,
          subjectExtension.address
        );

        await baseManagerV2.connect(methodologist.wallet).authorizeExtension(
          subjectStreamingFeeModule.address,
          subjectExtension.address
        );
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
         return await subjectExtension.connect(caller.wallet).initializeIssuanceModule(
           subjectMaxManagerFee,
           subjectManagerIssueFee,
           subjectManagerRedeemFee,
           subjectExtension.address,
           subjectManagerIssuanceHook
         );
      }

      context("when both parties call the method", async () => {
        it("should initialize the debt issuance module", async () => {
          const initialFeeRecipient = (
            await subjectIssuanceModule.issuanceSettings(subjectSetToken)
          ).feeRecipient;

          await subject(operator);
          await subject(methodologist);

          const finalFeeRecipient = (
            await subjectIssuanceModule.issuanceSettings(subjectSetToken)
          ).feeRecipient;

          expect(initialFeeRecipient).to.equal(ADDRESS_ZERO);
          expect(finalFeeRecipient).to.equal(subjectExtension.address);
        });

        it("should enable calls on the protected module", async () => {
          const newFeeRecipient = baseManagerV2.address;

          await subject(operator);
          await subject(methodologist);

          // Reset fee recipient
          await subjectExtension.connect(operator.wallet).updateFeeRecipient(newFeeRecipient);
          await subjectExtension.connect(methodologist.wallet).updateFeeRecipient(newFeeRecipient);

          const receivedFeeRecipient = (
            await subjectIssuanceModule.issuanceSettings(subjectSetToken)
          ).feeRecipient;

          expect(receivedFeeRecipient).to.equal(newFeeRecipient);
        });
      });

      context("when a single mutual upgrade party has called the method", async () => {
        afterEach(async () => await subject(methodologist));

        it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
          const txHash = await subject(operator);

          const expectedHash = solidityKeccak256(
            ["bytes", "address"],
            [txHash.data, operator.address]
          );

          const isLogged = await subjectExtension.mutualUpgrades(expectedHash);

          expect(isLogged).to.be.true;
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        it("should revert", async () => {
          await expect(subject(await getRandomAccount())).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#initializeStreamingFeeModule", () => {
      let subjectSetToken: Address;
      let subjectFeeSettings: any;
      let subjectExtension: FeeSplitExtension;
      let subjectIssuanceModule: DebtIssuanceModule;
      let subjectFeeModule: StreamingFeeModule;
      let subjectManager: Address;
      let subjectOperatorFeeSplit: BigNumber;
      let subjectOperatorFeeRecipient: Address;

      beforeEach( async () => {
        subjectSetToken = setToken.address;
        subjectIssuanceModule = setV2Setup.debtIssuanceModule;
        subjectManager = baseManagerV2.address;
        subjectOperatorFeeSplit = ether(.7);
        subjectOperatorFeeRecipient = operator.address;

        // Deploy new fee module
        subjectFeeModule = await deployer.setV2.deployStreamingFeeModule(setV2Setup.controller.address);
        await setV2Setup.controller.addModule(subjectFeeModule.address);

        // Deploy new fee extension
        subjectExtension = await deployer.extensions.deployFeeSplitExtension(
          subjectManager,
          subjectFeeModule.address,
          subjectIssuanceModule.address,
          subjectOperatorFeeSplit,
          subjectOperatorFeeRecipient,
        );

        // Replace module and extension
        await baseManagerV2.connect(operator.wallet).replaceProtectedModule(
          setV2Setup.streamingFeeModule.address,
          subjectFeeModule.address,
          [subjectExtension.address]
        );

        await baseManagerV2.connect(methodologist.wallet).replaceProtectedModule(
          setV2Setup.streamingFeeModule.address,
          subjectFeeModule.address,
          [subjectExtension.address]
        );

        subjectFeeSettings = {
          feeRecipient: subjectExtension.address,
          maxStreamingFeePercentage: ether(.01),
          streamingFeePercentage: ether(.01),
          lastStreamingFeeTimestamp: ZERO,
        };
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
         return await subjectExtension
           .connect(caller.wallet)
           .initializeStreamingFeeModule(subjectFeeSettings);
      }

      context("when both parties call the method", async () => {
        it("should initialize the streaming fee module", async () => {
          const initialFeeRecipient = (await subjectFeeModule.feeStates(subjectSetToken)).feeRecipient;

          await subject(operator);
          await subject(methodologist);

          const finalFeeRecipient = (await subjectFeeModule.feeStates(subjectSetToken)).feeRecipient;

          expect(initialFeeRecipient).to.equal(ADDRESS_ZERO);
          expect(finalFeeRecipient).to.equal(subjectExtension.address);
        });

        it("should enable calls on the protected module", async () => {
          const newFeeRecipient = baseManagerV2.address;

          await subject(operator);
          await subject(methodologist);

          // Reset fee recipient
          await subjectExtension.connect(operator.wallet).updateFeeRecipient(newFeeRecipient);
          await subjectExtension.connect(methodologist.wallet).updateFeeRecipient(newFeeRecipient);

          const receivedFeeRecipient = (await subjectFeeModule.feeStates(subjectSetToken)).feeRecipient;

          expect(receivedFeeRecipient).to.equal(newFeeRecipient);
        });
      });

      context("when a single mutual upgrade party has called the method", async () => {
        afterEach(async () => await subject(methodologist));

        it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
          const txHash = await subject(operator);

          const expectedHash = solidityKeccak256(
            ["bytes", "address"],
            [txHash.data, operator.address]
          );

          const isLogged = await subjectExtension.mutualUpgrades(expectedHash);

          expect(isLogged).to.be.true;
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        it("should revert", async () => {
          await expect(subject(await getRandomAccount())).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#updateStreamingFee", async () => {
      let mintedTokens: BigNumber;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      let subjectNewFee: BigNumber;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFee = ether(.01);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateStreamingFee(subjectNewFee);
      }

      context("when no timelock period has been set", async () => {

        context("when a single mutual upgrade party has called the method", () => {
          it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
            const txHash = await subject(subjectOperatorCaller);

            const expectedHash = solidityKeccak256(
              ["bytes", "address"],
              [txHash.data, subjectOperatorCaller.address]
            );

            const isLogged = await feeExtension.mutualUpgrades(expectedHash);

            expect(isLogged).to.be.true;
          });
        });

        context("when both upgrade parties have called the method", () => {
          it("should update the streaming fee", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
            expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
          });

          it("should send correct amount of fees to the fee extension", async () => {
            const preExtensionBalance = await setToken.balanceOf(feeExtension.address);
            const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
            const totalSupply = await setToken.totalSupply();

            await subject(subjectOperatorCaller);
            const txnTimestamp = await getTransactionTimestamp(subject(subjectMethodologistCaller));

            const expectedFeeInflation = await getStreamingFee(
              setV2Setup.streamingFeeModule,
              setToken.address,
              feeState.lastStreamingFeeTimestamp,
              txnTimestamp,
              ether(.02)
            );

            const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

            const postExtensionBalance = await setToken.balanceOf(feeExtension.address);

            expect(postExtensionBalance.sub(preExtensionBalance)).to.eq(feeInflation);
          });
        });
      });

      context("when 1 day timelock period has been set", async () => {
        beforeEach(async () => {
          await feeExtension.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
        });

        it("sets the upgradeHash", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);
          const timestamp = await getLastBlockTimestamp();
          const calldata = feeExtension.interface.encodeFunctionData("updateStreamingFee", [subjectNewFee]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await feeExtension.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(timestamp);
        });

        context("when 1 day timelock has elapsed", async () => {
          beforeEach(async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
          });

          it("should update the streaming fee", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);

            expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
          });

          it("should send correct amount of fees to the fee extension", async () => {
            const preExtensionBalance = await setToken.balanceOf(feeExtension.address);
            const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
            const totalSupply = await setToken.totalSupply();

            await subject(subjectOperatorCaller);
            const txnTimestamp = await getTransactionTimestamp(subject(subjectMethodologistCaller));

            const expectedFeeInflation = await getStreamingFee(
              setV2Setup.streamingFeeModule,
              setToken.address,
              feeState.lastStreamingFeeTimestamp,
              txnTimestamp,
              ether(.02)
            );

            const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

            const postExtensionBalance = await setToken.balanceOf(feeExtension.address);

            expect(postExtensionBalance.sub(preExtensionBalance)).to.eq(feeInflation);
          });
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#updateIssueFee", async () => {
      let subjectNewFee: BigNumber;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        subjectNewFee = ether(.02);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateIssueFee(subjectNewFee);
      }

      context("when no timelock period has been set", async () => {
        context("when a single mutual upgrade party has called the method", () => {
          it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
            const txHash = await subject(subjectOperatorCaller);

            const expectedHash = solidityKeccak256(
              ["bytes", "address"],
              [txHash.data, subjectOperatorCaller.address]
            );

            const isLogged = await feeExtension.mutualUpgrades(expectedHash);

            expect(isLogged).to.be.true;
          });
        });

        context("when both upgrade parties have called the method", () => {
          it("should update the issue fee", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const issueState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

            expect(issueState.managerIssueFee).to.eq(subjectNewFee);
          });
        });
      });

      context("when 1 day timelock period has been set", async () => {
        beforeEach(async () => {
          await feeExtension.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
        });

        it("sets the upgradeHash", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const timestamp = await getLastBlockTimestamp();
          const calldata = feeExtension.interface.encodeFunctionData("updateIssueFee", [subjectNewFee]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await feeExtension.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(timestamp);
        });

        context("when 1 day timelock has elapsed", async () => {
          beforeEach(async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
          });

          it("sets the new issue fee", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const issueState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);
            expect(issueState.managerIssueFee).to.eq(subjectNewFee);
          });

          it("sets the upgradeHash to 0", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const calldata = feeExtension.interface.encodeFunctionData("updateIssueFee", [subjectNewFee]);
            const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
            const actualTimestamp = await feeExtension.timeLockedUpgrades(upgradeHash);
            expect(actualTimestamp).to.eq(ZERO);
          });
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#updateRedeemFee", async () => {
      let subjectNewFee: BigNumber;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        subjectNewFee = ether(.02);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateRedeemFee(subjectNewFee);
      }

      context("when no timelock period has been set", () => {
        context("when a single mutual upgrade party has called the method", () => {
          it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
            const txHash = await subject(subjectOperatorCaller);

            const expectedHash = solidityKeccak256(
              ["bytes", "address"],
              [txHash.data, subjectOperatorCaller.address]
            );

            const isLogged = await feeExtension.mutualUpgrades(expectedHash);

            expect(isLogged).to.be.true;
          });
        });

        context("when both upgrade parties have called the method", () => {
          it("should update the redeem fee", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const issuanceState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

            expect(issuanceState.managerRedeemFee).to.eq(subjectNewFee);
          });
        });
      });

      context("when 1 day timelock period has been set", async () => {
        beforeEach(async () => {
          await feeExtension.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
        });

        it("sets the upgradeHash", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const timestamp = await getLastBlockTimestamp();
          const calldata = feeExtension.interface.encodeFunctionData("updateRedeemFee", [subjectNewFee]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await feeExtension.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(timestamp);
        });

        context("when 1 day timelock has elapsed", async () => {
          beforeEach(async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
          });

          it("sets the new redeem fee", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const issuanceState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);
            expect(issuanceState.managerRedeemFee).to.eq(subjectNewFee);
          });

          it("sets the upgradeHash to 0", async () => {
            await subject(subjectOperatorCaller);
            await subject(subjectMethodologistCaller);

            const calldata = feeExtension.interface.encodeFunctionData("updateRedeemFee", [subjectNewFee]);
            const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
            const actualTimestamp = await feeExtension.timeLockedUpgrades(upgradeHash);
            expect(actualTimestamp).to.eq(ZERO);
          });
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#updateFeeRecipient", async () => {
      let subjectNewFeeRecipient: Address;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        subjectNewFeeRecipient = owner.address;
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateFeeRecipient(subjectNewFeeRecipient);
      }

      context("when a single mutual upgrade party has called the method", () => {
        it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
          const txHash = await subject(subjectOperatorCaller);

          const expectedHash = solidityKeccak256(
            ["bytes", "address"],
            [txHash.data, subjectOperatorCaller.address]
          );

          const isLogged = await feeExtension.mutualUpgrades(expectedHash);

          expect(isLogged).to.be.true;
        });
      });

      context("when operator and methodologist both execute update", () => {
        it("sets the new fee recipients", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const streamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
          const issuanceFeeState = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

          expect(streamingFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
          expect(issuanceFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#updateFeeSplit", async () => {
      let subjectNewFeeSplit: BigNumber;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      const mintedTokens: BigNumber = ether(2);
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFeeSplit = ether(.5);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateFeeSplit(subjectNewFeeSplit);
      }

      context("when operator and methodologist both execute update", () => {
        it("should accrue fees and send correct amount to operator fee recipient and methodologist", async () => {
          const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
          const totalSupply = await setToken.totalSupply();

          await subject(subjectOperatorCaller);
          const txnTimestamp = await getTransactionTimestamp(await subject(subjectMethodologistCaller));

          const expectedFeeInflation = await getStreamingFee(
            setV2Setup.streamingFeeModule,
            setToken.address,
            feeState.lastStreamingFeeTimestamp,
            txnTimestamp
          );

          const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

          const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
          const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
          const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

          const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
          const methodologistBalance = await setToken.balanceOf(methodologist.address);

          expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
          expect(methodologistBalance).to.eq(expectedMethodologistTake);
        });

        it("sets the new fee split", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const actualFeeSplit = await feeExtension.operatorFeeSplit();

          expect(actualFeeSplit).to.eq(subjectNewFeeSplit);
        });

        describe("when fee splits is >100%", async () => {
          beforeEach(async () => {
            subjectNewFeeSplit = ether(1.1);
          });

          it("should revert", async () => {
            await subject(subjectOperatorCaller);
            await expect(subject(subjectMethodologistCaller)).to.be.revertedWith("Fee must be less than 100%");
          });
        });
      });

      context("when a single mutual upgrade party has called the method", async () => {
        afterEach(async () => await subject(subjectMethodologistCaller));

        it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
          const txHash = await subject(subjectOperatorCaller);

          const expectedHash = solidityKeccak256(
            ["bytes", "address"],
            [txHash.data, subjectOperatorCaller.address]
          );

          const isLogged = await feeExtension.mutualUpgrades(expectedHash);

          expect(isLogged).to.be.true;
        });
      });

      describe("when the caller is not the operator or methodologist", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Must be authorized address");
        });
      });
    });

    describe("#updateOperatorFeeRecipient", async () => {
      let subjectCaller: Account;
      let subjectOperatorFeeRecipient: Address;

      beforeEach(async () => {
        subjectCaller = operator;
        subjectOperatorFeeRecipient = (await getRandomAccount()).address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension
          .connect(subjectCaller.wallet)
          .updateOperatorFeeRecipient(subjectOperatorFeeRecipient);
      }

      it("sets the new operator fee recipient", async () => {
        await subject();

        const newOperatorFeeRecipient = await feeExtension.operatorFeeRecipient();
        expect(newOperatorFeeRecipient).to.eq(subjectOperatorFeeRecipient);
      });

      describe("when the new operator fee recipient is address zero", async () => {
        beforeEach(async () => {
          subjectOperatorFeeRecipient = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Zero address not valid");
        });
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = methodologist;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});