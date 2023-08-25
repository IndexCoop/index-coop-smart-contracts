import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, MODULE_STATE } from "@utils/constants";
import { ProtocolUtils } from "@utils/common";
import {
  DelegatedManagerFactory,
  DelegatedManager,
  BaseGlobalExtensionMock,
  ManagerCore,
  ModuleMock,
} from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getRandomAccount,
  getProtocolUtils,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { SetToken } from "@utils/contracts/setV2";


const expect = getWaffleExpect();

describe("DelegatedManagerFactory", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let operatorOne: Account;
  let operatorTwo: Account;
  let EOAManagedSetToken: SetToken;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let protocolUtils: ProtocolUtils;

  let managerCore: ManagerCore;
  let delegatedManagerFactory: DelegatedManagerFactory;
  let mockFeeExtension: BaseGlobalExtensionMock;
  let mockIssuanceExtension: BaseGlobalExtensionMock;
  let mockFeeModule: ModuleMock;
  let mockIssuanceModule: ModuleMock;

  cacheBeforeEach(async () => {
    [
      owner,
      otherAccount,
      methodologist,
      operatorOne,
      operatorTwo,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    protocolUtils = getProtocolUtils();

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    mockFeeModule = await deployer.mocks.deployModuleMock(setV2Setup.controller.address);
    mockIssuanceModule = await deployer.mocks.deployModuleMock(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(mockFeeModule.address);
    await setV2Setup.controller.addModule(mockIssuanceModule.address);

    managerCore = await deployer.managerCore.deployManagerCore();

    mockFeeExtension = await deployer.mocks.deployBaseGlobalExtensionMock(managerCore.address, mockFeeModule.address);
    mockIssuanceExtension = await deployer.mocks.deployBaseGlobalExtensionMock(managerCore.address, mockIssuanceModule.address);

    delegatedManagerFactory = await deployer.factories.deployDelegatedManagerFactory(
      managerCore.address,
      setV2Setup.controller.address,
      setV2Setup.factory.address
    );

    await managerCore.initialize(
      [mockFeeExtension.address, mockIssuanceExtension.address],
      [delegatedManagerFactory.address]
    );
  });

  // Helper function to run a setup execution of either `createSetAndManager` or `createManager`
  async function create(existingSetToken?: Address): Promise<ContractTransaction> {
    const tokens = [setV2Setup.dai.address, setV2Setup.wbtc.address];
    const operators = [operatorOne.address, operatorTwo.address];
    const otherAccountAddress = otherAccount.address;
    const methodologistAddress = methodologist.address;
    const modules = [mockFeeModule.address, mockIssuanceModule.address];
    const extensions = [mockFeeExtension.address, mockIssuanceExtension.address];

    if (existingSetToken === undefined) {
      return await delegatedManagerFactory.createSetAndManager(
        tokens,
        [ether(1), ether(.1)],
        "TestToken",
        "TT",
        otherAccountAddress,
        methodologistAddress,
        modules,
        operators,
        tokens,
        extensions
      );
    }

    return await delegatedManagerFactory.createManager(
      existingSetToken as string,
      otherAccountAddress,
      methodologistAddress,
      operators,
      tokens,
      extensions
    );
  }

  // Helper function to generate bytecode packets for factory initialization call
  async function generateBytecode(manager: Address, modulesInitialized: Boolean): Promise<string[]> {
    if (modulesInitialized) {
      const feeExtensionBytecode = mockFeeExtension.interface.encodeFunctionData("initializeExtension", [
        manager,
      ]);

      const issuanceExtensionBytecode = mockIssuanceExtension.interface.encodeFunctionData("initializeExtension", [
        manager,
      ]);

      return [feeExtensionBytecode, issuanceExtensionBytecode];
    } else {
      const feeExtensionBytecode = mockFeeExtension.interface.encodeFunctionData("initializeModuleAndExtension", [
        manager,
      ]);

      const issuanceExtensionBytecode = mockIssuanceExtension.interface.encodeFunctionData("initializeModuleAndExtension", [
        manager,
      ]);

      return [feeExtensionBytecode, issuanceExtensionBytecode];
    }
  }

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectController: Address;
    let subjectSetTokenFactory: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectController = setV2Setup.controller.address;
      subjectSetTokenFactory = setV2Setup.factory.address;
    });

    async function subject(): Promise<DelegatedManagerFactory> {
      return await deployer.factories.deployDelegatedManagerFactory(
        subjectManagerCore,
        subjectController,
        subjectSetTokenFactory
      );
    }

    it("should set the correct ManagerCore address", async () => {
      const delegatedManager = await subject();

      const actualManagerCore = await delegatedManager.managerCore();
      expect (actualManagerCore).to.eq(subjectManagerCore);
    });

    it("should set the correct Controller address", async () => {
      const delegatedManager = await subject();

      const actualController = await delegatedManager.controller();
      expect (actualController).to.eq(subjectController);
    });

    it("should set the correct SetToken factory address", async () => {
      const delegatedManager = await subject();

      const actualFactory = await delegatedManager.setTokenFactory();
      expect (actualFactory).to.eq(subjectSetTokenFactory);
    });
  });

  describe("#createSetAndManager", () => {
    let subjectComponents: Address[];
    let subjectUnits: BigNumber[];
    let subjectName: string;
    let subjectSymbol: string;
    let subjectOwner: Address;
    let subjectMethodologist: Address;
    let subjectModules: Address[];
    let subjectOperators: Address[];
    let subjectAssets: Address[];
    let subjectExtensions: Address[];

    beforeEach(() => {
      subjectComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address],
      subjectUnits = [ether(1), ether(.1)];
      subjectName = "TestToken";
      subjectSymbol = "TT";
      subjectOwner = otherAccount.address;
      subjectMethodologist = methodologist.address;
      subjectModules = [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address];
      subjectOperators = [operatorOne.address, operatorTwo.address];
      subjectAssets = [setV2Setup.dai.address, setV2Setup.wbtc.address];
      subjectExtensions = [mockIssuanceExtension.address, mockFeeExtension.address];
    });

    async function subject(): Promise<ContractTransaction> {
      return await delegatedManagerFactory.createSetAndManager(
        subjectComponents,
        subjectUnits,
        subjectName,
        subjectSymbol,
        subjectOwner,
        subjectMethodologist,
        subjectModules,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );
    }

    it("should configure the SetToken correctly", async() => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const setToken = await deployer.setV2.getSetToken(setTokenAddress);

      expect(await setToken.getComponents()).deep.eq(subjectComponents);
      expect(await setToken.name()).eq(subjectName);
      expect(await setToken.symbol()).eq(subjectSymbol);
    });

    it("should set the manager factory as the SetToken manager", async() => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const setToken = await deployer.setV2.getSetToken(setTokenAddress);

      expect(await setToken.manager()).eq(delegatedManagerFactory.address);
    });

    it("should configure the DelegatedManager correctly", async () => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

      expect(await delegatedManager.setToken()).eq(setTokenAddress);
      expect(await delegatedManager.factory()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.methodologist()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.useAssetAllowlist()).eq(true);
    });

    it("should enable the manager on the ManagerCore", async () => {
      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);
      const isDelegatedManagerEnabled = await managerCore.isManager(delegatedManager.address);
      expect(isDelegatedManagerEnabled).to.eq(true);
    });

    it("should set the intialization state correctly", async() => {
      const createdContracts = await delegatedManagerFactory.callStatic.createSetAndManager(
        subjectComponents,
        subjectUnits,
        subjectName,
        subjectSymbol,
        subjectOwner,
        subjectMethodologist,
        subjectModules,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );

      const tx = await subject();

      const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
      const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

      expect(initializeParams.deployer).eq(owner.address);
      expect(initializeParams.owner).eq(subjectOwner);
      expect(initializeParams.methodologist).eq(subjectMethodologist);
      expect(initializeParams.isPending).eq(true);
      expect(initializeParams.manager).eq(createdContracts[1]);
    });

    it("should emit a DelegatedManagerDeployed event", async() => {
      const createdContracts = await delegatedManagerFactory.callStatic.createSetAndManager(
        subjectComponents,
        subjectUnits,
        subjectName,
        subjectSymbol,
        subjectOwner,
        subjectMethodologist,
        subjectModules,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );

      await expect(subject()).to.emit(delegatedManagerFactory, "DelegatedManagerCreated").withArgs(
        createdContracts[0], // SetToken
        createdContracts[1], // DelegatedManager
        owner.address
      );
    });

    describe("when the assets array is non-empty but missing some component elements", async() => {
      beforeEach(async() => {
        subjectAssets = [setV2Setup.dai.address];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Asset list must include all components");
      });
    });

    describe("when the assets array is empty", async() => {
      beforeEach(() => {
        subjectAssets = [];
      });

      it("should set the intialization state correctly", async() => {
        const tx = await subject();

        const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
        const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

        expect(initializeParams.isPending).eq(true);
      });

      it("should set the DelegatedManager's useAssetAllowlist to false", async () => {
        const tx = await subject();

        const setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
        const initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);
        const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

        expect(await delegatedManager.useAssetAllowlist()).eq(false);
      });
    });

    describe("when the extensions array is empty", async() => {
      beforeEach(async() => {
        subjectExtensions = [];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Must have at least 1 extension");
      });
    });

    describe("when the factory is not approved on the ManagerCore", async() => {
      beforeEach(async() => {
        await managerCore.removeFactory(delegatedManagerFactory.address);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Only valid factories can call");
      });
    });
  });

  describe("#createManager", () => {
    let subjectCaller: Account;
    let subjectSetToken: Address;
    let subjectOwner: Address;
    let subjectMethodologist: Address;
    let subjectOperators: Address[];
    let subjectAssets: Address[];
    let subjectExtensions: Address[];

    let components: Address[];
    let units: BigNumber[];
    let modules: Address[];

    cacheBeforeEach(async() => {
      components = [setV2Setup.dai.address];
      units = [ether(1)];
      modules = [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address];

      // Deploy EOA managed SetToken
      EOAManagedSetToken = await setV2Setup.createSetToken(
        components,
        units,
        modules
      );

      // Initialize modules
      await setV2Setup.issuanceModule.initialize(EOAManagedSetToken.address, ADDRESS_ZERO);

      const streamingFeeSettings = {
        feeRecipient: owner.address,
        maxStreamingFeePercentage: ether(.05),
        streamingFeePercentage: ether(.02),
        lastStreamingFeeTimestamp: ZERO,
      };

      await setV2Setup.streamingFeeModule.initialize(
        EOAManagedSetToken.address,
        streamingFeeSettings
      );

      // Set subject variables
      subjectSetToken = EOAManagedSetToken.address;
      subjectOwner = otherAccount.address;
      subjectMethodologist = methodologist.address;
      subjectOperators = [operatorOne.address, operatorTwo.address];
      subjectAssets = [setV2Setup.dai.address, setV2Setup.wbtc.address];
      subjectExtensions = [mockIssuanceExtension.address, mockFeeExtension.address];
    });

    beforeEach(() => {
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return delegatedManagerFactory.connect(subjectCaller.wallet).createManager(
        subjectSetToken,
        subjectOwner,
        subjectMethodologist,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );
    }

    it("should configure the DelegatedManager correctly", async () => {
      await subject();

      const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);
      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

      expect(await delegatedManager.setToken()).eq(subjectSetToken);
      expect(await delegatedManager.factory()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.methodologist()).eq(delegatedManagerFactory.address);
      expect(await delegatedManager.useAssetAllowlist()).eq(true);
    });

    it("should set the intialization state correctly", async() => {
      const newManagerAddress = await delegatedManagerFactory.callStatic.createManager(
        subjectSetToken,
        subjectOwner,
        subjectMethodologist,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );

      await subject();

      const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);

      expect(initializeParams.deployer).eq(owner.address);
      expect(initializeParams.owner).eq(subjectOwner);
      expect(initializeParams.methodologist).eq(subjectMethodologist);
      expect(initializeParams.isPending).eq(true);
      expect(initializeParams.manager).eq(newManagerAddress);
    });

    it("should enable the manager on the ManagerCore", async () => {
      await subject();

      const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);

      const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);
      const isDelegatedManagerEnabled = await managerCore.isManager(delegatedManager.address);
      expect(isDelegatedManagerEnabled).to.eq(true);
    });

    it("should emit a DelegatedManagerDeployed event", async() => {
      const managerAddress = await delegatedManagerFactory.callStatic.createManager(
        subjectSetToken,
        subjectOwner,
        subjectMethodologist,
        subjectOperators,
        subjectAssets,
        subjectExtensions
      );

      await expect(subject()).to.emit(delegatedManagerFactory, "DelegatedManagerCreated").withArgs(
        subjectSetToken,
        managerAddress,
        owner.address
      );
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(() => {
        subjectCaller = otherAccount;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be manager");
      });
    });

    describe("when the assets array is non-empty but missing some component elements", async() => {
      beforeEach(async() => {
        subjectAssets = [setV2Setup.wbtc.address];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Asset list must include all components");
      });
    });

    describe("when the assets array is empty", async() => {
      beforeEach(() => {
        subjectAssets = [];
      });

      it("should set the intialization state correctly", async() => {
        await subject();

        const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);

        expect(initializeParams.isPending).eq(true);
      });

      it("should set the DelegatedManager's useAssetAllowlist to false", async () => {
        await subject();

        const initializeParams = await delegatedManagerFactory.initializeState(subjectSetToken);
        const delegatedManager = await deployer.manager.getDelegatedManager(initializeParams.manager);

        expect(await delegatedManager.useAssetAllowlist()).eq(false);
      });
    });

    describe("when the factory is not approved on the ManagerCore", async() => {
      beforeEach(async() => {
        await managerCore.removeFactory(delegatedManagerFactory.address);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Only valid factories can call");
      });
    });

    describe("when the extensions array is empty", async() => {
      beforeEach(async() => {
        subjectExtensions = [];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Must have at least 1 extension");
      });
    });

    describe("when the SetToken is not controller-enabled", async () => {
      beforeEach(() => {
        subjectSetToken = otherAccount.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  describe("#initialize", () => {
    let manager: DelegatedManager;
    let initializeParams: any;
    let setToken: SetToken;
    let setTokenAddress: Address;

    let subjectCaller: Account;
    let subjectSetToken: Address;
    let subjectOwnerFeeSplit: BigNumber;
    let subjectOwnerFeeRecipient: Address;
    let subjectExtensions: Address[];
    let subjectInitializeBytecode: string[];

    beforeEach(() => {
      subjectCaller = owner;
      subjectOwnerFeeSplit = ether(.5);
      subjectOwnerFeeRecipient = otherAccount.address;
      subjectExtensions = [mockFeeExtension.address, mockIssuanceExtension.address];
    });

    async function subject(): Promise<ContractTransaction> {
      return await delegatedManagerFactory.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectOwnerFeeSplit,
        subjectOwnerFeeRecipient,
        subjectExtensions,
        subjectInitializeBytecode
      );
    }

    describe("when the SetToken was created by the factory", () => {
      cacheBeforeEach(async () => {
        const tx = await create();

        setTokenAddress = await protocolUtils.getCreatedSetTokenAddress(tx.hash);
        initializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);
        manager = await deployer.manager.getDelegatedManager(initializeParams.manager);
        setToken = await deployer.setV2.getSetToken(setTokenAddress);

        subjectSetToken = setTokenAddress;
      });

      beforeEach(async () => {
        subjectInitializeBytecode = await generateBytecode(initializeParams.manager, false);
      });

      it("should initialize the modules", async() => {
        await subject();

        expect(await setToken.moduleStates(mockFeeModule.address)).eq(MODULE_STATE.INITIALIZED);
        expect(await setToken.moduleStates(mockIssuanceModule.address)).eq(MODULE_STATE.INITIALIZED);
      });

      it("should initialize the extensions", async() => {
        await subject();

        expect(await manager.isInitializedExtension(mockFeeExtension.address)).eq(true);
        expect(await manager.isInitializedExtension(mockIssuanceExtension.address)).eq(true);
      });

      it("should set the ownerFeeSplit on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeSplit()).eq(subjectOwnerFeeSplit);
      });

      it("should set the ownerFeeRecipient on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeRecipient()).eq(subjectOwnerFeeRecipient);
      });

      it("should set the SetToken's manager to the `manager` specified initializeParams", async () => {
        const oldManager = await setToken.manager();

        await subject();

        const newManager = await setToken.manager();

        expect(newManager).not.eq(oldManager);
        expect(newManager).eq(initializeParams.manager);
      });

      it("should transfer ownership of DelegatedManager to the `owner` specified initializeState", async () => {
        const oldOwner = await manager.owner();

        await subject();

        const newOwner = await manager.owner();

        expect(oldOwner).not.eq(newOwner);
        expect(newOwner).eq(initializeParams.owner);
      });

      it("should transfer the methodologist role of DelegatedManager to the `methodologist` specified initializeState", async () => {
        const oldMethodologist = await manager.methodologist();

        await subject();

        const newMethodologist = await manager.methodologist();

        expect(oldMethodologist).not.eq(newMethodologist);
        expect(newMethodologist).eq(initializeParams.methodologist);
      });

      it("should delete the initializeState for the SetToken", async () => {
        await subject();

        const finalInitializeParams = await delegatedManagerFactory.initializeState(setTokenAddress);

        expect(finalInitializeParams.deployer).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.owner).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.methodologist).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.manager).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.isPending).eq(false);
      });

      it("should emit a DelegatedManagerInitialized event", async() => {
        await expect(subject()).to.emit(delegatedManagerFactory, "DelegatedManagerInitialized").withArgs(
          subjectSetToken,
          initializeParams.manager
        );
      });
    });

    describe("when a SetToken is being migrated to a DelegatedManager", async () => {
      cacheBeforeEach(async () => {
        setToken = await setV2Setup.createSetToken(
          [setV2Setup.dai.address],
          [ether(1)],
          [mockFeeModule.address, mockIssuanceModule.address]
        );

        await create(setToken.address);

        initializeParams = await delegatedManagerFactory.initializeState(setToken.address);
        manager = await deployer.manager.getDelegatedManager(initializeParams.manager);

        subjectSetToken = setToken.address;
      });

      beforeEach(async () => {
        subjectInitializeBytecode = await generateBytecode(initializeParams.manager, true);
      });

      it("should initialize the extensions", async() => {
        await subject();

        expect(await manager.isInitializedExtension(mockFeeExtension.address)).eq(true);
        expect(await manager.isInitializedExtension(mockIssuanceExtension.address)).eq(true);
      });

      it("should set the ownerFeeSplit on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeSplit()).eq(subjectOwnerFeeSplit);
      });

      it("should set the ownerFeeRecipient on the DelegatedManager", async() => {
        await subject();

        expect(await manager.ownerFeeRecipient()).eq(subjectOwnerFeeRecipient);
      });

      it("should NOT set the SetToken's manager", async () => {
        const oldManager = await setToken.manager();

        await subject();

        const newManager = await setToken.manager();

        expect(newManager).eq(oldManager);
      });

      it("should transfer ownership of DelegateManager to the `owner` specified initializeState", async () => {
        const oldOwner = await manager.owner();

        await subject();

        const newOwner = await manager.owner();

        expect(oldOwner).not.eq(newOwner);
        expect(newOwner).eq(initializeParams.owner);
      });

      it("should transfer the methodologist role of DelegatedManager to the `methodologist` specified initializeState", async () => {
        const oldMethodologist = await manager.methodologist();

        await subject();

        const newMethodologist = await manager.methodologist();

        expect(oldMethodologist).not.eq(newMethodologist);
        expect(newMethodologist).eq(initializeParams.methodologist);
      });

      it("should delete the initializeState for the SetToken", async () => {
        await subject();

        const finalInitializeParams = await delegatedManagerFactory.initializeState(setToken.address);

        expect(finalInitializeParams.deployer).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.owner).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.methodologist).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.manager).eq(ADDRESS_ZERO);
        expect(finalInitializeParams.isPending).eq(false);
      });

      describe("when the caller tries to initializeModuleAndExtension", async() => {
        beforeEach(async () => {
          subjectInitializeBytecode = await generateBytecode(initializeParams.manager, false);
        });

        it("should revert", async() => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when the initialization state is not pending", async() => {
      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Manager must be awaiting initialization");
      });
    });

    describe("when the factory is not approved by the ManagerCore", async() => {
      beforeEach(async () => {
        await create();

        await managerCore.connect(owner.wallet).removeManager(manager.address);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });

    describe("when an input Extension is not approved by the ManagerCore", async() => {
      let mockUnapprovedExtension: BaseGlobalExtensionMock;

      beforeEach(async () => {
        await create();

        mockUnapprovedExtension = await deployer.mocks.deployBaseGlobalExtensionMock(managerCore.address, mockFeeModule.address);
        subjectExtensions = [mockUnapprovedExtension.address];

        subjectInitializeBytecode = [mockUnapprovedExtension.interface.encodeFunctionData(
          "initializeExtension",
          [manager.address]
        )];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Target must be ManagerCore-enabled Extension");
      });
    });

    describe("when an initializeBytecode targets the wrong DelegatedManager", async() => {
      let otherDelegatedManager: Account;

      beforeEach(async () => {
        await create();
        otherDelegatedManager = await getRandomAccount();

        subjectExtensions = [mockFeeExtension.address];
        subjectInitializeBytecode = [mockFeeExtension.interface.encodeFunctionData(
          "initializeExtension",
          [otherDelegatedManager.address]
        )];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Must target correct DelegatedManager");
      });
    });

    describe("when the caller is not the deployer", async() => {
      beforeEach(async() => {
        await create();
        subjectCaller = otherAccount;
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Only deployer can initialize manager");
      });
    });

    describe("when extensions and initializeBytecodes do not have the same length", async() => {
      beforeEach(async () => {
        await create();
        subjectInitializeBytecode = [];
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });
  });
});
