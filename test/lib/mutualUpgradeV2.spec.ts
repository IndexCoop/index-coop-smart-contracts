import "module-alias/register";
import { solidityKeccak256 } from "ethers/lib/utils";
import { BigNumber } from "ethers";

import { Account } from "@utils/types";
import { ONE, ZERO } from "@utils/constants";
import { MutualUpgradeV2Mock } from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getRandomAccount,
} from "@utils/index";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("MutualUpgradeV2", () => {
  let owner: Account;
  let methodologist: Account;
  let deployer: DeployHelper;

  let mutualUpgradeV2Mock: MutualUpgradeV2Mock;

  before(async () => {
    [
      owner,
      methodologist,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    mutualUpgradeV2Mock = await deployer.mocks.deployMutualUpgradeV2Mock(owner.address, methodologist.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#testMutualUpgradeV2", async () => {
    let subjectTestUint: BigNumber;
    let subjectCaller: Account;
    let subjectMutualUpgradeV2Mock: MutualUpgradeV2Mock;

    beforeEach(async () => {
      subjectTestUint = ONE;
      subjectCaller = owner;
      subjectMutualUpgradeV2Mock = mutualUpgradeV2Mock;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectMutualUpgradeV2Mock.connect(subjectCaller.wallet).testMutualUpgrade(subjectTestUint);
    }

    describe("when the two mutual upgrade parties are the same", async () => {
      let trivialMutualUpgradeV2Mock: MutualUpgradeV2Mock;

      beforeEach(async () => {
        trivialMutualUpgradeV2Mock = await deployer.mocks.deployMutualUpgradeV2Mock(owner.address, owner.address);

        subjectMutualUpgradeV2Mock = trivialMutualUpgradeV2Mock;
      });

      it("should update the testUint", async () => {
        await subject();

        const currentTestUint = await trivialMutualUpgradeV2Mock.testUint();
        expect(currentTestUint).to.eq(subjectTestUint);
      });
    });

    describe("when the mutualUpgrade hash is not set", async () => {
      it("should register the initial mutual upgrade", async () => {
        const txHash = await subject();

        const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
        const isLogged = await mutualUpgradeV2Mock.mutualUpgrades(expectedHash);

        expect(isLogged).to.be.true;
      });

      it("should not update the testUint", async () => {
        await subject();

        const currentInt = await mutualUpgradeV2Mock.testUint();
        expect(currentInt).to.eq(ZERO);
      });

      it("emits a MutualUpgradeRegistered event", async () => {
        await expect(subject()).to.emit(mutualUpgradeV2Mock, "MutualUpgradeRegistered");
      });
    });

    describe("when the mutualUpgrade hash is set", async () => {
      beforeEach(async () => {
        await subject();
        subjectCaller = methodologist;
      });

      it("should clear the mutualUpgrade hash", async () => {
        const txHash = await subject();

        const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
        const isLogged = await mutualUpgradeV2Mock.mutualUpgrades(expectedHash);

        expect(isLogged).to.be.false;
      });

      it("should update the testUint", async () => {
        await subject();

        const currentTestUint = await mutualUpgradeV2Mock.testUint();
        expect(currentTestUint).to.eq(subjectTestUint);
      });

      describe("when the same address calls it twice", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should stay logged", async () => {
          const txHash = await subject();

          const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
          const isLogged = await mutualUpgradeV2Mock.mutualUpgrades(expectedHash);

          expect(isLogged).to.be.true;
        });

        it("should not change the integer value", async () => {
          await subject();

          const currentInt = await mutualUpgradeV2Mock.testUint();
          expect(currentInt).to.eq(ZERO);
        });
      });
    });

    describe("when the sender is not one of the allowed addresses", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });
});
