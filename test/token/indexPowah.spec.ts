import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "@utils/types";
import { IndexToken, IndexPowah, StakingRewardsV2, Vesting } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
  increaseTimeAsync,
} from "@utils/index";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { UniswapV2Pair } from "@typechain/UniswapV2Pair";
import { SetFixture, UniswapFixture } from "@utils/fixtures";
import { MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

describe("IndexPowah", async () => {

  let owner: Account;
  let voter: Account;

  let deployer: DeployHelper;
  let index: IndexToken;
  let dpi: StandardTokenMock;
  let mvi: StandardTokenMock;

  let dpiFarm: StakingRewardsV2;
  let mviFarm: StakingRewardsV2;

  let setV2Setup: SetFixture;
  let uniFixture: UniswapFixture;
  let sushiFixture: UniswapFixture;
  let uniPair: UniswapV2Pair;
  let sushiPair: UniswapV2Pair;

  let vesting: Vesting;

  before(async () => {
    [ owner, voter ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    index = await deployer.token.deployIndexToken(owner.address);
    dpi = await deployer.mocks.deployStandardTokenMock(owner.address, 18);
    mvi = await deployer.mocks.deployStandardTokenMock(owner.address, 18);

    dpiFarm = await deployer.staking.deployStakingRewardsV2(owner.address, index.address, dpi.address, BigNumber.from(100));
    mviFarm = await deployer.staking.deployStakingRewardsV2(owner.address, index.address, mvi.address, BigNumber.from(100));

    const now = await getLastBlockTimestamp();
    vesting = await deployer.token.deployVesting(index.address, voter.address, ether(77), now.add(1), now.add(1000), now.add(5000));

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();
    uniFixture = getUniswapFixture(owner.address);
    sushiFixture = getUniswapFixture(owner.address);
    await uniFixture.initialize(owner.address, setV2Setup.weth.address, setV2Setup.wbtc.address, setV2Setup.usdc.address);
    await sushiFixture.initialize(owner.address, setV2Setup.weth.address, setV2Setup.wbtc.address, setV2Setup.usdc.address);
    uniPair = await uniFixture.createNewPair(setV2Setup.weth.address, index.address);
    sushiPair = await sushiFixture.createNewPair(setV2Setup.weth.address, index.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    async function subject(): Promise<IndexPowah> {
      return deployer.token.deployIndexPowah(
        index.address,
        dpiFarm.address,
        mviFarm.address,
        uniPair.address,
        sushiPair.address,
        [vesting.address]
      );
    }

    it("should set the state variables correctly", async () => {
      const indexPowah = await subject();

      expect(await indexPowah.indexToken()).to.eq(index.address);
      expect(await indexPowah.dpiFarm()).to.eq(dpiFarm.address);
      expect(await indexPowah.mviFarm()).to.eq(mviFarm.address);
      expect(await indexPowah.uniPair()).to.eq(uniPair.address);
      expect(await indexPowah.sushiPair()).to.eq(sushiPair.address);
      expect(await indexPowah.investorVesting(0)).to.eq(vesting.address);
    });
  });

  describe("#balanceOf", async () => {

    let indexPowah: IndexPowah;

    beforeEach(async () => {
      indexPowah = await deployer.token.deployIndexPowah(
        index.address,
        dpiFarm.address,
        mviFarm.address,
        uniPair.address,
        sushiPair.address,
        [vesting.address]
      );
    });

    async function subject(): Promise<BigNumber> {
      return indexPowah.balanceOf(voter.address);
    }

    context("when the voter has index tokens", async () => {

      let subjectAmountIndex: BigNumber;

      beforeEach(async () => {
        subjectAmountIndex = ether(100);
        await index.connect(owner.wallet).transfer(voter.address, subjectAmountIndex);
      });

      it("should count the voters index tokens", async () => {
        const votes = await subject();

        expect(votes).to.eq(subjectAmountIndex);
      });
    });

    context("when the voter has unclaimed index in the DPI farm", async () => {

      let subjectAmountStaked: BigNumber;
      let subjectAmountRewards: BigNumber;

      beforeEach(async () => {
        subjectAmountStaked = ether(50);
        subjectAmountRewards =  ether(2500);
        await index.connect(owner.wallet).transfer(dpiFarm.address, subjectAmountRewards);
        await dpiFarm.connect(owner.wallet).notifyRewardAmount(subjectAmountRewards);
        await dpi.connect(owner.wallet).transfer(voter.address, subjectAmountStaked);
        await dpi.connect(voter.wallet).approve(dpiFarm.address, subjectAmountStaked);
        await dpiFarm.connect(voter.wallet).stake(subjectAmountStaked);
        await increaseTimeAsync(BigNumber.from(50));
      });

      it("should count votes from unclaimed index", async () => {
        const votes = await subject();

        expect(votes).to.eq(await dpiFarm.earned(voter.address));
      });
    });

    context("when the voter has unclaimed index in the MVI farm", async () => {

      let subjectAmountStaked: BigNumber;
      let subjectAmountRewards: BigNumber;

      beforeEach(async () => {
        subjectAmountStaked = ether(50);
        subjectAmountRewards =  ether(700);
        await index.connect(owner.wallet).transfer(mviFarm.address, subjectAmountRewards);
        await mviFarm.connect(owner.wallet).notifyRewardAmount(subjectAmountRewards);
        await mvi.connect(owner.wallet).transfer(voter.address, subjectAmountStaked);
        await mvi.connect(voter.wallet).approve(mviFarm.address, subjectAmountStaked);
        await mviFarm.connect(voter.wallet).stake(subjectAmountStaked);
        await increaseTimeAsync(BigNumber.from(50));
      });

      it("should count votes from unclaimed index", async () => {
        const votes = await subject();

        expect(votes).to.eq(await mviFarm.earned(voter.address));
      });
    });

    context("when the voter has vesting index", async () => {

      beforeEach(async () => {
        await index.connect(owner.wallet).transfer(vesting.address, ether(77));
      });

      it("should count the votes from the vesting contract", async () => {
        const votes = await subject();

        expect(votes).to.eq(await index.balanceOf(vesting.address));
      });
    });

    context("when the voter owns INDEX-WETH on Uniswap", async () => {

      beforeEach(async () => {
        await index.connect(owner.wallet).approve(uniFixture.router.address, ether(1000));
        await setV2Setup.weth.connect(owner.wallet).approve(uniFixture.router.address, ether(50));
        await uniFixture.router.addLiquidity(
          setV2Setup.weth.address,
          index.address,
          ether(50),
          ether(1000),
          ether(49),
          ether(999),
          voter.address,
          MAX_UINT_256
        );
      });

      it("should count the votes in the LP position", async () => {
        const votes = await subject();

        const expectedVotes = (await uniPair.balanceOf(voter.address)).mul(await index.balanceOf(uniPair.address)).div(await uniPair.totalSupply());
        expect(votes).to.eq(expectedVotes);
      });
    });

    context("when the voter owns INDEX-WETH on Sushiswap", async () => {

      beforeEach(async () => {
        await index.connect(owner.wallet).approve(sushiFixture.router.address, ether(1000));
        await setV2Setup.weth.connect(owner.wallet).approve(sushiFixture.router.address, ether(50));
        await sushiFixture.router.addLiquidity(
          setV2Setup.weth.address,
          index.address,
          ether(50),
          ether(1000),
          ether(49),
          ether(999),
          voter.address,
          MAX_UINT_256
        );
      });

      it("should count the votes in the LP position", async () => {
        const votes = await subject();

        const expectedVotes = (await sushiPair.balanceOf(voter.address))
          .mul(await index.balanceOf(sushiPair.address))
          .div(await sushiPair.totalSupply());

        expect(votes).to.eq(expectedVotes);
      });
    });
  });
});