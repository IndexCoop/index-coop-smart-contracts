import "module-alias/register";

import { solidityKeccak256 } from "ethers/lib/utils";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { FeeSplitAdapter, BaseManager } from "@utils/contracts/index";
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
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("FeeSplitAdapter", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManager;
  let feeAdapter: FeeSplitAdapter;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
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
    baseManagerV2 = await deployer.manager.deployBaseManager(
      setToken.address,
      operator.address,
      methodologist.address
    );

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

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
      subjectDebtIssuanceModule = setV2Setup.debtIssuanceModule.address;
      subjectOperatorFeeSplit = ether(.7);
    });

    async function subject(): Promise<FeeSplitAdapter> {
      return await deployer.adapters.deployFeeSplitAdapter(
        subjectManager,
        subjectStreamingFeeModule,
        subjectDebtIssuanceModule,
        subjectOperatorFeeSplit
      );
    }

    it("should set the correct SetToken address", async () => {
      const feeAdapter = await subject();

      const actualToken = await feeAdapter.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const feeAdapter = await subject();

      const actualManager = await feeAdapter.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct streaming fee module address", async () => {
      const feeAdapter = await subject();

      const actualStreamingFeeModule = await feeAdapter.streamingFeeModule();
      expect(actualStreamingFeeModule).to.eq(subjectStreamingFeeModule);
    });

    it("should set the correct debt issuance module address", async () => {
      const feeAdapter = await subject();

      const actualDebtIssuanceModule = await feeAdapter.issuanceModule();
      expect(actualDebtIssuanceModule).to.eq(subjectDebtIssuanceModule);
    });

    it("should set the correct operator fee split", async () => {
      const feeAdapter = await subject();

      const actualOperatorFeeSplit = await feeAdapter.operatorFeeSplit();
      expect(actualOperatorFeeSplit).to.eq(subjectOperatorFeeSplit);
    });
  });

  context("when fee adapter is deployed and system fully set up", async () => {
    const operatorSplit: BigNumber = ether(.7);

    beforeEach(async () => {
      feeAdapter = await deployer.adapters.deployFeeSplitAdapter(
        baseManagerV2.address,
        setV2Setup.streamingFeeModule.address,
        setV2Setup.debtIssuanceModule.address,
        operatorSplit
      );

      await baseManagerV2.connect(operator.wallet).addAdapter(feeAdapter.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
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
        return await feeAdapter.accrueFeesAndDistribute();
      }

      it("should send correct amount of fees to operator and methodologist", async () => {
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

        const operatorBalance = await setToken.balanceOf(operator.address);
        const methodologistBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorBalance).to.eq(expectedOperatorTake);
        expect(methodologistBalance).to.eq(expectedMethodologistTake);
      });

      it("should emit a FeesAccrued event", async () => {
        await expect(subject()).to.emit(feeAdapter, "FeesAccrued");
      });

      describe("when methodologist fees are 0", async () => {
        beforeEach(async () => {
          await feeAdapter.connect(operator.wallet).updateFeeSplit(ether(1));
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
          await feeAdapter.connect(operator.wallet).updateFeeSplit(ZERO);
        });

        it("should not send fees to operator", async () => {
          const preOperatorBalance = await setToken.balanceOf(operator.address);

          await subject();

          const postOperatorBalance = await setToken.balanceOf(operator.address);
          expect(postOperatorBalance.sub(preOperatorBalance)).to.eq(ZERO);
        });
      });
    });

    describe("#updateStreamingFee", async () => {
      let mintedTokens: BigNumber;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      let subjectNewFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFee = ether(.01);
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeAdapter.connect(subjectCaller.wallet).updateStreamingFee(subjectNewFee);
      }
      context("when no timelock period has been set", async () => {
        it("should update the streaming fee", async () => {
          await subject();

          const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);

          expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
        });

        it("should send correct amount of fees to operator and methodologist", async () => {
          const preManagerBalance = await setToken.balanceOf(baseManagerV2.address);
          const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
          const totalSupply = await setToken.totalSupply();

          const txnTimestamp = await getTransactionTimestamp(subject());

          const expectedFeeInflation = await getStreamingFee(
            setV2Setup.streamingFeeModule,
            setToken.address,
            feeState.lastStreamingFeeTimestamp,
            txnTimestamp,
            ether(.02)
          );

          const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

          const postManagerBalance = await setToken.balanceOf(baseManagerV2.address);

          expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
        });
      });

      context("when 1 day timelock period has been set", async () => {
        beforeEach(async () => {
          await feeAdapter.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
        });

        it("sets the upgradeHash", async () => {
          await subject();
          const timestamp = await getLastBlockTimestamp();
          const calldata = feeAdapter.interface.encodeFunctionData("updateStreamingFee", [subjectNewFee]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await feeAdapter.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(timestamp);
        });

        context("when 1 day timelock has elapsed", async () => {
          beforeEach(async () => {
            await subject();
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
          });

          it("should update the streaming fee", async () => {
            await subject();

            const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);

            expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
          });

          it("should send correct amount of fees to operator and methodologist", async () => {
            const preManagerBalance = await setToken.balanceOf(baseManagerV2.address);
            const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
            const totalSupply = await setToken.totalSupply();

            const txnTimestamp = await getTransactionTimestamp(subject());

            const expectedFeeInflation = await getStreamingFee(
              setV2Setup.streamingFeeModule,
              setToken.address,
              feeState.lastStreamingFeeTimestamp,
              txnTimestamp,
              ether(.02)
            );

            const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

            const postManagerBalance = await setToken.balanceOf(baseManagerV2.address);

            expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
          });
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

    describe("#updateIssueFee", async () => {
      let subjectNewFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectNewFee = ether(.02);
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeAdapter.connect(subjectCaller.wallet).updateIssueFee(subjectNewFee);
      }

      context("when no timelock period has been set", async () => {
        it("should update the issue fee", async () => {
          await subject();

          const issueState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

          expect(issueState.managerIssueFee).to.eq(subjectNewFee);
        });
      });

      context("when 1 day timelock period has been set", async () => {
        beforeEach(async () => {
          await feeAdapter.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
        });

        it("sets the upgradeHash", async () => {
          await subject();
          const timestamp = await getLastBlockTimestamp();
          const calldata = feeAdapter.interface.encodeFunctionData("updateIssueFee", [subjectNewFee]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await feeAdapter.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(timestamp);
        });

        context("when 1 day timelock has elapsed", async () => {
          beforeEach(async () => {
            await subject();
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
          });

          it("sets the new streaming fee", async () => {
            await subject();
            const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
            const newStreamingFee = feeStates.streamingFeePercentage;

            expect(newStreamingFee).to.eq(subjectNewFee);
          });

          it("sets the upgradeHash to 0", async () => {
            await subject();
            const calldata = feeAdapter.interface.encodeFunctionData("updateIssueFee", [subjectNewFee]);
            const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
            const actualTimestamp = await feeAdapter.timeLockedUpgrades(upgradeHash);
            expect(actualTimestamp).to.eq(ZERO);
          });
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

    describe("#updateRedeemFee", async () => {
      let subjectNewFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectNewFee = ether(.02);
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeAdapter.connect(subjectCaller.wallet).updateRedeemFee(subjectNewFee);
      }

      context("when no timelock period has been set", async () => {
        it("should update the redeem fee", async () => {
          await subject();

          const issuanceState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

          expect(issuanceState.managerRedeemFee).to.eq(subjectNewFee);
        });
      });

      context("when 1 day timelock period has been set", async () => {
        beforeEach(async () => {
          await feeAdapter.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
        });

        it("sets the upgradeHash", async () => {
          await subject();
          const timestamp = await getLastBlockTimestamp();
          const calldata = feeAdapter.interface.encodeFunctionData("updateRedeemFee", [subjectNewFee]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await feeAdapter.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(timestamp);
        });

        context("when 1 day timelock has elapsed", async () => {
          beforeEach(async () => {
            await subject();
            await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
          });

          it("sets the new streaming fee", async () => {
            await subject();
            const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
            const newStreamingFee = feeStates.streamingFeePercentage;

            expect(newStreamingFee).to.eq(subjectNewFee);
          });

          it("sets the upgradeHash to 0", async () => {
            await subject();
            const calldata = feeAdapter.interface.encodeFunctionData("updateRedeemFee", [subjectNewFee]);
            const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
            const actualTimestamp = await feeAdapter.timeLockedUpgrades(upgradeHash);
            expect(actualTimestamp).to.eq(ZERO);
          });
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

    describe("#updateFeeRecipient", async () => {
      let subjectNewFeeRecipient: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectNewFeeRecipient = owner.address;
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeAdapter.connect(subjectCaller.wallet).updateFeeRecipient(subjectNewFeeRecipient);
      }

      it("sets the new fee recipients", async () => {
        await subject();

        const streamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const issuanceFeeState = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

        expect(streamingFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
        expect(issuanceFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
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

    describe("#updateFeeSplit", async () => {
      let subjectNewFeeSplit: BigNumber;
      let subjectCaller: Account;

      const mintedTokens: BigNumber = ether(2);
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFeeSplit = ether(.5);
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeAdapter.connect(subjectCaller.wallet).updateFeeSplit(subjectNewFeeSplit);
      }

      it("should accrue fees and send correct amount to operator and methodologist", async () => {
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

        const operatorBalance = await setToken.balanceOf(operator.address);
        const methodologistBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorBalance).to.eq(expectedOperatorTake);
        expect(methodologistBalance).to.eq(expectedMethodologistTake);
      });

      it("sets the new fee split", async () => {
        await subject();

        const actualFeeSplit = await feeAdapter.operatorFeeSplit();

        expect(actualFeeSplit).to.eq(subjectNewFeeSplit);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});