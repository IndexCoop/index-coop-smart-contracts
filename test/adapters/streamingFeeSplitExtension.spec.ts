import "module-alias/register";

import { solidityKeccak256 } from "ethers/lib/utils";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE_DAY_IN_SECONDS, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { StreamingFeeSplitExtension, BaseManager } from "@utils/contracts/index";
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

describe("StreamingFeeSplitExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManager;
  let feeExtension: StreamingFeeSplitExtension;

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
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
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

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectStreamingFeeModule: Address;
    let subjectOperatorFeeSplit: BigNumber;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
      subjectOperatorFeeSplit = ether(.7);
    });

    async function subject(): Promise<StreamingFeeSplitExtension> {
      return await deployer.adapters.deployStreamingFeeSplitExtension(
        subjectManager,
        subjectStreamingFeeModule,
        subjectOperatorFeeSplit
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

    it("should set the correct operator fee split", async () => {
      const feeExtension = await subject();

      const actualOperatorFeeSplit = await feeExtension.operatorFeeSplit();
      expect(actualOperatorFeeSplit).to.eq(subjectOperatorFeeSplit);
    });
  });

  context("when fee extension is deployed and system fully set up", async () => {
    const operatorSplit: BigNumber = ether(.7);

    beforeEach(async () => {
      feeExtension = await deployer.adapters.deployStreamingFeeSplitExtension(
        baseManagerV2.address,
        setV2Setup.streamingFeeModule.address,
        operatorSplit
      );

      await baseManagerV2.connect(operator.wallet).addAdapter(feeExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
    });

    describe("#accrueFeesAndDistribute", async () => {
      let mintedTokens: BigNumber;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
        await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.accrueFeesAndDistribute();
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

        const expectedOperatorTake = preciseMul(feeInflation, operatorSplit);
        const expectedMethodologistTake = feeInflation.sub(expectedOperatorTake);

        const operatorBalance = await setToken.balanceOf(operator.address);
        const methodologistBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorBalance).to.eq(expectedOperatorTake);
        expect(methodologistBalance).to.eq(expectedMethodologistTake);
      });

      it("should emit a FeesAccrued event", async () => {
        await expect(subject()).to.emit(feeExtension, "FeesAccrued");
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
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
        await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFee = ether(.01);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateStreamingFee(subjectNewFee);
      }

      context("when no timelock period has been set", async () => {

        context("when only one mutual upgrade party has called the method", () => {
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

          it("should send correct amount of fees to operator and methodologist", async () => {
            const preManagerBalance = await setToken.balanceOf(baseManagerV2.address);
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

            const postManagerBalance = await setToken.balanceOf(baseManagerV2.address);

            expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
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

          it("should send correct amount of fees to operator and methodologist", async () => {
            const preManagerBalance = await setToken.balanceOf(baseManagerV2.address);
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

            const postManagerBalance = await setToken.balanceOf(baseManagerV2.address);

            expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
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

      it("sets the new fee recipient", async () => {
        await subject(subjectOperatorCaller);
        await subject(subjectMethodologistCaller);

        const streamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);

        expect(streamingFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
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

    describe("#updateFeeSplit", async () => {
      let subjectNewFeeSplit: BigNumber;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      const mintedTokens: BigNumber = ether(2);
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
        await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        subjectNewFeeSplit = ether(.5);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateFeeSplit(subjectNewFeeSplit);
      }

      it("should accrue fees and send correct amount to operator and methodologist", async () => {
        const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const totalSupply = await setToken.totalSupply();

        await subject(subjectOperatorCaller);
        const txnTimestamp = await getTransactionTimestamp(subject(subjectMethodologistCaller));

        const expectedFeeInflation = await getStreamingFee(
          setV2Setup.streamingFeeModule,
          setToken.address,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );

        const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

        const expectedOperatorTake = preciseMul(feeInflation, operatorSplit);
        const expectedMethodologistTake = feeInflation.sub(expectedOperatorTake);

        const operatorBalance = await setToken.balanceOf(operator.address);
        const methodologistBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorBalance).to.eq(expectedOperatorTake);
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

      context("when a single mutual upgrade party has called the method", async () => {
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
  });
});