import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "@utils/types";
import { IndexToken, FTCVesting } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
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
    owner = await getRandomAccount();
    treasury = await getRandomAccount();
    recipient = await getRandomAccount();

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

  xdescribe("#setRecipient", async () => {
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

    it("should set new recipient", async () => {
      const currentRecipientAddress = await subjectFtcVesting.recipient();

      expect(currentRecipientAddress).to.eq(recipient.address);

      await subject();

      const newRecipientAddress = subjectFtcVesting.recipient();

      expect(newRecipientAddress).to.eq(newRecipient.address);
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
      subjectVestingAmount = (await index.totalSupply()).div(10);

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
      return await subjectFtcVesting.connect(recipient.wallet).claim();
    }

    it("should set new recipient", async () => {
      const beforeIndexAmount = await index.connect(recipient.wallet).balanceOf(recipient.address);

      await subject();

      const afterIndexAmount = await index.connect(recipient.wallet).balanceOf(recipient.address);

      expect(beforeIndexAmount).to.be.lessThan(afterIndexAmount);
    });
  });
});
