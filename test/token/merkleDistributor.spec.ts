import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account, DistributionFormat, MerkleDistributorInfo } from "@utils/types";
import { ZERO } from "@utils/constants";
import { IndexToken, MerkleDistributor } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  BalanceTree,
  ether,
  getAccounts,
  getWaffleExpect,
  parseBalanceMap,
} from "@utils/index";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("MerkleDistributor", () => {
  let owner: Account;
  let walletOne: Account;
  let walletTwo: Account;

  let deployer: DeployHelper;
  let token: IndexToken;
  let distributor: MerkleDistributor;

  before(async () => {
    [
      owner,
      walletOne,
      walletTwo,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    token = await deployer.token.deployIndexToken(owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectToken: Address;
    let subjectMerkleRoot: string;

    beforeEach(async () => {
      const tree = new BalanceTree([
        { account: walletOne.address, amount: ether(1000) },
        { account: walletTwo.address, amount: ether(900) },
      ]);

      subjectToken = token.address;
      subjectMerkleRoot = tree.getHexRoot();
    });

    async function subject(): Promise<MerkleDistributor> {
      return await deployer.token.deployMerkleDistributor(subjectToken, subjectMerkleRoot);
    }

    it("should set the correct token address", async () => {
      distributor = await subject();

      const actualToken = await distributor.token();
      expect (actualToken).to.eq(subjectToken);
    });

    it("should set the correct merkle root", async () => {
      distributor = await subject();

      const actualMerkleRoot = await distributor.merkleRoot();
      expect (actualMerkleRoot).to.eq(subjectMerkleRoot);
    });
  });

  describe("#isClaimed", async () => {
    let tree: BalanceTree;

    let subjectIndex: BigNumber;

    before(async () => {
      tree = new BalanceTree([
        { account: walletOne.address, amount: ether(1000) },
        { account: walletTwo.address, amount: ether(900) },
      ]);
    });

    beforeEach(async () => {
      distributor = await deployer.token.deployMerkleDistributor(token.address, tree.getHexRoot());
      await token.connect(owner.wallet).transfer(distributor.address, ether(1900));

      const proof = tree.getProof(ZERO, walletOne.address, ether(1000));
      await distributor.claim(ZERO, walletOne.address, ether(1000), proof);

      subjectIndex = ZERO;
    });

    async function subject(): Promise<boolean> {
      return await distributor.isClaimed(subjectIndex);
    }

    it("should return true", async () => {
      await subject();

      const isClaimed = await distributor.isClaimed(subjectIndex);
      expect(isClaimed).to.be.true;
    });

    describe("when tokens haven't been claimed", async () => {
      beforeEach(async () => {
        subjectIndex = BigNumber.from(1);
      });

      it("should revert", async () => {
        await subject();

        const isClaimed = await distributor.isClaimed(subjectIndex);
        expect(isClaimed).to.be.false;
      });
    });
  });

  describe("#claim", async () => {
    let treeInfo: MerkleDistributorInfo;

    let subjectIndex: BigNumber;
    let subjectAccount: Address;
    let subjectAmount: BigNumber;
    let subjectMerkleProof: string[];

    before(async () => {
      treeInfo = parseBalanceMap([
        { address: walletOne.address.toLowerCase(), earnings: ether(1000) } as DistributionFormat,
        { address: walletTwo.address.toLowerCase(), earnings: ether(900) } as DistributionFormat,
      ]);
    });

    beforeEach(async () => {
      distributor = await deployer.token.deployMerkleDistributor(token.address, treeInfo.merkleRoot);
      await token.connect(owner.wallet).transfer(distributor.address, ether(1900));

      subjectIndex = ZERO;
      subjectAccount = walletOne.address.toLowerCase();
      subjectAmount = ether(1000);
      subjectMerkleProof = treeInfo.claims[subjectAccount].proof;
    });

    async function subject(): Promise<ContractTransaction> {
      return await distributor.claim(subjectIndex, subjectAccount, subjectAmount, subjectMerkleProof);
    }

    it("should set the correct token address", async () => {
      const preTokenBalance = await token.balanceOf(subjectAccount);
      await subject();

      const postTokenBalance = await token.balanceOf(subjectAccount);
      expect(postTokenBalance).to.eq(preTokenBalance.add(subjectAmount));
    });

    it("should set isClaimed to true", async () => {
      await subject();

      const isClaimed = await distributor.isClaimed(subjectIndex);
      expect(isClaimed).to.be.true;
    });

    describe("when tokens have already been claimed", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MerkleDistributor: Drop already claimed.");
      });
    });

    describe("when submitted proof is invalid", async () => {
      beforeEach(async () => {
        subjectMerkleProof = treeInfo.claims[walletTwo.address.toLowerCase()].proof;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MerkleDistributor: Invalid proof.");
      });
    });
  });
});
