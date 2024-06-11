import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { Prt, PrtFeeSplitExtension, BaseManagerV2, PrtStakingPool } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
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

describe.only("PrtFeeSplitExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let operatorFeeRecipient: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let prt: Prt;

  let baseManagerV2: BaseManagerV2;
  let feeExtension: PrtFeeSplitExtension;

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

    // Deploy Prt
    prt = await deployer.token.deployPrt(
      "PRT",
      "PRT",
      setToken.address,
      owner.address,
      ether(100_000)
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectStreamingFeeModule: Address;
    let subjectDebtIssuanceModule: Address;
    let subjectOperatorFeeSplit: BigNumber;
    let subjectOperatorFeeRecipient: Address;
    let subjectPrt: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
      subjectDebtIssuanceModule = setV2Setup.debtIssuanceModule.address;
      subjectOperatorFeeSplit = ether(.7);
      subjectOperatorFeeRecipient = operatorFeeRecipient.address;
      subjectPrt = prt.address;
    });

    async function subject(): Promise<PrtFeeSplitExtension> {
      return await deployer.extensions.deployPrtFeeSplitExtension(
        subjectManager,
        subjectStreamingFeeModule,
        subjectDebtIssuanceModule,
        subjectOperatorFeeSplit,
        subjectOperatorFeeRecipient,
        subjectPrt,
      );
    }

    it("should set the correct PRT address", async () => {
      const feeExtension = await subject();

      const actualPrt = await feeExtension.prt();
      expect(actualPrt).to.eq(prt.address);
    });
  });

  context("when fee extension is deployed and system fully set up", async () => {
    let prtStakingPool: PrtStakingPool;
    const operatorSplit: BigNumber = ether(.7);

    beforeEach(async () => {
      feeExtension = await deployer.extensions.deployPrtFeeSplitExtension(
        baseManagerV2.address,
        setV2Setup.streamingFeeModule.address,
        setV2Setup.debtIssuanceModule.address,
        operatorSplit,
        operatorFeeRecipient.address,
        prt.address
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

      // Deploy PrtStakingPool
      prtStakingPool = await deployer.staking.deployPrtStakingPool(
        "PRT Staking Pool",
        "sPRT",
        prt.address,
        feeExtension.address,
      );

      // Stake PRT in PRT Staking Pool
      await prt.connect(owner.wallet).approve(prtStakingPool.address, ether(1));
      await prtStakingPool.connect(owner.wallet).stake(ether(1));
    });

    describe("#updatePrtStakingPool", async () => {
      let subjectCaller: Account;
      let subjectNewPrtStakingPool: Address;

      beforeEach(async () => {
        subjectCaller = operator;
        subjectNewPrtStakingPool = prtStakingPool.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension
          .connect(subjectCaller.wallet)
          .updatePrtStakingPool(subjectNewPrtStakingPool);
      }

      it("sets the new PRT Staking Pool", async () => {
        await subject();

        const newPrtStakingPool = await feeExtension.prtStakingPool();
        expect(newPrtStakingPool).to.eq(subjectNewPrtStakingPool);
      });

      describe("when the new PRT Staking Pool is address zero", async () => {
        beforeEach(async () => {
          subjectNewPrtStakingPool = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Zero address not valid");
        });
      });

      describe("when there is a FeeExtension mismatch", async () => {
        beforeEach(async () => {
          const wrongPrtPool = await deployer.staking.deployPrtStakingPool(
            "PRT Staking Pool",
            "sPRT",
            prt.address,
            ADDRESS_ZERO, // Use zero address instead of FeeExtension
          );
          subjectNewPrtStakingPool = wrongPrtPool.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("PrtFeeSplitExtension must be set");
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

    describe("#accrueFeesAndDistribute", async () => {
      let mintedTokens: BigNumber;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      let subjectCaller: Account;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);

        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectCaller.wallet).accrueFeesAndDistribute();
      }

      it("should send correct amount of fees to operator fee recipient and PRT Staking Pool", async () => {
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
        const expectedPrtStakingPoolTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

        const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
        const prtStakingPoolBalance = await setToken.balanceOf(prtStakingPool.address);

        expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
        expect(prtStakingPoolBalance).to.eq(expectedPrtStakingPoolTake);
      });

      it("should emit a PrtFeesDistributed event", async () => {
        await expect(subject()).to.emit(feeExtension, "PrtFeesDistributed");
      });

      it("should snapshot the PRT Staking Pool correctly", async () => {
        const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const totalSupply = await setToken.totalSupply();

        const prtStakingPoolPreSnapshot = await prtStakingPool.getCurrentId();
        const prtStakingPoolPreSnapshotBalance = await setToken.balanceOf(prtStakingPool.address);

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
        const expectedPrtStakingPoolTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

        const prtStakingPoolPostSnapshot = await prtStakingPool.getCurrentId();
        const prtStakingPoolPostSnapshotBalance = await setToken.balanceOf(prtStakingPool.address);

        const storedPrtStakingPoolTake = await prtStakingPool.accrueSnapshots(prtStakingPoolPostSnapshot.sub(1));

        expect(prtStakingPoolPreSnapshot).to.eq(prtStakingPoolPostSnapshot.sub(1));
        expect(prtStakingPoolPreSnapshotBalance).to.eq(prtStakingPoolPostSnapshotBalance.sub(expectedPrtStakingPoolTake));
        expect(storedPrtStakingPoolTake).to.eq(expectedPrtStakingPoolTake);
      });

      describe("when PRT Staking Pool fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updateFeeSplit(ether(1));
        });

        it("should not send fees to the PRT Staking Pool", async () => {
          const preMethodologistBalance = await setToken.balanceOf(methodologist.address);

          await subject();

          const postMethodologistBalance = await setToken.balanceOf(methodologist.address);
          expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
        });

        it("should create a snapshot on the PRT Staking Pool", async () => {
          const preSnapshotId = await prtStakingPool.getCurrentId();

          await subject();

          const postSnapshotId = await prtStakingPool.getCurrentId();
          expect(postSnapshotId).to.eq(preSnapshotId);
        });
      });

      describe("when operator fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updateFeeSplit(ZERO);
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

        it("should send residual fees to operator fee recipient and PRT Staking Pool", async () => {
          await subject();

          const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

          const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
          const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
          const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

          const operatorFeeRecipientBalance = await setToken.balanceOf(operatorFeeRecipient.address);
          const prtStakingPoolBalance = await setToken.balanceOf(prtStakingPool.address);

          expect(operatorFeeRecipientBalance).to.eq(expectedOperatorTake);
          expect(prtStakingPoolBalance).to.eq(expectedMethodologistTake);
        });
      });
    });

    describe("#updateFeeSplit", async () => {
      let subjectNewFeeSplit: BigNumber;
      let subjectOperatorCaller: Account;

      const mintedTokens: BigNumber = ether(2);
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      beforeEach(async () => {
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);

        subjectNewFeeSplit = ether(.5);
        subjectOperatorCaller = operator;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateFeeSplit(subjectNewFeeSplit);
      }

      it("should not accrue fees", async () => {
        const operatorFeeRecipientBalanceBefore = await setToken.balanceOf(operatorFeeRecipient.address);
        const prtStakingPoolBalanceBefore = await setToken.balanceOf(prtStakingPool.address);
        await subject(subjectOperatorCaller);

        const operatorFeeRecipientBalanceAfter = await setToken.balanceOf(operatorFeeRecipient.address);
        const prtStakingPoolBalanceAfter = await setToken.balanceOf(prtStakingPool.address);

        expect(operatorFeeRecipientBalanceAfter).to.eq(operatorFeeRecipientBalanceBefore);
        expect(prtStakingPoolBalanceAfter).to.eq(prtStakingPoolBalanceBefore);
      });

      it("sets the new fee split", async () => {
        await subject(subjectOperatorCaller);

        const actualFeeSplit = await feeExtension.operatorFeeSplit();

        expect(actualFeeSplit).to.eq(subjectNewFeeSplit);
      });

      describe("when fee splits is >100%", async () => {
        beforeEach(async () => {
          subjectNewFeeSplit = ether(1.1);
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Fee must be less than 100%");
        });
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectOperatorCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject(subjectOperatorCaller)).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});
