import "module-alias/register";

import { Address, Account } from "@utils/types";
import { FLIIssuanceHook } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getRandomAccount,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("FLIIssuanceHook", () => {
  let owner: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let issuanceHook: FLIIssuanceHook;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.debtIssuanceModule.address]
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSupplyCap: BigNumber;

    beforeEach(async () => {
      subjectSupplyCap = ether(10);
    });

    async function subject(): Promise<FLIIssuanceHook> {
      return await deployer.hooks.deployFLIIssuanceHook(subjectSupplyCap);
    }

    it("should set the correct SetToken address", async () => {
      const hook = await subject();

      const actualSupplyCap = await hook.fliSupplyCap();
      expect(actualSupplyCap).to.eq(subjectSupplyCap);
    });
  });

  describe("#invokePreIssueHook", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deployFLIIssuanceHook(ether(10));

      await setV2Setup.debtIssuanceModule.initialize(
        setToken.address,
        ether(.1),
        ether(.01),
        ether(.01),
        owner.address,
        issuanceHook.address
      );

      await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(100));

      subjectSetToken = setToken.address;
      subjectQuantity = ether(5);
      subjectTo = owner.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await setV2Setup.debtIssuanceModule.issue(
        subjectSetToken,
        subjectQuantity,
        subjectTo
      );
    }

    it("should not revert", async () => {
      await expect(subject()).to.not.be.reverted;
    });

    describe("when total issuance quantity forces supply over the limit", async () => {
      beforeEach(async () => {
        subjectQuantity = ether(11);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Supply cap exceeded");
      });
    });
  });

  describe("#updateSupplyCap", async () => {
    let subjectNewCap: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deployFLIIssuanceHook(ether(10));

      subjectNewCap = ether(20);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceHook.connect(subjectCaller.wallet).updateSupplyCap(subjectNewCap);
    }

    it("should update supply cap", async () => {
      await subject();

      const actualCap = await issuanceHook.fliSupplyCap();

      expect(actualCap).to.eq(subjectNewCap);
    });

    describe("when caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});