import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { NotionalTradeExtension, BaseManagerV2, NotionalTradeModuleMock } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getWaffleExpect,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("NotionalTradeExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;

  let setV2Setup: SetFixture;
  let notionalTradeModule: NotionalTradeModuleMock;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManagerV2;
  let extension: NotionalTradeExtension;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    notionalTradeModule = await deployer.mocks.deployNotionalTradeModuleMock();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(100)],
      [setV2Setup.airdropModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Issue some set tokens
    await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();

  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectNotionalTradeModule: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectNotionalTradeModule = notionalTradeModule.address;
    });

    async function subject(): Promise<NotionalTradeExtension> {
      return await deployer.extensions.deployNotionalTradeExtension(
        subjectManager,
        subjectNotionalTradeModule
      );
    }

    it("should set the correct set token address", async () => {
      const extension = await subject();

      const actualSetToken = await extension.setToken();
      expect(actualSetToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const extension = await subject();

      const manager = await extension.manager();
      expect(manager).to.eq(subjectManager);
    });

    it("should set the correct notional trade module address", async () => {
      const extension = await subject();

      const module = await extension.notionalTradeModule();
      expect(module).to.eq(subjectNotionalTradeModule);
    });
  });

  context("when notional trade extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      extension = await deployer.extensions.deployNotionalTradeExtension(
        baseManagerV2.address,
        notionalTradeModule.address,
      );

      await baseManagerV2.connect(operator.wallet).addExtension(extension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await extension.connect(subjectCaller.wallet).initialize();
      }

      it("should initialize NotionalTradeModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(notionalTradeModule.address);
        expect(isInitialized).to.be.true;
      });

      context("when the operator is not the caller", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});
