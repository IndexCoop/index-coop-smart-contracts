import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ONE, THREE, TWO, ZERO } from "@utils/constants";
import { PrtStakingPool, StandardTokenMock } from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getRandomAccount,
  getRandomAddress
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe.only("PrtStakingPool", () => {
  let owner: Account;
  let bob: Account;
  let alice: Account;
  let carol: Account;
  let feeSplitExtension: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;

  let setToken: StandardTokenMock;
  let prt: StandardTokenMock;
  let prtStakingPool: PrtStakingPool;

  before(async () => {
    [
      owner,
      bob,
      alice,
      carol,
      feeSplitExtension,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await deployer.mocks.deployStandardTokenMock(owner.address, 18);
    prt = await deployer.token.deployPrt(
        "PRT",
        "PRT",
        setToken.address,
        owner.address,
        ether(1000000)
    );

    prtStakingPool = await deployer.staking.deployPrtStakingPool(
      "PRT Staking Pool",
      "PRT-POOL",
      prt.address,
      feeSplitExtension.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectName: string;
    let subjectSymbol: string;
    let subjectSetToken: Address;
    let subjectPrt: Address;
    let subjectFeeSplitExtension: Address;

    beforeEach(async () => {
      subjectName = "PRT Staking Pool";
      subjectSymbol = "PRT-POOL";
      subjectSetToken = setToken.address;
      subjectPrt = prt.address;
      subjectFeeSplitExtension = setToken.address;
    });

    async function subject(): Promise<PrtStakingPool> {
      return await deployer.staking.deployPrtStakingPool(
        subjectName,
        subjectSymbol,
        subjectPrt,
        subjectFeeSplitExtension
      );
    }

    it("should set the correct name, symbol, and decimals", async () => {
      const retrievedPrtStakingPool = await subject();

      const actualName = await retrievedPrtStakingPool.name();
      expect(actualName).to.eq(subjectName);

      const actualSymbol = await retrievedPrtStakingPool.symbol();
      expect(actualSymbol).to.eq(subjectSymbol);

      const actualDecimals = await retrievedPrtStakingPool.decimals();
      expect(actualDecimals).to.eq(18);
    });

    it("should set the correct setToken address", async () => {
      const retrievedPrtStakingPool = await subject();

      const actualSetToken = await retrievedPrtStakingPool.setToken();
      expect(actualSetToken).to.eq(subjectSetToken);
    });

    it("should set the correct prt address", async () => {
      const retrievedPrtStakingPool = await subject();

      const actualPrt = await retrievedPrtStakingPool.prt();
      expect(actualPrt).to.eq(subjectPrt);
    });

    it("should set the correct FeeSplitExtension address", async () => {
      const retrievedPrtStakingPool = await subject();

      const actualFeeSplitExtension = await retrievedPrtStakingPool.feeSplitExtension();
      expect(actualFeeSplitExtension).to.eq(subjectFeeSplitExtension);
    });
  });

  describe("#setFeeSplitExtension", async () => {
    let subjectNewFeeSplitExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewFeeSplitExtension = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return prtStakingPool.connect(subjectCaller.wallet).setFeeSplitExtension(subjectNewFeeSplitExtension);
    }

    it("should set the new FeeSplitExtension", async () => {
      await subject();
      const actualFeeSplitExtension = await prtStakingPool.feeSplitExtension();
      expect(actualFeeSplitExtension).to.eq(subjectNewFeeSplitExtension);
    });

    it("should emit the correct FeeSplitExtensionChanged event", async () => {
      await expect(subject()).to.emit(prtStakingPool, "FeeSplitExtensionChanged").withArgs(subjectNewFeeSplitExtension);
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#stake", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      const amount = ether(1);

      await prt.connect(owner.wallet).transfer(bob.address, amount);
      await prt.connect(bob.wallet).approve(prtStakingPool.address, amount);

      subjectAmount = amount;
      subjectCaller = bob;
    });

    async function subject(): Promise<any> {
      return prtStakingPool.connect(subjectCaller.wallet).stake(subjectAmount);
    }

    it("should transfer PRTs from the staker to the PrtStakingPool", async () => {
      const poolPrtBalanceBefore = await prt.balanceOf(prtStakingPool.address);
      const holderPrtBalanceBefore = await prt.balanceOf(bob.address);

      await subject();

      const poolPrtBalanceAfter = await prt.balanceOf(prtStakingPool.address);
      const holderPrtBalanceAfter = await prt.balanceOf(bob.address);

      expect(poolPrtBalanceAfter).to.eq(poolPrtBalanceBefore.add(subjectAmount));
      expect(holderPrtBalanceAfter).to.eq(holderPrtBalanceBefore.sub(subjectAmount));
    });

    it("should mint StakedPRTs for the staker", async () => {
      const poolTotalSupplyBefore = await prtStakingPool.totalSupply();
      const holderStakedPrtBalanceBefore = await prtStakingPool.balanceOf(bob.address);

      await subject();

      const poolTotalSupplyAfter = await prtStakingPool.totalSupply();
      const holderStakedPrtBalanceAfter = await prtStakingPool.balanceOf(bob.address);

      expect(poolTotalSupplyAfter).to.eq(poolTotalSupplyBefore.add(subjectAmount));
      expect(holderStakedPrtBalanceAfter).to.eq(holderStakedPrtBalanceBefore.add(subjectAmount));
    });

    it("should emit the correct PRT Staking Pool Transfer event", async () => {
      await expect(subject()).to.emit(prtStakingPool, "Transfer").withArgs(ADDRESS_ZERO, bob.address, subjectAmount);
    });

    it("should be non-transferrable", async () => {
      await subject();

      await expect(
        prtStakingPool.connect(bob.wallet).transfer(owner.address, subjectAmount)
      ).to.be.revertedWith("Transfers not allowed");

      await prtStakingPool.connect(bob.wallet).approve(owner.address, subjectAmount);
      await expect(
        prtStakingPool.connect(bob.wallet).transferFrom(bob.address, owner.address, subjectAmount)
      ).to.be.revertedWith("Transfers not allowed");
    });

    describe("when the amount is 0", async () => {
      beforeEach(async () => {
        subjectAmount = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot stake 0");
      });
    });
  });

  describe("#unstake", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      const amount = ether(1);

      await prt.connect(owner.wallet).transfer(bob.address, amount);
      await prt.connect(bob.wallet).approve(prtStakingPool.address, amount);
      await prtStakingPool.connect(bob.wallet).stake(amount);

      subjectAmount = amount;
      subjectCaller = bob;
    });

    async function subject(): Promise<any> {
      return prtStakingPool.connect(subjectCaller.wallet).unstake(subjectAmount);
    }

    it("should transfer PRTs from the PrtStakingPool to the staker", async () => {
      const poolPrtBalanceBefore = await prt.balanceOf(prtStakingPool.address);
      const holderPrtBalanceBefore = await prt.balanceOf(bob.address);

      await subject();

      const poolPrtBalanceAfter = await prt.balanceOf(prtStakingPool.address);
      const holderPrtBalanceAfter = await prt.balanceOf(bob.address);

      expect(poolPrtBalanceAfter).to.eq(poolPrtBalanceBefore.sub(subjectAmount));
      expect(holderPrtBalanceAfter).to.eq(holderPrtBalanceBefore.add(subjectAmount));
    });

    it("should burn StakedPRTs from the staker", async () => {
      const poolTotalSupplyBefore = await prtStakingPool.totalSupply();
      const holderStakedPrtBalanceBefore = await prtStakingPool.balanceOf(bob.address);

      await subject();

      const poolTotalSupplyAfter = await prtStakingPool.totalSupply();
      const holderStakedPrtBalanceAfter = await prtStakingPool.balanceOf(bob.address);

      expect(poolTotalSupplyAfter).to.eq(poolTotalSupplyBefore.sub(subjectAmount));
      expect(holderStakedPrtBalanceAfter).to.eq(holderStakedPrtBalanceBefore.sub(subjectAmount));
    });

    it("should emit the correct PRT Staking Pool Transfer event", async () => {
      await expect(subject()).to.emit(prtStakingPool, "Transfer").withArgs(bob.address, ADDRESS_ZERO, subjectAmount);
    });

    describe("when the amount is 0", async () => {
      beforeEach(async () => {
        subjectAmount = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot unstake 0");
      });
    });
  });

  describe("#accrue", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      const amount = ether(1);

      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, amount);

      subjectAmount = amount;
      subjectCaller = feeSplitExtension;
    });

    async function subject(): Promise<any> {
      return prtStakingPool.connect(subjectCaller.wallet).accrue(subjectAmount);
    }

    it("should transfer setToken from the FeeSplitExtension to the PrtStakingPool", async () => {
      const poolSetTokenBalanceBefore = await setToken.balanceOf(prtStakingPool.address);
      const feeSplitExtensionSetTokenBalanceBefore = await setToken.balanceOf(feeSplitExtension.address);

      await subject();

      const poolSetTokenBalanceAfter = await setToken.balanceOf(prtStakingPool.address);
      const feeSplitExtensionSetTokenBalanceAfter = await setToken.balanceOf(feeSplitExtension.address);

      expect(poolSetTokenBalanceAfter).to.eq(poolSetTokenBalanceBefore.add(subjectAmount));
      expect(feeSplitExtensionSetTokenBalanceAfter).to.eq(feeSplitExtensionSetTokenBalanceBefore.sub(subjectAmount));
    });

    it("should push an accrue snapshot", async () => {
      const accrueSnapshotsBefore = await prtStakingPool.getAccrueSnapshots();

      await subject();

      const accrueSnapshotsAfter = await prtStakingPool.getAccrueSnapshots();

      expect(accrueSnapshotsAfter.length).to.eq(accrueSnapshotsBefore.length + 1);
      expect(accrueSnapshotsAfter[accrueSnapshotsAfter.length - 1]).to.eq(subjectAmount);
    });

    it("should emit the correct PRT Staking Pool Snapshot event", async () => {
      await expect(subject()).to.emit(prtStakingPool, "Snapshot").withArgs(1);
    });

    describe("when the amount is 0", async () => {
      beforeEach(async () => {
        subjectAmount = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot accrue 0");
      });
    });

    describe("when the caller is not the FeeSplitExtension", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be FeeSplitExtension");
      });
    });
  });

  describe("#claim", async () => {
    let bobPrtAmount: BigNumber;
    let alicePrtAmount: BigNumber;
    let carolPrtAmount: BigNumber;
    let snap1Amount: BigNumber;
    let snap2Amount: BigNumber;
    let snap3Amount: BigNumber;

    beforeEach(async () => {
      // PRT balances (bob: 6 PRT, alice: 4 PRT, carol: 5 PRT)
      bobPrtAmount = ether(6);
      alicePrtAmount = ether(4);
      carolPrtAmount = ether(5);

      // Snapshot rewards amounts (snap1: 1 SetToken, snap2: 1.5 SetToken, snap3: 2 SetToken)
      snap1Amount = ether(1);
      snap2Amount = ether(1.5);
      snap3Amount = ether(2);

      // Fund bob, alice, and carol with PRT
      await prt.connect(owner.wallet).transfer(bob.address, bobPrtAmount);
      await prt.connect(owner.wallet).transfer(alice.address, alicePrtAmount);
      await prt.connect(owner.wallet).transfer(carol.address, carolPrtAmount);

      // Approve staking pool to spend PRT
      await prt.connect(bob.wallet).approve(prtStakingPool.address, bobPrtAmount);
      await prt.connect(alice.wallet).approve(prtStakingPool.address, alicePrtAmount);
      await prt.connect(carol.wallet).approve(prtStakingPool.address, carolPrtAmount);

      // Before snapshot 1, bob stakes PRTs
      await prtStakingPool.connect(bob.wallet).stake(bobPrtAmount);

      // Take snapshot 1
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap1Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap1Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap1Amount);

      // After snapshot 1, alice stakes PRTs
      await prtStakingPool.connect(alice.wallet).stake(alicePrtAmount);

      // After snapshot 1, carol stakes PRTs
      await prtStakingPool.connect(carol.wallet).stake(carolPrtAmount);

      // Take snapshot 2
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap2Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap2Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap2Amount);

      // After snapshot 2, carol unstakes PRTs
      await prtStakingPool.connect(carol.wallet).unstake(carolPrtAmount);

      // Take snapshot 3
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap3Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap3Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap3Amount);
    });

    async function subject(caller: Account): Promise<any> {
      return prtStakingPool.connect(caller.wallet).claim();
    }

    it("should transfer the pending SetToken rewards from the PrtStakingPool to the staker", async () => {
      const prtStakingPoolSetTokenBalanceBefore = await setToken.balanceOf(prtStakingPool.address);
      const prtHolderOneSetTokenBalanceBefore = await setToken.balanceOf(bob.address);

      const totalSupplySnap2 = await prtStakingPool.totalSupplyAt(TWO);
      const totalSupplySnap3 = await prtStakingPool.totalSupplyAt(THREE);

      // (bob) who stakes before snapshot 1 and never unstakes
      const expectedBobPendingRewards = snap1Amount.add(
        bobPrtAmount.mul(snap2Amount).div(totalSupplySnap2)
      ).add(
        bobPrtAmount.mul(snap3Amount).div(totalSupplySnap3)
      );

      await subject(bob);

      const prtStakingPoolSetTokenBalanceAfter = await setToken.balanceOf(prtStakingPool.address);
      const prtHolderOneSetTokenBalanceAfter = await setToken.balanceOf(bob.address);

      expect(prtStakingPoolSetTokenBalanceAfter).to.eq(prtStakingPoolSetTokenBalanceBefore.sub(expectedBobPendingRewards));
      expect(prtHolderOneSetTokenBalanceAfter).to.eq(prtHolderOneSetTokenBalanceBefore.add(expectedBobPendingRewards));
    });

    it("should update the lastSnapshotId", async () => {
      const lastSnapshotIdBefore = await prtStakingPool.lastSnapshotId(bob.address);
      expect(lastSnapshotIdBefore).to.eq(0);

      await subject(bob);

      const lastSnapshotIdAfter = await prtStakingPool.lastSnapshotId(bob.address);
      expect(lastSnapshotIdAfter).to.eq(3);

      const currentId = await prtStakingPool.getCurrentId();
      expect(lastSnapshotIdAfter).to.eq(currentId);
    });

    describe("when the user stakes after the first snapshot", async () => {
      it("should still return pending rewards for staked snapshots", async () => {
        const totalSupplySnap2 = await prtStakingPool.totalSupplyAt(TWO);
        const totalSupplySnap3 = await prtStakingPool.totalSupplyAt(THREE);

        // (alice) who stakes after snapshot 1 and never unstakes
        const expectedAlicePendingRewards = (alicePrtAmount.mul(snap2Amount).div(totalSupplySnap2)).add(
          alicePrtAmount.mul(snap3Amount).div(totalSupplySnap3)
        );

        const aliceSetTokenBalanceBefore = await setToken.balanceOf(alice.address);
        await subject(alice);
        const aliceSetTokenBalanceAfter = await setToken.balanceOf(alice.address);
        const actualAliceSetTokenChange = aliceSetTokenBalanceAfter.sub(aliceSetTokenBalanceBefore);
        expect(actualAliceSetTokenChange).to.eq(expectedAlicePendingRewards);
      });
    });

    describe("when the user unstakes before the latest snapshot", async () => {
      it("should still return pending rewards for staked snapshots", async () => {
        const totalSupplySnap2 = await prtStakingPool.totalSupplyAt(TWO);

        // (carol) who stakes after snapshot 1 and unstakes after snapshot 2
        const expectedCarolPendingRewards = carolPrtAmount.mul(snap2Amount).div(totalSupplySnap2);

        const carolSetTokenBalanceBefore = await setToken.balanceOf(carol.address);
        await subject(carol);
        const carolSetTokenBalanceAfter = await setToken.balanceOf(carol.address);
        const actualCarolSetTokenChange = carolSetTokenBalanceAfter.sub(carolSetTokenBalanceBefore);
        expect(actualCarolSetTokenChange).to.eq(expectedCarolPendingRewards);
      });
    });

    describe("when there are no pending rewards", async () => {
      it("should revert", async () => {
        await expect(subject(owner)).to.be.revertedWith("No rewards to claim");
      });
    });

    describe("when the rewards have been claimed", async () => {
      beforeEach(async () => {
        await prtStakingPool.connect(bob.wallet).claim();
      });

      it("should return 0", async () => {
        await expect(subject(bob)).to.be.revertedWith("No rewards to claim");
      });
    });
  });

  describe("#transfer", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: Account;
    let subjectReceiver: Account;

    beforeEach(async () => {
      const amount = ether(1);

      await prt.connect(owner.wallet).transfer(bob.address, amount);
      await prt.connect(bob.wallet).approve(prtStakingPool.address, amount);
      await prtStakingPool.connect(bob.wallet).stake(amount);

      subjectAmount = amount;
      subjectCaller = bob;
      subjectReceiver = alice;
    });

    async function subject(): Promise<any> {
      return prtStakingPool.connect(subjectCaller.wallet).transfer(subjectReceiver.address, subjectAmount);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Transfers not allowed");
    });
  });

  describe("#transferFrom", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: Account;
    let subjectSender: Account;

    beforeEach(async () => {
      const amount = ether(1);

      await prt.connect(owner.wallet).transfer(bob.address, amount);
      await prt.connect(bob.wallet).approve(prtStakingPool.address, amount);
      await prtStakingPool.connect(bob.wallet).stake(amount);
      await prtStakingPool.connect(bob.wallet).approve(alice.address, amount);

      subjectAmount = amount;
      subjectCaller = alice;
      subjectSender = bob;
    });

    async function subject(): Promise<any> {
      return prtStakingPool.connect(subjectCaller.wallet).transferFrom(
        subjectSender.address,
        subjectCaller.address,
        subjectAmount
      );
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("Transfers not allowed");
    });
  });

  describe("#getSnapshotRewards", async () => {
    let bobPrtAmount: BigNumber;
    let alicePrtAmount: BigNumber;
    let snap1Amount: BigNumber;
    let snap2Amount: BigNumber;

    beforeEach(async () => {
      // PRT balances (bob: 6 PRT, alice: 4 PRT)
      bobPrtAmount = ether(6);
      alicePrtAmount = ether(4);

      // Snapshot rewards amounts
      snap1Amount = ether(1);
      snap2Amount = ether(2);

      // Fund bob, alice, and carol with PRT
      await prt.connect(owner.wallet).transfer(bob.address, bobPrtAmount);
      await prt.connect(owner.wallet).transfer(alice.address, alicePrtAmount);

      // Approve staking pool to spend PRT
      await prt.connect(bob.wallet).approve(prtStakingPool.address, bobPrtAmount);
      await prt.connect(alice.wallet).approve(prtStakingPool.address, alicePrtAmount);

      // Before snapshot 1, bob stakes PRTs
      await prtStakingPool.connect(bob.wallet).stake(bobPrtAmount);

      // Take snapshot 1
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap1Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap1Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap1Amount);

      // After snapshot 1, alice stakes PRTs
      await prtStakingPool.connect(alice.wallet).stake(alicePrtAmount);

      // Take snapshot 2
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap2Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap2Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap2Amount);
    });

    async function subject(snapshotId: BigNumber, account: Address): Promise<any> {
      return prtStakingPool.getSnapshotRewards(snapshotId, account);
    }

    describe("when the user deposits before the snapshot", async () => {
      it("should accrue proportional rewards", async () => {
        const snapshotRewards = await subject(ZERO, bob.address);

        expect(snapshotRewards).to.eq(snap1Amount);
      });
    });

    describe("when the user deposits after the snapshot", async () => {
      it("should not accrue rewards", async () => {
        const snapshotRewards = await subject(ZERO, alice.address);

        expect(snapshotRewards).to.eq(ZERO);
      });
    });

    describe("when multiple users deposit before the snapshot", async () => {
      it("should both accrue proportional rewards", async () => {
        const bobSnapshotRewards = await subject(ONE, bob.address);
        const aliceSnapshotRewards = await subject(ONE, alice.address);

        const totalPrtAmount = bobPrtAmount.add(alicePrtAmount);

        expect(bobSnapshotRewards).to.eq(bobPrtAmount.mul(snap2Amount).div(totalPrtAmount));
        expect(aliceSnapshotRewards).to.eq(alicePrtAmount.mul(snap2Amount).div(totalPrtAmount));
      });
    });
  });

  describe("#getPendingRewards", async () => {
    let bobPrtAmount: BigNumber;
    let alicePrtAmount: BigNumber;
    let carolPrtAmount: BigNumber;
    let snap1Amount: BigNumber;
    let snap2Amount: BigNumber;
    let snap3Amount: BigNumber;

    beforeEach(async () => {
      // PRT balances (bob: 6 PRT, alice: 4 PRT, carol: 5 PRT)
      bobPrtAmount = ether(6);
      alicePrtAmount = ether(4);
      carolPrtAmount = ether(5);

      // Snapshot rewards amounts (snap1: 1 SetToken, snap2: 1.5 SetToken, snap3: 2 SetToken)
      snap1Amount = ether(1);
      snap2Amount = ether(1.5);
      snap3Amount = ether(2);

      // Fund bob, alice, and carol with PRT
      await prt.connect(owner.wallet).transfer(bob.address, bobPrtAmount);
      await prt.connect(owner.wallet).transfer(alice.address, alicePrtAmount);
      await prt.connect(owner.wallet).transfer(carol.address, carolPrtAmount);

      // Approve staking pool to spend PRT
      await prt.connect(bob.wallet).approve(prtStakingPool.address, bobPrtAmount);
      await prt.connect(alice.wallet).approve(prtStakingPool.address, alicePrtAmount);
      await prt.connect(carol.wallet).approve(prtStakingPool.address, carolPrtAmount);

      // Before snapshot 1, bob stakes PRTs
      await prtStakingPool.connect(bob.wallet).stake(bobPrtAmount);

      // Take snapshot 1
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap1Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap1Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap1Amount);

      // After snapshot 1, alice stakes PRTs
      await prtStakingPool.connect(alice.wallet).stake(alicePrtAmount);

      // After snapshot 1, carol stakes PRTs
      await prtStakingPool.connect(carol.wallet).stake(carolPrtAmount);

      // Take snapshot 2
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap2Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap2Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap2Amount);

      // After snapshot 2, carol unstakes PRTs
      await prtStakingPool.connect(carol.wallet).unstake(carolPrtAmount);

      // Take snapshot 3
      await setToken.connect(owner.wallet).transfer(feeSplitExtension.address, snap3Amount);
      await setToken.connect(feeSplitExtension.wallet).approve(prtStakingPool.address, snap3Amount);
      await prtStakingPool.connect(feeSplitExtension.wallet).accrue(snap3Amount);
    });

    async function subject(account: Address): Promise<any> {
      return prtStakingPool.getPendingRewards(account);
    }

    it("should return the correct pending rewards", async () => {
      const bobPendingRewards = await subject(bob.address);
      const alicePendingRewards = await subject(alice.address);
      const carolPendingRewards = await subject(carol.address);

      const totalSupplySnap2 = await prtStakingPool.totalSupplyAt(TWO);
      const totalSupplySnap3 = await prtStakingPool.totalSupplyAt(THREE);

      // (bob) who stakes before snapshot 1 and never unstakes
      const expectedBobPendingRewards = snap1Amount.add(
        bobPrtAmount.mul(snap2Amount).div(totalSupplySnap2)
      ).add(
        bobPrtAmount.mul(snap3Amount).div(totalSupplySnap3)
      );

      // (alice) who stakes after snapshot 1 and never unstakes
      const expectedAlicePendingRewards = (alicePrtAmount.mul(snap2Amount).div(totalSupplySnap2)).add(
        alicePrtAmount.mul(snap3Amount).div(totalSupplySnap3)
      );

      // (carol) who stakes after snapshot 1 and unstakes after snapshot 2
      const expectedCarolPendingRewards = carolPrtAmount.mul(snap2Amount).div(totalSupplySnap2);

      expect(bobPendingRewards).to.eq(expectedBobPendingRewards);
      expect(alicePendingRewards).to.eq(expectedAlicePendingRewards);
      expect(carolPendingRewards).to.eq(expectedCarolPendingRewards);
    });

    describe("when the rewards have been claimed", async () => {
      beforeEach(async () => {
        await prtStakingPool.connect(bob.wallet).claim();
      });

      it("should return 0", async () => {
        const pendingRewards = await subject(bob.address);
        expect(pendingRewards).to.eq(ZERO);
      });
    });

    describe("when the user never staked", async () => {
      it("should return 0", async () => {
        const pendingRewards = await subject(await getRandomAddress());
        expect(pendingRewards).to.eq(ZERO);
      });
    });
  });
});
