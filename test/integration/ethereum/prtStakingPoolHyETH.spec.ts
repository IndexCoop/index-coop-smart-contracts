import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { increaseTimeAsync, setBlockNumber } from "@utils/test/testingUtils";
import {
  BaseManagerV2,
  BaseManagerV2__factory,
  Prt,
  PrtFeeSplitExtension,
  PrtStakingPool,
  SetToken,
  SetToken__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ether } from "@utils/index";
import { impersonateAccount } from "./utils";
import { JsonRpcSigner } from "@ethersproject/providers";
import { ONE_MONTH_IN_SECONDS } from "@utils/constants";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe.only("PrtStakingPool HyETH - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;

    let owner: Account;
    let bob: Account;
    let alice: Account;
    let carol: Account;
    let deployer: DeployHelper;

    let hyEth: SetToken;
    let baseManager: BaseManagerV2;
    let operator: JsonRpcSigner;
    let methodologist: JsonRpcSigner;

    setBlockNumber(20064598, true);

    before(async () => {
      [
        owner,
        bob,
        alice,
        carol,
      ] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      hyEth = SetToken__factory.connect(addresses.tokens.hyEth, owner.wallet);
      baseManager = BaseManagerV2__factory.connect(await hyEth.manager(), owner.wallet);

      operator = await impersonateAccount(await baseManager.operator());
      methodologist = await impersonateAccount(await baseManager.methodologist());
    });

    context("When the PRT, PRT Staking Pool, and Prt Fee Split Extension are deployed and setup", () => {
      const prtName = "High Yield ETH Index PRT";
      const prtSymbol = "prtHyETH";
      const prtSupply = ether(10_000);

      const prtStakingPoolName = "High Yield ETH Index Staked PRT";
      const prtStakingPoolSymbol = "sPrtHyETH";

      const prtFeeSplit = ether(0.7); // 70-30 split

      let prt: Prt;
      let prtFeeSplitExtension: PrtFeeSplitExtension;
      let prtStakingPool: PrtStakingPool;

      before(async () => {
        prt = await deployer.token.deployPrt(
          prtName,
          prtSymbol,
          hyEth.address,
          owner.address,
          prtSupply
        );

        prtFeeSplitExtension = await deployer.extensions.deployPrtFeeSplitExtension(
          baseManager.address,
          addresses.setFork.streamingFeeModule,
          addresses.setFork.debtIssuanceModuleV2_1,
          prtFeeSplit,
          addresses.setFork.feeRecipient,
          prt.address
        );
        await baseManager.connect(operator).addExtension(prtFeeSplitExtension.address);
        await prtFeeSplitExtension.connect(operator).updateFeeRecipient(prtFeeSplitExtension.address);
        await prtFeeSplitExtension.connect(methodologist).updateFeeRecipient(prtFeeSplitExtension.address);

        prtStakingPool = await deployer.staking.deployPrtStakingPool(
          prtStakingPoolName,
          prtStakingPoolSymbol,
          prt.address,
          prtFeeSplitExtension.address
        );
        await prtFeeSplitExtension.connect(operator).updatePrtStakingPool(prtStakingPool.address);
        await prtFeeSplitExtension.connect(methodologist).updatePrtStakingPool(prtStakingPool.address);
      });

      it("should set the PRT state correctly", async () => {
        expect(await prt.decimals()).to.eq(18);
        expect(await prt.totalSupply()).to.eq(prtSupply);
        expect(await prt.name()).to.eq(prtName);
        expect(await prt.symbol()).to.eq(prtSymbol);
      });

      it("should distribute the PRT to the owner", async () => {
        expect(await prt.balanceOf(owner.address)).to.eq(prtSupply);
      });

      it("should set the PrtFeeSplitExtension state correctly", async () => {
        expect(await prtFeeSplitExtension.prt()).to.eq(prt.address);
        expect(await prtFeeSplitExtension.setToken()).to.eq(hyEth.address);
        expect(await prtFeeSplitExtension.manager()).to.eq(baseManager.address);
        expect(await prtFeeSplitExtension.streamingFeeModule()).to.eq(addresses.setFork.streamingFeeModule);
        expect(await prtFeeSplitExtension.issuanceModule()).to.eq(addresses.setFork.debtIssuanceModuleV2_1);
        expect(await prtFeeSplitExtension.operatorFeeSplit()).to.eq(prtFeeSplit);
        expect(await prtFeeSplitExtension.operatorFeeRecipient()).to.eq(addresses.setFork.feeRecipient);
        expect(await prtFeeSplitExtension.prtStakingPool()).to.eq(prtStakingPool.address);
      });

      it("should set the PrtFeeSplitExtension as an extension on the BaseManager", async () => {
        expect(await baseManager.isExtension(prtFeeSplitExtension.address));
      });

      it("should set the PrtStakingPool state correctly", async () => {
        expect(await prtStakingPool.decimals()).to.eq(18);
        expect(await prtStakingPool.feeSplitExtension()).to.eq(prtFeeSplitExtension.address);
        expect(await prtStakingPool.prt()).to.eq(prt.address);
        expect(await prtStakingPool.name()).to.eq(prtStakingPoolName);
        expect(await prtStakingPool.symbol()).to.eq(prtStakingPoolSymbol);
        expect(await prtStakingPool.setToken()).to.eq(hyEth.address);
        expect(await prtStakingPool.totalSupply()).to.eq(0);
      });

      context("When the PRTs are distributed and staked", () => {
        const bobPrtAmount = ether(1000);
        const alicePrtAmount = ether(250);
        const carolPrtAmount = ether(500);

        before(async () => {
          await prt.connect(owner.wallet).transfer(bob.address, bobPrtAmount);
          await prt.connect(owner.wallet).transfer(alice.address, alicePrtAmount);
          await prt.connect(owner.wallet).transfer(carol.address, carolPrtAmount);

          await prt.connect(bob.wallet).approve(prtStakingPool.address, bobPrtAmount);
          await prt.connect(alice.wallet).approve(prtStakingPool.address, alicePrtAmount);
          await prt.connect(carol.wallet).approve(prtStakingPool.address, carolPrtAmount);

          await prtStakingPool.connect(bob.wallet).stake(bobPrtAmount);
          await prtStakingPool.connect(alice.wallet).stake(alicePrtAmount);
          await prtStakingPool.connect(carol.wallet).stake(carolPrtAmount);
        });

        it("should set the pre snapshot balances correctly", async () => {
          const totalPrtAmount = bobPrtAmount.add(alicePrtAmount).add(carolPrtAmount);
          expect(await prt.balanceOf(prtStakingPool.address)).to.eq(totalPrtAmount);
          expect(await prtStakingPool.balanceOf(bob.address)).to.eq(bobPrtAmount);
          expect(await prtStakingPool.balanceOf(alice.address)).to.eq(alicePrtAmount);
          expect(await prtStakingPool.balanceOf(carol.address)).to.eq(carolPrtAmount);
          expect(await prtStakingPool.totalSupply()).to.eq(totalPrtAmount);
        });

        it("should have no rewards and currentId 0", async () => {
          expect(await hyEth.balanceOf(prtStakingPool.address)).to.eq(0);
          expect(await prtStakingPool.getCurrentId()).to.eq(0);
        });

        context("When the first snapshot is taken", () => {
          before(async () => {
            await prtFeeSplitExtension.connect(operator).accrueFeesAndDistribute();
          });

          it("should accrue fees and increment the snapshot id", async () => {
            expect(await hyEth.balanceOf(prtStakingPool.address)).to.gt(0);
            expect(await prtStakingPool.getCurrentId()).to.eq(1);
          });

          it("should allow bob and alice to claim proportional rewards", async () => {
            // Bob and Alice claim after snapshot 1, carol does not claim

            const accruedFees = await prtStakingPool.accrueSnapshots(0);
            const totalStakedPrtAmount = bobPrtAmount.add(alicePrtAmount).add(carolPrtAmount);

            const bobSetTokenBalanceBefore = await hyEth.balanceOf(bob.address);
            const aliceSetTokenBalanceBefore = await hyEth.balanceOf(alice.address);

            const expectedBobRewards = accruedFees.mul(bobPrtAmount).div(totalStakedPrtAmount);
            const expectedAliceRewards = accruedFees.mul(alicePrtAmount).div(totalStakedPrtAmount);

            const bobPendingRewardsBefore = await prtStakingPool.getPendingRewards(bob.address);
            const alicePendingRewardsBefore = await prtStakingPool.getPendingRewards(alice.address);

            expect(bobPendingRewardsBefore).to.eq(expectedBobRewards);
            expect(alicePendingRewardsBefore).to.eq(expectedAliceRewards);

            expect(bobSetTokenBalanceBefore).to.eq(0);
            expect(aliceSetTokenBalanceBefore).to.eq(0);

            await prtStakingPool.connect(bob.wallet).claim();
            await prtStakingPool.connect(alice.wallet).claim();

            const bobSetTokenBalanceAfter = await hyEth.balanceOf(bob.address);
            const aliceSetTokenBalanceAfter = await hyEth.balanceOf(alice.address);

            const bobPendingRewardsAfter = await prtStakingPool.getPendingRewards(bob.address);
            const alicePendingRewardsAfter = await prtStakingPool.getPendingRewards(alice.address);

            expect(bobPendingRewardsAfter).to.eq(0);
            expect(alicePendingRewardsAfter).to.eq(0);

            expect(bobSetTokenBalanceAfter).to.eq(expectedBobRewards);
            expect(aliceSetTokenBalanceAfter).to.eq(expectedAliceRewards);
          });

          context("When the second snapshot is taken", () => {
            before(async () => {
              await increaseTimeAsync(ONE_MONTH_IN_SECONDS);
              await prtFeeSplitExtension.connect(operator).accrueFeesAndDistribute();
            });

            it("should increment the snapshot id", async () => {
              expect(await prtStakingPool.getCurrentId()).to.eq(2);
            });

            it("should allow bob, alice, and carol to claim proportional rewards", async () => {
              // Bob and Alice claim again, carol claims for the first time

              const accruedFeesSnapshotOne = await prtStakingPool.accrueSnapshots(0);
              const accruedFeesSnapshotTwo = await prtStakingPool.accrueSnapshots(1);
              const totalStakedPrtAmount = bobPrtAmount.add(alicePrtAmount).add(carolPrtAmount);

              const bobSetTokenBalanceBefore = await hyEth.balanceOf(bob.address);
              const aliceSetTokenBalanceBefore = await hyEth.balanceOf(alice.address);
              const carolSetTokenBalanceBefore = await hyEth.balanceOf(carol.address);

              const expectedBobRewards = accruedFeesSnapshotTwo.mul(bobPrtAmount).div(totalStakedPrtAmount);
              const expectedAliceRewards = accruedFeesSnapshotTwo.mul(alicePrtAmount).div(totalStakedPrtAmount);

              const expectedCarolSnapshotOneRewards = accruedFeesSnapshotOne.mul(carolPrtAmount).div(totalStakedPrtAmount);
              const expectedCarolSnapshotTwoRewards = accruedFeesSnapshotTwo.mul(carolPrtAmount).div(totalStakedPrtAmount);
              const expectedCarolRewards = expectedCarolSnapshotOneRewards.add(expectedCarolSnapshotTwoRewards);

              const bobPendingRewardsBefore = await prtStakingPool.getPendingRewards(bob.address);
              const alicePendingRewardsBefore = await prtStakingPool.getPendingRewards(alice.address);
              const carolPendingRewardsBefore = await prtStakingPool.getPendingRewards(carol.address);

              expect(bobPendingRewardsBefore).to.eq(expectedBobRewards);
              expect(alicePendingRewardsBefore).to.eq(expectedAliceRewards);
              expect(carolPendingRewardsBefore).to.eq(expectedCarolRewards);

              expect(bobSetTokenBalanceBefore).to.gt(0);
              expect(aliceSetTokenBalanceBefore).to.gt(0);
              expect(carolSetTokenBalanceBefore).to.eq(0);

              await prtStakingPool.connect(bob.wallet).claim();
              await prtStakingPool.connect(alice.wallet).claim();
              await prtStakingPool.connect(carol.wallet).claim();

              const bobSetTokenBalanceAfter = await hyEth.balanceOf(bob.address);
              const aliceSetTokenBalanceAfter = await hyEth.balanceOf(alice.address);
              const carolSetTokenBalanceAfter = await hyEth.balanceOf(carol.address);

              const bobPendingRewardsAfter = await prtStakingPool.getPendingRewards(bob.address);
              const alicePendingRewardsAfter = await prtStakingPool.getPendingRewards(alice.address);
              const carolPendingRewardsAfter = await prtStakingPool.getPendingRewards(carol.address);

              expect(bobPendingRewardsAfter).to.eq(0);
              expect(alicePendingRewardsAfter).to.eq(0);
              expect(carolPendingRewardsAfter).to.eq(0);

              expect(bobSetTokenBalanceAfter).to.eq(expectedBobRewards.add(bobSetTokenBalanceBefore));
              expect(aliceSetTokenBalanceAfter).to.eq(expectedAliceRewards.add(aliceSetTokenBalanceBefore));
              expect(carolSetTokenBalanceAfter).to.eq(expectedCarolRewards);
            });

            context("When the third snapshot is taken", () => {
              before(async () => {
                await increaseTimeAsync(ONE_MONTH_IN_SECONDS);

                // Bob unstakes right before the third snapshot
                await prtStakingPool.connect(bob.wallet).unstake(bobPrtAmount);

                await prtFeeSplitExtension.connect(operator).accrueFeesAndDistribute();
              });

              it("should increment the snapshot id", async () => {
                expect(await prtStakingPool.getCurrentId()).to.eq(3);
              });

              it("should allow bob, alice, and carol to claim proportional rewards", async () => {
                // Alice and carol claim again, bob cannot claim

                const accruedFeesSnapshotThree = await prtStakingPool.accrueSnapshots(2);
                const totalStakedPrtAmount = alicePrtAmount.add(carolPrtAmount);

                const bobSetTokenBalanceBefore = await hyEth.balanceOf(bob.address);
                const aliceSetTokenBalanceBefore = await hyEth.balanceOf(alice.address);
                const carolSetTokenBalanceBefore = await hyEth.balanceOf(carol.address);

                const expectedAliceRewards = accruedFeesSnapshotThree.mul(alicePrtAmount).div(totalStakedPrtAmount);
                const expectedCarolRewards = accruedFeesSnapshotThree.mul(carolPrtAmount).div(totalStakedPrtAmount);

                const bobPendingRewardsBefore = await prtStakingPool.getPendingRewards(bob.address);
                const alicePendingRewardsBefore = await prtStakingPool.getPendingRewards(alice.address);
                const carolPendingRewardsBefore = await prtStakingPool.getPendingRewards(carol.address);

                expect(bobPendingRewardsBefore).to.eq(0);
                expect(alicePendingRewardsBefore).to.eq(expectedAliceRewards);
                expect(carolPendingRewardsBefore).to.eq(expectedCarolRewards);

                expect(bobSetTokenBalanceBefore).to.gt(0);
                expect(aliceSetTokenBalanceBefore).to.gt(0);
                expect(carolSetTokenBalanceBefore).to.gt(0);

                await prtStakingPool.connect(alice.wallet).claim();
                await prtStakingPool.connect(carol.wallet).claim();

                const aliceSetTokenBalanceAfter = await hyEth.balanceOf(alice.address);
                const carolSetTokenBalanceAfter = await hyEth.balanceOf(carol.address);

                const alicePendingRewardsAfter = await prtStakingPool.getPendingRewards(alice.address);
                const carolPendingRewardsAfter = await prtStakingPool.getPendingRewards(carol.address);

                expect(alicePendingRewardsAfter).to.eq(0);
                expect(carolPendingRewardsAfter).to.eq(0);

                expect(aliceSetTokenBalanceAfter).to.eq(expectedAliceRewards.add(aliceSetTokenBalanceBefore));
                expect(carolSetTokenBalanceAfter).to.eq(expectedCarolRewards.add(carolSetTokenBalanceBefore));
              });
            });
          });
        });
      });
    });
  });
}
