import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ZERO } from "@utils/constants";
import { SupplyCapAllowedCallerIssuanceHook } from "@utils/contracts/index";
import { ContractCallerMock, SetToken } from "@utils/contracts/setV2";
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

describe("SupplyCapAllowedCallerIssuanceHook", () => {
  let owner: Account;
  let hookOwner: Account;
  let otherAccount: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let issuanceHook: SupplyCapAllowedCallerIssuanceHook;

  before(async () => {
    [
      owner,
      hookOwner,
      otherAccount,
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
    let subjectOwner: Address;
    let subjectSupplyCap: BigNumber;

    beforeEach(async () => {
      subjectOwner = hookOwner.address;
      subjectSupplyCap = ether(10);
    });

    async function subject(): Promise<SupplyCapAllowedCallerIssuanceHook> {
      return await deployer.hooks.deploySupplyCapAllowedCallerIssuanceHook(subjectOwner, subjectSupplyCap);
    }

    it("should set the correct SetToken address", async () => {
      const hook = await subject();

      const actualSupplyCap = await hook.supplyCap();
      expect(actualSupplyCap).to.eq(subjectSupplyCap);
    });

    it("should set the correct owner address", async () => {
      const hook = await subject();

      const actualOwner = await hook.owner();
      expect(actualOwner).to.eq(subjectOwner);
    });
  });

  describe("#invokePreIssueHook", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deploySupplyCapAllowedCallerIssuanceHook(owner.address, ether(10));

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

    describe("when the sender is not EOA and on allowlist", async () => {
      let subjectTarget: Address;
      let subjectCallData: string;
      let subjectValue: BigNumber;

      let contractCaller: ContractCallerMock;

      beforeEach(async () => {
        contractCaller = await deployer.setV2.deployContractCallerMock();
        await issuanceHook.updateCallerStatus([contractCaller.address], [true]);

        await setV2Setup.dai.transfer(contractCaller.address, ether(50));
        // Approve token from contract caller to issuance module
        const approveData = setV2Setup.dai.interface.encodeFunctionData("approve", [
          setV2Setup.debtIssuanceModule.address,
          ether(100),
        ]);
        await contractCaller.invoke(setV2Setup.dai.address, ZERO, approveData);

        subjectSetToken = setToken.address;
        subjectQuantity = ether(5);
        subjectTo = owner.address;

        subjectTarget = setV2Setup.debtIssuanceModule.address;
        subjectCallData = setV2Setup.debtIssuanceModule.interface.encodeFunctionData("issue", [
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        ]);

        subjectValue = ZERO;
      });

      async function subjectContractCaller(): Promise<any> {
        return await contractCaller.invoke(
          subjectTarget,
          subjectValue,
          subjectCallData
        );
      }

      it("should not revert", async () => {
        await expect(subjectContractCaller()).to.not.be.reverted;
      });

      describe("when the caller is not on allowlist", async () => {
        beforeEach(async () => {
          await issuanceHook.updateCallerStatus([contractCaller.address], [false]);
        });

        it("should revert", async () => {
          await expect(subjectContractCaller()).to.be.revertedWith("Contract not permitted to call");
        });

        describe("when anyoneCallable is flipped to true", async () => {
          beforeEach(async () => {
            await issuanceHook.updateAnyoneCallable(true);
          });

          it("should succeed without revert", async () => {
            await subjectContractCaller();
          });
        });
      });
    });
  });

  describe("#updateSupplyCap", async () => {
    let subjectNewCap: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deploySupplyCapAllowedCallerIssuanceHook(owner.address, ether(10));

      subjectNewCap = ether(20);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceHook.connect(subjectCaller.wallet).updateSupplyCap(subjectNewCap);
    }

    it("should update supply cap", async () => {
      await subject();

      const actualCap = await issuanceHook.supplyCap();

      expect(actualCap).to.eq(subjectNewCap);
    });

    it("should emit the correct SupplyCapUpdated event", async () => {
      await expect(subject()).to.emit(issuanceHook, "SupplyCapUpdated").withArgs(subjectNewCap);
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

  describe("#updateCallerStatus", async () => {
    let subjectFunctionCallers: Address[];
    let subjectStatuses: boolean[];
    let subjectCaller: Account;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deploySupplyCapAllowedCallerIssuanceHook(owner.address, ether(10));

      subjectFunctionCallers = [otherAccount.address];
      subjectStatuses = [true];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return issuanceHook.connect(subjectCaller.wallet).updateCallerStatus(subjectFunctionCallers, subjectStatuses);
    }

    it("should update the callAllowList", async () => {
      await subject();
      const callerStatus = await issuanceHook.callAllowList(subjectFunctionCallers[0]);
      expect(callerStatus).to.be.true;
    });

    it("should emit CallerStatusUpdated event", async () => {
      await expect(subject()).to.emit(issuanceHook, "CallerStatusUpdated").withArgs(
        subjectFunctionCallers[0],
        subjectStatuses[0]
      );
    });

    describe("when the sender is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateAnyoneCallable", async () => {
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      issuanceHook = await deployer.hooks.deploySupplyCapAllowedCallerIssuanceHook(owner.address, ether(10));

      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return issuanceHook.connect(subjectCaller.wallet).updateAnyoneCallable(subjectStatus);
    }

    it("should update the anyoneCallable boolean", async () => {
      await subject();
      const callerStatus = await issuanceHook.anyoneCallable();
      expect(callerStatus).to.be.true;
    });

    it("should emit AnyoneCallableUpdated event", async () => {
      await expect(subject()).to.emit(issuanceHook, "AnyoneCallableUpdated").withArgs(
        subjectStatus
      );
    });

    describe("when the sender is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});