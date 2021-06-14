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
  getRandomAddress,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
  increaseTimeAsync,
} from "@utils/index";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { UniswapV2Pair } from "@typechain/UniswapV2Pair";
import { SetFixture, UniswapFixture } from "@utils/fixtures";
import { MAX_UINT_256 } from "@utils/constants";
import { MasterChefMock } from "@typechain/MasterChefMock";
import { ContractTransaction } from "ethers";

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

  let masterChef: MasterChefMock;
  let masterChefId: BigNumber;

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
    await uniFixture.initialize(owner, setV2Setup.weth.address, setV2Setup.wbtc.address, setV2Setup.usdc.address);
    await sushiFixture.initialize(owner, setV2Setup.weth.address, setV2Setup.wbtc.address, setV2Setup.usdc.address);
    uniPair = await uniFixture.createNewPair(setV2Setup.weth.address, index.address);
    sushiPair = await sushiFixture.createNewPair(setV2Setup.weth.address, index.address);

    masterChef = await deployer.mocks.deployMasterChefMock();
    masterChefId = BigNumber.from(75);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    async function subject(): Promise<IndexPowah> {
      return deployer.token.deployIndexPowah(
        owner.address,
        index.address,
        uniPair.address,
        sushiPair.address,
        masterChef.address,
        masterChefId,
        [ dpiFarm.address, mviFarm.address ],
        [ vesting.address ]
      );
    }

    it("should set the state variables correctly", async () => {
      const indexPowah = await subject();

      expect(await indexPowah.owner()).to.eq(owner.address);
      expect(await indexPowah.indexToken()).to.eq(index.address);
      expect(await indexPowah.uniPair()).to.eq(uniPair.address);
      expect(await indexPowah.sushiPair()).to.eq(sushiPair.address);
      expect(await indexPowah.masterChef()).to.eq(masterChef.address);
      expect(await indexPowah.masterChefId()).to.eq(masterChefId);
      expect(await indexPowah.farms(0)).to.eq(dpiFarm.address);
      expect(await indexPowah.farms(1)).to.eq(mviFarm.address);
      expect(await indexPowah.vesting(0)).to.eq(vesting.address);
    });
  });

  describe("#balanceOf", async () => {

    let indexPowah: IndexPowah;

    beforeEach(async () => {
      indexPowah = await deployer.token.deployIndexPowah(
        owner.address,
        index.address,
        uniPair.address,
        sushiPair.address,
        masterChef.address,
        masterChefId,
        [ dpiFarm.address, mviFarm.address ],
        [ vesting.address ]
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

    context("when the voter has INDEX-WETH SLP tokens in MasterChef (Onsen)", async () => {

      let subjectMasterChefAmount: BigNumber;

      beforeEach(async () => {
        await index.connect(owner.wallet).approve(sushiFixture.router.address, ether(1000));
        await setV2Setup.weth.connect(owner.wallet).approve(sushiFixture.router.address, ether(60));
        await sushiFixture.router.connect(owner.wallet).addLiquidity(
          setV2Setup.weth.address,
          index.address,
          ether(60),
          ether(1000),
          ether(59),
          ether(999),
          masterChef.address,
          MAX_UINT_256
        );
        subjectMasterChefAmount = await sushiPair.balanceOf(masterChef.address);
        await masterChef.setAmount(subjectMasterChefAmount);
      });

      it("should cont the votes from the LP position in MasterChef", async () => {
        const votes = await subject();

        const expectedVotes = subjectMasterChefAmount
          .mul(await index.balanceOf(sushiPair.address))
          .div(await sushiPair.totalSupply());

        expect(votes).to.eq(expectedVotes);
      });
    });
  });

  describe("#addFarms", async () => {

    let subjectNewFarm: StakingRewardsV2;
    let subjectCaller: Account;
    let indexPowah: IndexPowah;

    beforeEach(async () => {
      indexPowah = await deployer.token.deployIndexPowah(
        owner.address,
        index.address,
        uniPair.address,
        sushiPair.address,
        masterChef.address,
        masterChefId,
        [ dpiFarm.address, mviFarm.address ],
        [ vesting.address ]
      );
      subjectNewFarm = await deployer.staking.deployStakingRewardsV2(owner.address, index.address, dpi.address, 1000);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return indexPowah.connect(subjectCaller.wallet).addFarms([ subjectNewFarm.address ]);
    }

    it("should add the new farm to the farm list", async () => {
      await subject();

      expect(await indexPowah.farms(2)).to.eq(subjectNewFarm.address);
    });

    context("when the caller is not the owner", async () => {

      beforeEach(async () => {
        subjectCaller = voter;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#addVesting", async () => {

    let subjectNewVesting: Vesting;
    let subjectCaller: Account;
    let indexPowah: IndexPowah;

    beforeEach(async () => {
      indexPowah = await deployer.token.deployIndexPowah(
        owner.address,
        index.address,
        uniPair.address,
        sushiPair.address,
        masterChef.address,
        masterChefId,
        [ dpiFarm.address, mviFarm.address ],
        [ vesting.address ]
      );

      const now = await getLastBlockTimestamp();
      subjectNewVesting = await deployer.token.deployVesting(
        index.address,
        voter.address,
        ether(77),
        now.add(1),
        now.add(1000),
        now.add(5000)
      );

      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return indexPowah.connect(subjectCaller.wallet).addVesting([ subjectNewVesting.address ]);
    }

    it("should add the new farm to the farm list", async () => {
      await subject();

      expect(await indexPowah.vesting(1)).to.eq(subjectNewVesting.address);
    });

    context("when the caller is not the owner", async () => {

      beforeEach(async () => {
        subjectCaller = voter;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateMasterChef", async () => {

    let indexPowah: IndexPowah;
    let subjectNewMasterChef: string;
    let subjectNewPoolId: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewMasterChef = await getRandomAddress();
      subjectNewPoolId = BigNumber.from(92);
      subjectCaller = owner;

      indexPowah = await deployer.token.deployIndexPowah(
        owner.address,
        index.address,
        uniPair.address,
        sushiPair.address,
        masterChef.address,
        masterChefId,
        [ dpiFarm.address, mviFarm.address ],
        [ vesting.address ]
      );
    });

    async function subject(): Promise<ContractTransaction> {
      return indexPowah.connect(subjectCaller.wallet).updateMasterChef(subjectNewMasterChef, subjectNewPoolId);
    }

    it("should update the MasterChef contract address and pool ID", async () => {
      await subject();

      expect(await indexPowah.masterChef()).to.eq(subjectNewMasterChef);
      expect(await indexPowah.masterChefId()).to.eq(subjectNewPoolId);
    });

    context("when the caller is not the owner", async () => {

      beforeEach(async () => {
        subjectCaller = voter;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});