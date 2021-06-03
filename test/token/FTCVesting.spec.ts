import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "@utils/types";
import { IndexToken, FTCVesting } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getRandomAccount,
  getWaffleExpect,
} from "@utils/index";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("FTCVesting", () => {
  let owner: Account;
  let treasury: Account;
  let recipient: Account;

  let deployer: DeployHelper;
  let index: IndexToken;

  before(async () => {
    [owner, treasury , recipient] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    index = await deployer.token.deployIndexToken(owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectVestingAmount: BigNumber;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now;
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectVestingAmount = ether(100);
    });

    async function subject(): Promise<FTCVesting> {
      return await deployer.token.deployFtcVesting(
        index.address,
        recipient.address,
        treasury.address,
        subjectVestingAmount,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
      );
    }

    it("should set the correct state variables", async () => {
      const ftcVest = await subject();

      expect(await ftcVest.recipient()).to.eq(recipient.address);
      expect(await ftcVest.treasury()).to.eq(treasury.address);
      expect(await ftcVest.vestingAmount()).to.eq(subjectVestingAmount);
      expect(await ftcVest.vestingBegin()).to.eq(subjectVestingStart);
      expect(await ftcVest.vestingEnd()).to.eq(subjectVestingEnd);
      expect(await ftcVest.vestingCliff()).to.eq(subjectVestingCliff);
      expect(await ftcVest.lastUpdate()).to.eq(subjectVestingStart);
    });
  });

  describe("#setRecipient", async () => {
    let subjectVestingAmount: BigNumber;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectFtcVesting: FTCVesting;
    let newRecipient: Account;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      newRecipient = await getRandomAccount();
      subjectVestingStart = now;
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectVestingAmount = ether(100);

      subjectFtcVesting = await deployer.token.deployFtcVesting(
        index.address,
        recipient.address,
        treasury.address,
        subjectVestingAmount,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
      );
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectFtcVesting.connect(recipient.wallet).setRecipient(newRecipient.address);
    }

    it("should set new recipient address", async () => {
      await subject();

      const newRecipientAddress = await subjectFtcVesting.recipient();

      expect(newRecipientAddress).to.eq(newRecipient.address);
    });
  });

  describe("#setTreasury", async () => {
    let subjectVestingAmount: BigNumber;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectFtcVesting: FTCVesting;
    let newTreasury: Account;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      newTreasury = await getRandomAccount();
      subjectVestingStart = now;
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectVestingAmount = ether(100);

      subjectFtcVesting = await deployer.token.deployFtcVesting(
        index.address,
        recipient.address,
        treasury.address,
        subjectVestingAmount,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
      );
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectFtcVesting.connect(treasury.wallet).setTreasury(newTreasury.address);
    }

    it("should set new treasury address", async () => {
      const currentTreasuryAddress = await subjectFtcVesting.treasury();

      expect(currentTreasuryAddress).to.eq(treasury.address);

      await subject();

      const newTreasuryAddress = await subjectFtcVesting.treasury();

      expect(newTreasuryAddress).to.eq(newTreasury.address);
    });
  });

  describe("#claim", async () => {
    let subjectVestingAmount: BigNumber;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectFtcVesting: FTCVesting;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now.sub(60 * 60 * 24 * 185);
      subjectVestingCliff = now;
      subjectVestingEnd = now.add(60 * 60 * 24 * 546);
      subjectVestingAmount = ether(1);

      subjectFtcVesting = await deployer.token.deployFtcVesting(
        index.address,
        recipient.address,
        treasury.address,
        subjectVestingAmount,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
      );

      await index.transfer(subjectFtcVesting.address, ether(1000));
    });

    async function subject(): Promise<ContractTransaction> {
      return await subjectFtcVesting.connect(recipient.wallet).claim();
    }

    it("should make a claim", async () => {
      const unclaimedAmount = await index.connect(recipient.wallet).balanceOf(recipient.address);
      const preClaimBalance = await index.balanceOf(subjectFtcVesting.address);
      await subject();
      const claimedAmount = await index.connect(recipient.wallet).balanceOf(recipient.address);
      const postClaimBalance = await index.balanceOf(subjectFtcVesting.address);

      const hasClaimed = claimedAmount.gt(unclaimedAmount);
      const hasLowerBalance = preClaimBalance.gt(postClaimBalance);

      expect(hasClaimed).to.be.true;
      expect(hasLowerBalance).to.be.true;
    });
  });

  describe("#clawback", async () => {
    let subjectVestingAmount: BigNumber;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectFtcVesting: FTCVesting;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now.sub(60 * 60 * 24 * 185);
      subjectVestingCliff = now;
      subjectVestingEnd = now.add(60 * 60 * 24 * 546);
      subjectVestingAmount = ether(1);

      subjectFtcVesting = await deployer.token.deployFtcVesting(
        index.address,
        recipient.address,
        treasury.address,
        subjectVestingAmount,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
      );

      await index.transfer(subjectFtcVesting.address, ether(1000));
    });

    async function subject(): Promise<ContractTransaction> {
      return await subjectFtcVesting.connect(treasury.wallet).clawback();
    }

    it("should clawback funds", async () => {
      const unclaimedAmount = await index.connect(treasury.wallet).balanceOf(treasury.address);
      await subject();

      const claimedAmount = await index.connect(treasury.wallet).balanceOf(treasury.address);
      const hasClaimed = claimedAmount.gt(unclaimedAmount);

      expect(hasClaimed).to.be.true;
    });

    it("should have no funds remaining in the contract", async () => {
      await subject();

      const remainingIndex = await index.balanceOf(subjectFtcVesting.address);

      expect(remainingIndex.isZero()).to.be.true;
    });
  });
});
