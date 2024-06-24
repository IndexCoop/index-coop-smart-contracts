import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { Prt, PrtFeeSplitExtension, BaseManagerV2, PrtStakingPoolMock } from "@utils/contracts/index";
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
  getRandomAccount,
  getRandomAddress
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { solidityKeccak256 } from "ethers/lib/utils";

const expect = getWaffleExpect();

describe("PrtFeeSplitExtension", () => {
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
    let prtStakingPool: PrtStakingPoolMock;
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
      prtStakingPool = await deployer.mocks.deployPrtStakingPoolMock(
        setToken.address,
        prt.address,
        feeExtension.address,
      );
    });

    describe("#updatePrtStakingPool", async () => {
      let subjectNewPrtStakingPool: Address;
      let subjectOperatorCaller: Account;
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        subjectNewPrtStakingPool = prtStakingPool.address;
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension
          .connect(caller.wallet)
          .updatePrtStakingPool(subjectNewPrtStakingPool);
      }

      context("when operator and methodologist both execute update", () => {
        it("sets the new PRT Staking Pool", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const newPrtStakingPool = await feeExtension.prtStakingPool();
          expect(newPrtStakingPool).to.eq(subjectNewPrtStakingPool);
        });

        it("should emit a PrtStakingPoolUpdated event", async () => {
          await subject(subjectOperatorCaller);
          await expect(subject(subjectMethodologistCaller)).to.emit(feeExtension, "PrtStakingPoolUpdated").withArgs(subjectNewPrtStakingPool);
        });

        describe("when the new PRT Staking Pool is address zero", async () => {
          beforeEach(async () => {
            subjectNewPrtStakingPool = ADDRESS_ZERO;
          });

          it("should revert", async () => {
            await subject(subjectOperatorCaller);
            await expect(subject(subjectMethodologistCaller)).to.be.revertedWith("Zero address not valid");
          });
        });

        describe("when there is a FeeExtension mismatch", async () => {
          beforeEach(async () => {
            const wrongPrtPool = await deployer.mocks.deployPrtStakingPoolMock(
              setToken.address,
              prt.address,
              ADDRESS_ZERO, // Use zero address instead of FeeExtension
            );
            subjectNewPrtStakingPool = wrongPrtPool.address;
          });

          it("should revert", async () => {
            await subject(subjectOperatorCaller);
            await expect(subject(subjectMethodologistCaller)).to.be.revertedWith("PRT Staking Pool distributor must be this extension");
          });
        });

        describe("when there is a stakeToken mismatch", async () => {
          beforeEach(async () => {
            const wrongPrtPool = await deployer.mocks.deployPrtStakingPoolMock(
              setToken.address,
              ADDRESS_ZERO, // Use zero address instead of PRT
              feeExtension.address,
            );
            subjectNewPrtStakingPool = wrongPrtPool.address;
          });

          it("should revert", async () => {
            await subject(subjectOperatorCaller);
            await expect(subject(subjectMethodologistCaller)).to.be.revertedWith("PRT Staking Pool stake token must be PRT");
          });
        });

        describe("when there is a rewardToken mismatch", async () => {
          beforeEach(async () => {
            const wrongPrtPool = await deployer.mocks.deployPrtStakingPoolMock(
              ADDRESS_ZERO, // Use zero address instead of SetToken
              prt.address,
              feeExtension.address,
            );
            subjectNewPrtStakingPool = wrongPrtPool.address;
          });

          it("should revert", async () => {
            await subject(subjectOperatorCaller);
            await expect(subject(subjectMethodologistCaller)).to.be.revertedWith("PRT Staking Pool reward token must be SetToken");
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

    describe("#accrueFeesAndDistribute", async () => {
      let mintedTokens: BigNumber;
      const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

      let subjectCaller: Account;

      beforeEach(async () => {
        mintedTokens = ether(2);
        await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

        await increaseTimeAsync(timeFastForward);

        await feeExtension.connect(operator.wallet).updateAnyoneAccrue(true);

        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectCaller.wallet).accrueFeesAndDistribute();
      }

      it("should send correct amount of fees to operator fee recipient and PRT Staking Pool", async () => {
        await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);
        await feeExtension.connect(methodologist.wallet).updatePrtStakingPool(prtStakingPool.address);

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
        await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);
        await feeExtension.connect(methodologist.wallet).updatePrtStakingPool(prtStakingPool.address);
        await expect(subject()).to.emit(feeExtension, "PrtFeesDistributed");
      });

      describe("when PRT Staking Pool fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);
          await feeExtension.connect(methodologist.wallet).updatePrtStakingPool(prtStakingPool.address);
          await feeExtension.connect(operator.wallet).updateFeeSplit(ether(1));
          await feeExtension.connect(methodologist.wallet).updateFeeSplit(ether(1));
        });

        it("should not send fees to the PRT Staking Pool", async () => {
          const preStakingPoolBalance = await setToken.balanceOf(prtStakingPool.address);

          await subject();

          const postStakingPoolBalance = await setToken.balanceOf(prtStakingPool.address);
          expect(postStakingPoolBalance.sub(preStakingPoolBalance)).to.eq(ZERO);
        });
      });

      describe("when operator fees are 0", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);
          await feeExtension.connect(methodologist.wallet).updatePrtStakingPool(prtStakingPool.address);
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

      describe("when the PRT Staking Pool is not set", async () => {
        it("should not revert", async () => {
          await expect(subject()).to.be.revertedWith("PRT Staking Pool not set");
        });
      });

      describe("when extension has fees accrued, is removed and no longer the feeRecipient", () => {
        let txnTimestamp: BigNumber;
        let feeState: any;
        let expectedFeeInflation: BigNumber;
        let totalSupply: BigNumber;

        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).updatePrtStakingPool(prtStakingPool.address);
          await feeExtension.connect(methodologist.wallet).updatePrtStakingPool(prtStakingPool.address);

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
      let subjectMethodologistCaller: Account;

      beforeEach(async () => {
        subjectNewFeeSplit = ether(.5);
        subjectOperatorCaller = operator;
        subjectMethodologistCaller = methodologist;
      });

      async function subject(caller: Account): Promise<ContractTransaction> {
        return await feeExtension.connect(caller.wallet).updateFeeSplit(subjectNewFeeSplit);
      }

      context("when operator and methodologist both execute update", () => {
        it("should not accrue fees", async () => {
          const operatorFeeRecipientBalanceBefore = await setToken.balanceOf(operatorFeeRecipient.address);
          const prtStakingPoolBalanceBefore = await setToken.balanceOf(prtStakingPool.address);

          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const operatorFeeRecipientBalanceAfter = await setToken.balanceOf(operatorFeeRecipient.address);
          const prtStakingPoolBalanceAfter = await setToken.balanceOf(prtStakingPool.address);

          expect(operatorFeeRecipientBalanceAfter).to.eq(operatorFeeRecipientBalanceBefore);
          expect(prtStakingPoolBalanceAfter).to.eq(prtStakingPoolBalanceBefore);
        });

        it("sets the new fee split", async () => {
          await subject(subjectOperatorCaller);
          await subject(subjectMethodologistCaller);

          const actualFeeSplit = await feeExtension.operatorFeeSplit();

          expect(actualFeeSplit).to.eq(subjectNewFeeSplit);
        });

        it("should emit a OperatorFeeSplitUpdated event", async () => {
          await subject(subjectOperatorCaller);
          await expect(subject(subjectMethodologistCaller)).to.emit(feeExtension, "OperatorFeeSplitUpdated").withArgs(subjectNewFeeSplit);
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

    describe("#isAllowedAccruer", async () => {
      let subjectAccruer: Account;

      beforeEach(async () => {
        await feeExtension.connect(operator.wallet).setAccruersStatus([owner.address], [true]);

        subjectAccruer = owner;
      });

      async function subject(): Promise<Boolean> {
        return await feeExtension.isAllowedAccruer(subjectAccruer.address);
      }

      it("should return true if the address is an allowed accruer", async () => {
        const isAccruer = await subject();

        expect(isAccruer).to.be.true;
      });

      it("should return false if the address is not an allowed accruer", async () => {
        await feeExtension.connect(operator.wallet).setAccruersStatus([owner.address], [false]);

        const isAccruer = await subject();

        expect(isAccruer).to.be.false;
      });
    });

    describe("#getAllowedAccruers", async () => {
      let subjectAccruers: Address[];
      let subjectStatuses: boolean[];

      beforeEach(async () => {
        subjectAccruers = [operator.address, owner.address];
        subjectStatuses = [true, true];

        await feeExtension.connect(operator.wallet).setAccruersStatus(subjectAccruers, subjectStatuses);
      });

      async function subject(): Promise<Address[]> {
        return await feeExtension.getAllowedAccruers();
      }

      it("should return the addresses of the allowed accruers", async () => {
        const allowedAccruers = await subject();

        expect(allowedAccruers).to.deep.equal(subjectAccruers);
      });

      describe("when a accruer is removed", async () => {
        beforeEach(async () => {
          await feeExtension.connect(operator.wallet).setAccruersStatus([operator.address], [false]);
        });

        it("should remove the accruer and maintain the list correctly", async () => {
          const allowedAccruers = await subject();

          expect(allowedAccruers).to.not.deep.equal(subjectAccruers);
          expect(allowedAccruers).to.deep.equal([owner.address]);
        });
      });
    });

    describe("#setAccruersStatus", async () => {
      let subjectAccruers: Address[];
      let subjectStatuses: boolean[];

      let subjectCaller: Account;

      beforeEach(async () => {
        subjectAccruers = [owner.address, await getRandomAddress(), await getRandomAddress()];
        subjectStatuses = [true, true, true];

        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectCaller.wallet).setAccruersStatus(
          subjectAccruers,
          subjectStatuses
        );
      }

      it("should set the accruer status to true for multiple accruers", async () => {
        await subject();

        const isAccruerOne = await feeExtension.isAllowedAccruer(subjectAccruers[0]);
        const isAccruerTwo = await feeExtension.isAllowedAccruer(subjectAccruers[1]);
        const isAccruerThree = await feeExtension.isAllowedAccruer(subjectAccruers[2]);

        expect(isAccruerOne).to.be.true;
        expect(isAccruerTwo).to.be.true;
        expect(isAccruerThree).to.be.true;
      });

      it("should emit an AccruerStatusUpdated event", async () => {
        await expect(subject()).to.emit(feeExtension, "AccruerStatusUpdated").withArgs(
          subjectAccruers[0],
          true
        );
      });

      describe("when de-authorizing an accruer", async () => {
        beforeEach(async () => {
          await subject();
          subjectStatuses = [false, true, true];
        });

        it("should set the accruer status to false for the de-authorized accruer", async () => {
          const initialStatus = await feeExtension.isAllowedAccruer(subjectAccruers[0]);
          expect(initialStatus).to.be.true;

          await subject();

          const finalStatus = await feeExtension.isAllowedAccruer(subjectAccruers[0]);
          expect(finalStatus).to.be.false;
        });

        it("should update the accruersHistory correctly", async () => {
          const initialAccruers = await feeExtension.getAllowedAccruers();
          expect(initialAccruers).to.deep.equal(subjectAccruers);

          await subject();

          const finalAccruers = await feeExtension.getAllowedAccruers();
          const expectedAccruers = subjectAccruers.slice(1);

          expect(expectedAccruers[0]).to.not.equal(expectedAccruers[1]);
          expect(finalAccruers[0]).to.not.equal(finalAccruers[1]);

          expect(finalAccruers.includes(expectedAccruers[0])).to.be.true;
          expect(finalAccruers.includes(expectedAccruers[1])).to.be.true;
        });
      });

      describe("when array lengths don't match", async () => {
        beforeEach(async () => {
          subjectStatuses = [false];
        });

        it("should revert with 'Array length mismatch'", async () => {
          await expect(subject()).to.be.revertedWith("Array length mismatch");
        });
      });

      describe("when accruers are duplicated", async () => {
        beforeEach(async () => {
          subjectAccruers = [owner.address, owner.address, await getRandomAddress()];
        });

        it("should revert with 'Cannot duplicate addresses'", async () => {
          await expect(subject()).to.be.revertedWith("Cannot duplicate addresses");
        });
      });

      describe("when arrays are empty", async () => {
        beforeEach(async () => {
          subjectAccruers = [];
          subjectStatuses = [];
        });

        it("should revert with 'Array length must be > 0'", async () => {
          await expect(subject()).to.be.revertedWith("Array length must be > 0");
        });
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#updateAnyoneAccrue", async () => {
      let subjectStatus: boolean;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
        subjectStatus = true;
      });

      async function subject(): Promise<ContractTransaction> {
        return await feeExtension.connect(subjectCaller.wallet).updateAnyoneAccrue(subjectStatus);
      }

      it("should set isAnyoneAllowedToAccrue to true", async () => {
        await subject();

        const isAnyoneAllowedToAccrue = await feeExtension.isAnyoneAllowedToAccrue();
        expect(isAnyoneAllowedToAccrue).to.be.true;
      });

      it("should emit an AnyoneAccrueUpdated event", async () => {
        await expect(subject()).to.emit(feeExtension, "AnyoneAccrueUpdated").withArgs(true);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});
