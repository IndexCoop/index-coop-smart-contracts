import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Account } from "@utils/types";
import { IndexToken, OtcEscrow } from "@utils/contracts";
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
} from "@utils/index";
import { ContractTransaction } from "ethers";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { Vesting__factory } from "@typechain/factories/Vesting__factory";

const expect = getWaffleExpect();

describe("OtcEscrow", () => {
  let owner: Account;
  let indexGov: Account;
  let investor: Account;

  let deployer: DeployHelper;
  let index: IndexToken;
  let usdc: StandardTokenMock;

  before(async () => {
    [owner, indexGov, investor] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    index = await deployer.token.deployIndexToken(owner.address);
    await index.transfer(indexGov.address, ether(1000));
    usdc = await deployer.mocks.deployStandardTokenMock(owner.address, 6);
    await usdc.transfer(investor.address, BigNumber.from(1_000_000 * 10 ** 6));
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectUSDCAmount: BigNumber;
    let subjectIndexAmount: BigNumber;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now;
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectUSDCAmount = BigNumber.from(100_000 * 10 ** 6);
      subjectIndexAmount = ether(100);
    });

    async function subject(): Promise<OtcEscrow> {
      return await deployer.token.deployOtcEscrow(
        investor.address,
        indexGov.address,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
        subjectUSDCAmount,
        subjectIndexAmount,
        usdc.address,
        index.address,
      );
    }

    it("should set the correct state variables", async () => {
      const escrow = await subject();

      expect(await escrow.beneficiary()).to.eq(investor.address);
      expect(await escrow.indexGov()).to.eq(indexGov.address);
      expect(await escrow.vestingStart()).to.eq(subjectVestingStart);
      expect(await escrow.vestingCliff()).to.eq(subjectVestingCliff);
      expect(await escrow.vestingEnd()).to.eq(subjectVestingEnd);
      expect(await escrow.usdcAmount()).to.eq(subjectUSDCAmount);
      expect(await escrow.indexAmount()).to.eq(subjectIndexAmount);
      expect(await escrow.usdc()).to.eq(usdc.address);
      expect(await escrow.index()).to.eq(index.address);
    });
  });

  describe("#swap", async () => {
    let subjectOtcEscrow: OtcEscrow;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectUSDCAmount: BigNumber;
    let subjectIndexAmount: BigNumber;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now.add(10);
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectUSDCAmount = BigNumber.from(100_000 * 10 ** 6);
      subjectIndexAmount = ether(100);

      subjectOtcEscrow = await deployer.token.deployOtcEscrow(
        investor.address,
        indexGov.address,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
        subjectUSDCAmount,
        subjectIndexAmount,
        usdc.address,
        index.address,
      );

      await index.connect(indexGov.wallet).transfer(subjectOtcEscrow.address, subjectIndexAmount);
      await usdc.connect(investor.wallet).approve(subjectOtcEscrow.address, subjectUSDCAmount);
    });

    async function subject(): Promise<ContractTransaction> {
      return await subjectOtcEscrow.connect(indexGov.wallet).swap();
    }

    it("should send the investor's usdc to indexGov", async () => {
      const initInvestorUsdc = await usdc.balanceOf(investor.address);
      const initEscrowIndex = await index.balanceOf(subjectOtcEscrow.address);

      await subject();

      const finalInvestorUsdc = await usdc.balanceOf(investor.address);
      const finalEscrowIndex = await index.balanceOf(subjectOtcEscrow.address);

      expect(initEscrowIndex.sub(finalEscrowIndex)).to.eq(subjectIndexAmount);
      expect(initInvestorUsdc.sub(finalInvestorUsdc)).to.eq(subjectUSDCAmount);
    });

    it("it should emit a VestingDeployed event", async () => {
      await expect(subject()).to.emit(subjectOtcEscrow, "VestingDeployed");
    });

    it("it should transfer index to the vesting contract", async () => {
      await subject();

      const vestingDeployed = // tslint:disable-next-line:no-null-keyword
      (await subjectOtcEscrow.queryFilter(subjectOtcEscrow.filters.VestingDeployed(null)))[0];
      const vestingAddress = vestingDeployed.args?.vesting;

      expect(await index.balanceOf(vestingAddress)).to.eq(subjectIndexAmount);
    });

    it("it should set the state variables of the vesting contract correctly", async () => {
      await subject();

      const vestingDeployed = // tslint:disable-next-line:no-null-keyword
      (await subjectOtcEscrow.queryFilter(subjectOtcEscrow.filters.VestingDeployed(null)))[0];
      const vestingAddress = vestingDeployed.args?.vesting;

      const vesting = Vesting__factory.connect(vestingAddress, getProvider());

      expect(await vesting.index()).to.eq(index.address);
      expect(await vesting.recipient()).to.eq(investor.address);
      expect(await vesting.vestingAmount()).to.eq(subjectIndexAmount);
      expect(await vesting.vestingBegin()).to.eq(subjectVestingStart);
      expect(await vesting.vestingCliff()).to.eq(subjectVestingCliff);
      expect(await vesting.vestingEnd()).to.eq(subjectVestingEnd);
    });

    context("when the caller is the investor", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = investor;
      });

      async function subject(): Promise<ContractTransaction> {
        return await subjectOtcEscrow.connect(subjectCaller.wallet).swap();
      }

      it("should execute the swap", async () => {
        await expect(subject()).to.emit(subjectOtcEscrow, "VestingDeployed");
      });
    });

    context("when an inadequate amount of INDEX is sent to the escrow", async () => {
      beforeEach(async () => {
        subjectOtcEscrow = await deployer.token.deployOtcEscrow(
          investor.address,
          indexGov.address,
          subjectVestingStart,
          subjectVestingCliff,
          subjectVestingEnd,
          subjectUSDCAmount,
          subjectIndexAmount,
          usdc.address,
          index.address,
        );

        await index.connect(indexGov.wallet).transfer(subjectOtcEscrow.address, ether(50));
        await usdc.connect(investor.wallet).approve(subjectOtcEscrow.address, subjectUSDCAmount);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("insufficient INDEX");
      });
    });

    context("when the sender does not have enough USDC approved", async () => {
      beforeEach(async () => {
        await usdc.connect(investor.wallet).approve(subjectOtcEscrow.address, 0);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    context("when the sender does not have enough USDC", async () => {
      beforeEach(async () => {
        subjectOtcEscrow = await deployer.token.deployOtcEscrow(
          await getRandomAddress(),
          indexGov.address,
          subjectVestingStart,
          subjectVestingCliff,
          subjectVestingEnd,
          subjectUSDCAmount,
          subjectIndexAmount,
          usdc.address,
          index.address,
        );

        await index.connect(indexGov.wallet).transfer(subjectOtcEscrow.address, subjectIndexAmount);
        await usdc.connect(investor.wallet).approve(subjectOtcEscrow.address, subjectUSDCAmount);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    context("when swap is called for a second time", async () => {
      beforeEach(async () => {
        await subject();
      });

      async function subject(): Promise<ContractTransaction> {
        return await subjectOtcEscrow.swap();
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("swap already executed");
      });
    });
  });

  describe("#revoke", async () => {
    let subjectOtcEscrow: OtcEscrow;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectUSDCAmount: BigNumber;
    let subjectIndexAmount: BigNumber;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now.add(10);
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectUSDCAmount = BigNumber.from(100_000 * 10 ** 6);
      subjectIndexAmount = ether(100);

      subjectOtcEscrow = await deployer.token.deployOtcEscrow(
        investor.address,
        indexGov.address,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
        subjectUSDCAmount,
        subjectIndexAmount,
        usdc.address,
        index.address,
      );

      await index.connect(indexGov.wallet).transfer(subjectOtcEscrow.address, subjectIndexAmount);
      await usdc.connect(investor.wallet).approve(subjectOtcEscrow.address, subjectUSDCAmount);
    });

    async function subject(): Promise<ContractTransaction> {
      return await subjectOtcEscrow.connect(indexGov.wallet).revoke();
    }

    it("should return index when revoked", async () => {
      const initIndexBalance = await index.balanceOf(indexGov.address);
      await subject();
      const finalIndexBalance = await index.balanceOf(indexGov.address);

      expect(finalIndexBalance.sub(initIndexBalance)).to.eq(subjectIndexAmount);
    });

    context("when the caller is unauthorized", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      async function subject(): Promise<ContractTransaction> {
        return await subjectOtcEscrow.connect(subjectCaller.wallet).revoke();
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("unauthorized");
      });
    });
  });

  describe("#recoverUsdc", async () => {
    let subjectOtcEscrow: OtcEscrow;
    let subjectVestingStart: BigNumber;
    let subjectVestingCliff: BigNumber;
    let subjectVestingEnd: BigNumber;
    let subjectUSDCAmount: BigNumber;
    let subjectIndexAmount: BigNumber;

    beforeEach(async () => {
      const now = await getLastBlockTimestamp();
      subjectVestingStart = now.add(10);
      subjectVestingCliff = now.add(60 * 60 * 24 * 183);
      subjectVestingEnd = now.add(60 * 60 * 24 * 547);
      subjectUSDCAmount = BigNumber.from(100_000 * 10 ** 6);
      subjectIndexAmount = ether(100);

      subjectOtcEscrow = await deployer.token.deployOtcEscrow(
        investor.address,
        indexGov.address,
        subjectVestingStart,
        subjectVestingCliff,
        subjectVestingEnd,
        subjectUSDCAmount,
        subjectIndexAmount,
        usdc.address,
        index.address,
      );
    });

    async function subject(): Promise<ContractTransaction> {
      await usdc.connect(investor.wallet).transfer(subjectOtcEscrow.address, subjectUSDCAmount);
      return await subjectOtcEscrow.connect(indexGov.wallet).recoverUsdc();
    }

    it("it should return usdc to the investor", async () => {
      const initUsdcBalance = await usdc.balanceOf(investor.address);
      await subject();
      const finalUsdcBalance = await usdc.balanceOf(investor.address);

      expect(finalUsdcBalance).to.eq(initUsdcBalance);
    });
  });
});
