import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import { Address, Account, Bytes, ContractTransaction } from "@utils/types";
import {
  ADDRESS_ZERO,
  EMPTY_BYTES,
  ONE_DAY_IN_SECONDS,
  ONE_HOUR_IN_SECONDS,
  ZERO,
} from "@utils/constants";
import { StakingRewardsV2 } from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getEthBalance,
  getSetFixture,
  getWaffleExpect,
  getRandomAccount,
  getLastBlockTimestamp,
  increaseTimeAsync,
  preciseDiv,
  preciseMul,
  usdc
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();
const provider = ethers.provider;

describe("StakingRewardsV2", () => {
  let owner: Account;
  let stakerOne: Account;
  let stakerTwo: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let stakingRewardsV2: StakingRewardsV2;

  let mockRewardsDistribution: Account;
  let mockRewardsToken: Account;
  let mockStakingToken: Account;

  before(async () => {
    [
      owner,
      stakerOne,
      stakerTwo,
      mockRewardsDistribution,
      mockRewardsToken,
      mockStakingToken
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectRewardsDistribution: Address;
    let subjectRewardsToken: Address;
    let subjectStakingToken: Address;
    let subjectRewardsDuration: BigNumber;

    beforeEach(async () => {
      subjectRewardsDistribution = mockRewardsDistribution.address;
      subjectRewardsToken = mockRewardsToken.address;
      subjectStakingToken = mockStakingToken.address;
      subjectRewardsDuration = ONE_DAY_IN_SECONDS;
    });

    async function subject(): Promise<StakingRewardsV2> {
      return await deployer.staking.deployStakingRewardsV2(
        subjectRewardsDistribution,
        subjectRewardsToken,
        subjectStakingToken,
        subjectRewardsDuration
      );
    }

    it("should set the contract state set", async () => {
      const createdStakingRewards = await subject();

      const rewardsDistrbution = await createdStakingRewards.rewardsDistribution();
      expect(rewardsDistrbution).to.eq(subjectRewardsDistribution);

      const stakingToken = await createdStakingRewards.stakingToken();
      expect(stakingToken).to.eq(subjectStakingToken);

      const rewardsToken = await createdStakingRewards.rewardsToken();
      expect(rewardsToken).to.eq(subjectRewardsToken);

      const rewardsDuration = await createdStakingRewards.rewardsDuration();
      expect(rewardsDuration).to.eq(subjectRewardsDuration);      
    });
  });

  describe('#notifyRewardAmount', async () => {
    let rewardsDistribution: Address;
    let stakingToken: Address;
    let rewardsToken: Address;
    let rewardsDuration: BigNumber;

    let stakingRewardsV2: StakingRewardsV2;
    let rewardTokenQuantity: BigNumber;

    let subjectRewardAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      rewardsDistribution = owner.address;
      stakingToken = setV2Setup.weth.address;
      rewardsToken = setV2Setup.usdc.address;
      rewardsDuration = ONE_DAY_IN_SECONDS;

      stakingRewardsV2 = await deployer.staking.deployStakingRewardsV2(
        rewardsDistribution,
        rewardsToken,
        stakingToken,
        rewardsDuration
      );

      // console.log('Transfer December Rewards');

      // Transfer rewards token to rewards contract
      rewardTokenQuantity = usdc(1000);
      await setV2Setup.usdc.transfer(stakingRewardsV2.address, rewardTokenQuantity);

      subjectRewardAmount = rewardTokenQuantity;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      stakingRewardsV2 = stakingRewardsV2.connect(subjectCaller.wallet);
      return await stakingRewardsV2.notifyRewardAmount(
        subjectRewardAmount
      );
    }

    it("should initialize the rewards properly", async () => {
      await subject();

      const rewardRate = await stakingRewardsV2.rewardRate();
      const expectedRewardRate = subjectRewardAmount.div(rewardsDuration);
      expect(rewardRate).to.eq(expectedRewardRate);

      const lastUpdateTime = await stakingRewardsV2.lastUpdateTime();
      const expectedLastUpdateTime = await getLastBlockTimestamp();
      expect(lastUpdateTime).to.eq(expectedLastUpdateTime);

      const periodFinish = await stakingRewardsV2.periodFinish();
      const expectedPeriodFinish = lastUpdateTime.add(rewardsDuration);
      expect(periodFinish).to.eq(expectedPeriodFinish);
    });

    context('when a user stakes for a period of time', async () => {
      let stakingTokenQuantity: BigNumber;
      let elapsedTimeSeconds: BigNumber;

      beforeEach(async () => {
        // Transfer staking token to the staker account from deployer
        stakingTokenQuantity = ether(1);
        await setV2Setup.weth.transfer(stakerOne.address, stakingTokenQuantity);

        // Staker account stakes tokens into rewards contract
        stakingRewardsV2 = stakingRewardsV2.connect(stakerOne.wallet);
        await setV2Setup.weth.connect(stakerOne.wallet).approve(stakingRewardsV2.address, ether(1));
        await stakingRewardsV2.stake(stakingTokenQuantity);

        elapsedTimeSeconds = ONE_HOUR_IN_SECONDS;
      });

      it("should accrue the correct amount of tokens to the staker", async () => {
        const preStakeAward = await stakingRewardsV2.earned(stakerOne.address);

        await subject();

        await increaseTimeAsync(elapsedTimeSeconds);

        const rewardRate = await stakingRewardsV2.rewardRate();
        const expectedPostStakeAward = rewardRate.mul(elapsedTimeSeconds);

        const postStakeAward = await stakingRewardsV2.earned(stakerOne.address);
        expect(expectedPostStakeAward).to.eq(postStakeAward);
      });

      context('when two users stake for a period of time', async () => {
        beforeEach(async () => {
          // Transfer staking token to the staker account from deployer
          stakingTokenQuantity = ether(1);
          await setV2Setup.weth.transfer(stakerTwo.address, stakingTokenQuantity);

          // Staker account stakes tokens into rewards contract
          stakingRewardsV2 = stakingRewardsV2.connect(stakerTwo.wallet);
          await setV2Setup.weth.connect(stakerTwo.wallet).approve(stakingRewardsV2.address, ether(1));
          await stakingRewardsV2.stake(stakingTokenQuantity);
        });

        it("should accrue the same amount of tokens to each stakers", async () => {
          await subject();

          await increaseTimeAsync(elapsedTimeSeconds);

          const rewardRate = await stakingRewardsV2.rewardRate();
          const expectedPostStakeAward = rewardRate.mul(elapsedTimeSeconds).div(2);
          const stakerOneReward = await stakingRewardsV2.earned(stakerOne.address);
          expect(stakerOneReward).to.eq(expectedPostStakeAward);

          // console.log('1/24th December stakerOne rewards:')
          // console.log(stakerOneReward);

          const stakerTwoReward = await stakingRewardsV2.earned(stakerTwo.address);
          expect(stakerOneReward).to.eq(stakerTwoReward);

          // console.log('1/24th December stakerTwo rewards:')
          // console.log(stakerTwoReward);
        });

        context('when one duration has elapsed and notify reward is called for a 2nd time', async () => {
          beforeEach(async () => {
            // console.log('Notify December Reward Amount');

            // First notify rewards (December)
            await stakingRewardsV2.connect(owner.wallet).notifyRewardAmount(
              subjectRewardAmount
            );

            // console.log('Speed Up Time to End of December Rewards');

            // Elapse first full reward duration
            await increaseTimeAsync(rewardsDuration);

            // console.log('Transfer January Reward Amount');

            // Transfer January rewards token to rewards contract
            rewardTokenQuantity = usdc(1000);
            await setV2Setup.usdc.transfer(stakingRewardsV2.address, rewardTokenQuantity);
          });

          it("should initialize the second rewards properly", async () => {
            // console.log('Notify January Reward Amount');

            await subject();

            const rewardRate = await stakingRewardsV2.rewardRate();
            const expectedRewardRate = subjectRewardAmount.div(rewardsDuration);
            expect(rewardRate).to.eq(expectedRewardRate);

            const lastUpdateTime = await stakingRewardsV2.lastUpdateTime();
            const expectedLastUpdateTime = await getLastBlockTimestamp();
            expect(lastUpdateTime).to.eq(expectedLastUpdateTime);

            const periodFinish = await stakingRewardsV2.periodFinish();
            const expectedPeriodFinish = lastUpdateTime.add(rewardsDuration);
            expect(periodFinish).to.eq(expectedPeriodFinish);
          });

          it("should accrue the correct amount of tokens to the stakers", async () => {
            // console.log('Notify January Reward Amount');

            await subject();

            // console.log('Speed Up Time to 1/24th of January Rewards');
            await increaseTimeAsync(elapsedTimeSeconds);

            const rewardRate = await stakingRewardsV2.rewardRate();
            const totalElapsedTime = rewardsDuration.add(elapsedTimeSeconds);
            const expectedPostStakeAward = rewardRate.mul(totalElapsedTime).div(2);
            const stakerOneReward = await stakingRewardsV2.earned(stakerOne.address);
            expect(stakerOneReward).to.eq(expectedPostStakeAward);

            // console.log('1/24th January rewards:')
            // console.log(stakerOneReward);

            const stakerTwoReward = await stakingRewardsV2.earned(stakerTwo.address);
            expect(stakerOneReward).to.eq(stakerTwoReward);

            // console.log('Current 1/24th February stakerTwo rewards:')
            // console.log(stakerTwoReward);
          });

          context('when the second duration has elapsed and notify reward is called for a 3rd time', async () => {
            beforeEach(async () => {
              // console.log('Notify January Reward Amount');

              // First notify rewards (January)
              await stakingRewardsV2.connect(owner.wallet).notifyRewardAmount(
                subjectRewardAmount
              );

              // console.log('Speed Up Time to End of January Rewards');

              // Elapse second full reward duration
              await increaseTimeAsync(rewardsDuration);

              // console.log('Transfer February Reward Amount');

              // Transfer February rewards token to rewards contract
              rewardTokenQuantity = usdc(1000);
              await setV2Setup.usdc.transfer(stakingRewardsV2.address, rewardTokenQuantity);
            });

            it("should initialize the third rewards properly", async () => {
              // console.log('Notify February Reward Amount');

              await subject();

              const rewardRate = await stakingRewardsV2.rewardRate();
              const expectedRewardRate = subjectRewardAmount.div(rewardsDuration);
              expect(rewardRate).to.eq(expectedRewardRate);

              const lastUpdateTime = await stakingRewardsV2.lastUpdateTime();
              const expectedLastUpdateTime = await getLastBlockTimestamp();
              expect(lastUpdateTime).to.eq(expectedLastUpdateTime);

              const periodFinish = await stakingRewardsV2.periodFinish();
              const expectedPeriodFinish = lastUpdateTime.add(rewardsDuration);
              expect(periodFinish).to.eq(expectedPeriodFinish);
            });

            it("should accrue the correct amount of tokens to the stakers", async () => {
              // console.log('Notify February Reward Amount');

              await subject();

              // console.log('Speed Up Time to 1/24th of February Rewards');
              await increaseTimeAsync(elapsedTimeSeconds);

              const rewardRate = await stakingRewardsV2.rewardRate();
              const totalElapsedTime = rewardsDuration.mul(2).add(elapsedTimeSeconds);
              const expectedPostStakeAward = rewardRate.mul(totalElapsedTime).div(2);
              const stakerOneReward = await stakingRewardsV2.earned(stakerOne.address);
              expect(stakerOneReward).to.eq(expectedPostStakeAward);

              // console.log('Current 1/24th February stakerOne rewards:')
              // console.log(stakerOneReward);

              const stakerTwoReward = await stakingRewardsV2.earned(stakerTwo.address);
              expect(stakerOneReward).to.eq(stakerTwoReward);

              // console.log('Current 1/24th February stakerTwo rewards:')
              // console.log(stakerTwoReward);
            });
          });

          context('when staker two withdraws in the middle of the January rewards', async () => {
            beforeEach(async () => {
              // console.log('Notify January Reward Amount');

              // First notify rewards (January)
              await stakingRewardsV2.connect(owner.wallet).notifyRewardAmount(
                subjectRewardAmount
              );

              // console.log('Speed Up Time to Midway of January Rewards');

              // Elapse half of reward duration
              await increaseTimeAsync(rewardsDuration.div(2));

              // console.log('Staker Two Gets Rewards');
              await stakingRewardsV2.connect(stakerTwo.wallet).getReward();
            });

            it("should accrue the correct amount of tokens to the stakers at the end", async () => {
              // console.log('Speed Up Time to End of January Rewards');

              // Elapse remainder of reward duration
              await increaseTimeAsync(rewardsDuration.div(2));

              const rewardRate = await stakingRewardsV2.rewardRate();
              const totalElapsedTime = rewardsDuration.add(rewardsDuration);
              const expectedPostStakeAward = rewardRate.mul(totalElapsedTime).div(2);
              const stakerOneReward = await stakingRewardsV2.earned(stakerOne.address);
              expect(stakerOneReward).to.eq(expectedPostStakeAward);

              // console.log('Current end of January stakerOne rewards:')
              // console.log(stakerOneReward);

              // console.log('Current end of January stakerTwo rewards:')
              const stakerTwoReward = await stakingRewardsV2.earned(stakerTwo.address);
              // console.log(stakerTwoReward);
            });

            context('when the second duration has elapsed and notify reward is called for a 3rd time', async () => {
              beforeEach(async () => {
                // console.log('Speed Up Time to End of January Rewards');

                // Elapse second full reward duration
                await increaseTimeAsync(rewardsDuration.div(2));

                // console.log('Transfer February Reward Amount');

                // Transfer February rewards token to rewards contract
                rewardTokenQuantity = usdc(1000);
                await setV2Setup.usdc.transfer(stakingRewardsV2.address, rewardTokenQuantity);
              });

              it("should initialize the third rewards properly", async () => {
                // console.log('Notify February Reward Amount');

                await subject();

                const rewardRate = await stakingRewardsV2.rewardRate();
                const expectedRewardRate = subjectRewardAmount.div(rewardsDuration);
                expect(rewardRate).to.eq(expectedRewardRate);

                const lastUpdateTime = await stakingRewardsV2.lastUpdateTime();
                const expectedLastUpdateTime = await getLastBlockTimestamp();
                expect(lastUpdateTime).to.eq(expectedLastUpdateTime);

                const periodFinish = await stakingRewardsV2.periodFinish();
                const expectedPeriodFinish = lastUpdateTime.add(rewardsDuration);
                expect(periodFinish).to.eq(expectedPeriodFinish);
              });

              it("should accrue the correct amount of tokens to the stakers", async () => {
                // console.log('Notify February Reward Amount');

                await subject();

                // console.log('Speed Up Time to 1/24th of February Rewards');
                await increaseTimeAsync(elapsedTimeSeconds);

                const rewardRate = await stakingRewardsV2.rewardRate();
                const totalElapsedTime = rewardsDuration.mul(2).add(elapsedTimeSeconds);
                const expectedPostStakeAward = rewardRate.mul(totalElapsedTime).div(2);
                const stakerOneReward = await stakingRewardsV2.earned(stakerOne.address);
                expect(stakerOneReward).to.eq(expectedPostStakeAward);

                // console.log('Current 1/24th February stakerOne rewards:')
                // console.log(stakerOneReward);

                // console.log('Current 1/24th February stakerTwo rewards:')
                const stakerTwoReward = await stakingRewardsV2.earned(stakerTwo.address);
                // console.log(stakerTwoReward);
              });

              context('when the third duration has elapsed and notify reward is called for a 4th time', async () => {
                beforeEach(async () => {
                  // console.log('Notify February Reward Amount');

                  await subject();

                  // console.log('Speed Up Time to End of February Rewards');

                  // Elapse third full reward duration
                  await increaseTimeAsync(rewardsDuration);

                  // console.log('Transfer March Reward Amount');

                  // Transfer February rewards token to rewards contract
                  rewardTokenQuantity = usdc(1000);
                  await setV2Setup.usdc.transfer(stakingRewardsV2.address, rewardTokenQuantity);
                });

                it("should initialize the fourth rewards properly", async () => {
                  // console.log('Notify March Reward Amount');

                  await subject();

                  const rewardRate = await stakingRewardsV2.rewardRate();
                  const expectedRewardRate = subjectRewardAmount.div(rewardsDuration);
                  expect(rewardRate).to.eq(expectedRewardRate);

                  const lastUpdateTime = await stakingRewardsV2.lastUpdateTime();
                  const expectedLastUpdateTime = await getLastBlockTimestamp();
                  expect(lastUpdateTime).to.eq(expectedLastUpdateTime);

                  const periodFinish = await stakingRewardsV2.periodFinish();
                  const expectedPeriodFinish = lastUpdateTime.add(rewardsDuration);
                  expect(periodFinish).to.eq(expectedPeriodFinish);
                });

                it("should accrue the correct amount of tokens to the stakers", async () => {
                  // console.log('Notify March Reward Amount');

                  await subject();

                  // console.log('Speed Up Time to 1/24th of March Rewards');
                  await increaseTimeAsync(elapsedTimeSeconds);

                  const rewardRate = await stakingRewardsV2.rewardRate();
                  const totalElapsedTime = rewardsDuration.mul(3).add(elapsedTimeSeconds);
                  const expectedPostStakeAward = rewardRate.mul(totalElapsedTime).div(2);
                  const stakerOneReward = await stakingRewardsV2.earned(stakerOne.address);
                  expect(stakerOneReward).to.eq(expectedPostStakeAward);

                  // console.log('Current 1/24th March stakerOne rewards:')
                  // console.log(stakerOneReward);

                  // console.log('Current 1/24th March stakerTwo rewards:')
                  const stakerTwoReward = await stakingRewardsV2.earned(stakerTwo.address);
                  // console.log(stakerTwoReward);
                });
              });
            });
          });
        });
      });
    });
  });
});
