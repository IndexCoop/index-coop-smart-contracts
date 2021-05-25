import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "@utils/types";
import { IndexToken, IndexPowah, StakingRewardsV2 } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getProvider,
  getRandomAccount,
  getRandomAddress,
  getWaffleExpect,
  increaseTimeAsync,
} from "@utils/index";
import { ContractTransaction } from "ethers";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { formatEther } from "ethers/lib/utils";

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
  
  before(async () => {
    [ owner, voter ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    index = await deployer.token.deployIndexToken(owner.address);
    dpi = await deployer.mocks.deployStandardTokenMock(owner.address, 18);
    mvi = await deployer.mocks.deployStandardTokenMock(owner.address, 18);

    dpiFarm = await deployer.staking.deployStakingRewardsV2(owner.address, index.address, dpi.address, BigNumber.from(100));
    mviFarm = await deployer.staking.deployStakingRewardsV2(owner.address, index.address, mvi.address, BigNumber.from(100));
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    
    async function subject(): Promise<IndexPowah> {
      return deployer.token.deployIndexPowah(index.address, dpiFarm.address, mviFarm.address);
    }

    it("should set the state variables correctly", async () => {
      const indexPowah = await subject()

      expect(await indexPowah.indexToken()).to.eq(index.address);
      expect(await indexPowah.dpiFarm()).to.eq(dpiFarm.address);
      expect(await indexPowah.mviFarm()).to.eq(mviFarm.address);
    });
  });

  describe("#balanceOf", async () => {

    let indexPowah: IndexPowah;

    beforeEach(async () => {
      indexPowah = await deployer.token.deployIndexPowah(index.address, dpiFarm.address, mviFarm.address);
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
        subjectAmountRewards =  ether(250);
        await index.connect(owner.wallet).transfer(dpiFarm.address, subjectAmountRewards);
        await dpi.connect(owner.wallet).transfer(voter.address, subjectAmountStaked)
        await dpi.connect(voter.wallet).approve(dpiFarm.address, subjectAmountStaked)
        await dpiFarm.connect(voter.wallet).stake(subjectAmountStaked);
        await increaseTimeAsync(BigNumber.from(1000));
      });

      it("should count votes from unclaimed index", async () => {
        const votes = await subject();

        expect(votes).to.eq(subjectAmountRewards);
      })


    });
  });

});