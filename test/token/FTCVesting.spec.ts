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
  increaseTimeAsync,
} from "@utils/index";
import { ContractTransaction } from "ethers";
import { ONE_YEAR_IN_SECONDS } from "@utils/constants";

const expect = getWaffleExpect();

describe("FTCVesting", () => {
  let owner: Account;
  let treasury: Account;
  let recipient: Account;

  let deployer: DeployHelper;
  let index: IndexToken;

  before(async () => {
    [owner, treasury, recipient] = await getAccounts();

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
      const initialAmount = await index.balanceOf(recipient.address);
      const amountInContract = await index.balanceOf(subjectFtcVesting.address);

      await subject();

      const claimedAmount = await index.balanceOf(recipient.address);
      const remainingInContract = await index.balanceOf(subjectFtcVesting.address);

      const userHasClaimedSome = claimedAmount.gt(initialAmount);
      const contractHasLowerBalance = amountInContract.gt(remainingInContract);

      expect(userHasClaimedSome).to.be.true;
      expect(contractHasLowerBalance).to.be.true;
    });

    it("should claim all after 2 years time", async () => {
      const amountInContract = await index.balanceOf(subjectFtcVesting.address);

      await increaseTimeAsync(ONE_YEAR_IN_SECONDS.mul(3));
      await subject();

      const remainingInContract = await index.balanceOf(subjectFtcVesting.address);
      const claimedByContributor = await index.balanceOf(recipient.address);
      const noIndexLeftInContract = remainingInContract.isZero();
      const allClaimedByContributor = claimedByContributor.eq(amountInContract);

      expect(noIndexLeftInContract).to.be.true;
      expect(allClaimedByContributor).to.be.true;
    });

    context("when the caller is unauthorized", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      async function subject(): Promise<ContractTransaction> {
        return await subjectFtcVesting.connect(subjectCaller.wallet).claim();
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("unauthorized");
      });
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

    it("should clawback remaining funds", async () => {
      const initAmountInContract = await index.balanceOf(subjectFtcVesting.address);
      await subject();

      const clawedBackAmount = await index.balanceOf(treasury.address);
      const balanceOfContract = await index.balanceOf(subjectFtcVesting.address);
      const hasSuccessfullyClawedBackAllFunds =
        initAmountInContract.eq(clawedBackAmount) && balanceOfContract.isZero();

      expect(hasSuccessfullyClawedBackAllFunds).to.be.true;
    });

    context("when the caller is unauthorized", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      async function subject(): Promise<ContractTransaction> {
        return await subjectFtcVesting.connect(subjectCaller.wallet).clawback();
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("unauthorized");
      });
    });
  });
});
