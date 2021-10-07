import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { IPRebalanceExtension, BaseManagerV2 } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAddress,
  getWaffleExpect,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("IPRebalanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManagerV2;
  let ipRebalanceExtension: IPRebalanceExtension;

  before(async () => {
    [
      owner,
      operator,
      methodologist,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();


    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(100)],
      [setV2Setup.generalIndexModule.address, setV2Setup.issuanceModule.address]
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
    await setToken.setManager(baseManagerV2.address);

    // Deploy IPRebalanceExtension
    ipRebalanceExtension = await deployer.extensions.deployIPRebalanceExtension(baseManagerV2.address, setV2Setup.generalIndexModule.address);
    baseManagerV2.connect(operator.wallet).addExtension(ipRebalanceExtension.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectGeneralIndexModule: Address;

    beforeEach(async () => {
      subjectManager = await getRandomAddress();
      subjectGeneralIndexModule = await getRandomAddress();
    });

    async function subject(): Promise<IPRebalanceExtension> {
      return await deployer.extensions.deployIPRebalanceExtension(subjectManager, subjectGeneralIndexModule);
    }

    it("should set the state variables", async () => {
      const extension = await subject();

      expect(await extension.manager()).to.eq(subjectManager);
      expect(await extension.generalIndexModule()).to.eq(subjectGeneralIndexModule);
    });
  });
});