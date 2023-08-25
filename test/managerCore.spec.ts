import "module-alias/register";

import { Account, Address } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import {
  DelegatedManagerFactory,
  ManagerCore,
  BaseGlobalExtensionMock
} from "@utils/contracts/index";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getRandomAccount,
  getSetFixture,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";


const expect = getWaffleExpect();

describe("ManagerCore", () => {
  let owner: Account;
  let mockDelegatedManagerFactory: Account;
  let mockManager: Account;
  let mockModule: Account;

  let deployer: DeployHelper;
  let setV2Setup: SetFixture;

  let managerCore: ManagerCore;
  let delegatedManagerFactory: DelegatedManagerFactory;
  let mockExtension: BaseGlobalExtensionMock;

  before(async () => {
    [
      owner,
      mockDelegatedManagerFactory,
      mockManager,
      mockModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    managerCore = await deployer.managerCore.deployManagerCore();

    mockExtension = await deployer.mocks.deployBaseGlobalExtensionMock(managerCore.address, mockModule.address);

    delegatedManagerFactory = await deployer.factories.deployDelegatedManagerFactory(
      managerCore.address,
      setV2Setup.controller.address,
      setV2Setup.factory.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectDeployer: DeployHelper;

    beforeEach(async () => {
      subjectDeployer = new DeployHelper(owner.wallet);
    });

    async function subject(): Promise<ManagerCore> {
      return await subjectDeployer.managerCore.deployManagerCore();
    }

    it("should set the correct owner address", async () => {
      const managerCore = await subject();

      const storedOwner = await managerCore.owner();
      expect (storedOwner).to.eq(owner.address);
    });
  });

  describe("#initialize", async () => {
    let subjectCaller: Account;
    let subjectExtensions: Address[];
    let subjectFactories: Address[];

    beforeEach(async () => {
      subjectCaller = owner;
      subjectExtensions = [mockExtension.address];
      subjectFactories = [delegatedManagerFactory.address];
    });

    async function subject(): Promise<any> {
      return await managerCore.connect(subjectCaller.wallet).initialize(
        subjectExtensions,
        subjectFactories
      );
    }

    it("should have set the correct extensions length of 1", async () => {
      await subject();

      const extensions = await managerCore.getExtensions();
      expect(extensions.length).to.eq(1);
    });

    it("should have a valid extension", async () => {
      await subject();

      const validExtension = await managerCore.isExtension(mockExtension.address);
      expect(validExtension).to.eq(true);
    });

    it("should emit the ExtensionAdded event", async () => {
      await expect(subject()).to.emit(managerCore, "ExtensionAdded").withArgs(mockExtension.address);
    });

    it("should have set the correct factories length of 1", async () => {
      await subject();

      const factories = await managerCore.getFactories();
      expect(factories.length).to.eq(1);
    });

    it("should have a valid factory", async () => {
      await subject();

      const validFactory = await managerCore.isFactory(delegatedManagerFactory.address);
      expect(validFactory).to.eq(true);
    });

    it("should emit the FactoryAdded event", async () => {
      await expect(subject()).to.emit(managerCore, "FactoryAdded").withArgs(delegatedManagerFactory.address);
    });

    it("should initialize the ManagerCore", async () => {
      await subject();

      const storedIsInitialized = await managerCore.isInitialized();
      expect(storedIsInitialized).to.eq(true);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when zero address passed for extension", async () => {
      beforeEach(async () => {
        subjectExtensions = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when zero address passed for factory", async () => {
      beforeEach(async () => {
        subjectFactories = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when the ManagerCore is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("ManagerCore is already initialized");
      });
    });
  });

  describe("#addManager", async () => {
    let subjectManagerCore: ManagerCore;
    let subjectManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      managerCore.initialize([], []);
      managerCore.addFactory(mockDelegatedManagerFactory.address);

      subjectManagerCore = managerCore;
      subjectManager = mockManager.address;
      subjectCaller = mockDelegatedManagerFactory;
    });

    async function subject(): Promise<any> {
      subjectManagerCore = subjectManagerCore.connect(subjectCaller.wallet);
      return subjectManagerCore.addManager(subjectManager);
    }

    it("should be stored in the manager array", async () => {
      await subject();

      const managers = await managerCore.getManagers();
      expect(managers.length).to.eq(1);
    });

    it("should be returned as a valid manager", async () => {
      await subject();

      const validManager = await managerCore.isManager(mockManager.address);
      expect(validManager).to.eq(true);
    });

    it("should emit the ManagerAdded event", async () => {
      await expect(subject()).to.emit(managerCore, "ManagerAdded").withArgs(subjectManager, subjectCaller.address);
    });

    describe("when the manager already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Manager already exists");
      });
    });

    describe("when the caller is not a factory", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only valid factories can call");
      });
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });
  });

  describe("#removeManager", async () => {
    let subjectManagerCore: ManagerCore;
    let subjectManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await managerCore.initialize([], []);
      await managerCore.addFactory(mockDelegatedManagerFactory.address);
      await managerCore.connect(mockDelegatedManagerFactory.wallet).addManager(mockManager.address);

      subjectManagerCore = managerCore;
      subjectManager = mockManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return subjectManagerCore.connect(subjectCaller.wallet).removeManager(subjectManager);
    }

    it("should remove manager from manager array", async () => {
      await subject();

      const managers = await managerCore.getManagers();
      expect(managers.length).to.eq(0);
    });

    it("should return false as a valid manager", async () => {
      await subject();

      const isManager = await managerCore.isManager(mockManager.address);
      expect(isManager).to.eq(false);
    });

    it("should emit the ManagerRemoved event", async () => {
      await expect(subject()).to.emit(managerCore, "ManagerRemoved").withArgs(subjectManager);
    });

    describe("when the manager does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Manager does not exist");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });
  });

  describe("#addFactory", async () => {
    let subjectFactory: Address;
    let subjectCaller: Account;
    let subjectManagerCore: ManagerCore;

    beforeEach(async () => {
      await managerCore.initialize([], []);

      subjectFactory = delegatedManagerFactory.address;
      subjectCaller = owner;
      subjectManagerCore = managerCore;
    });

    async function subject(): Promise<any> {
      return await subjectManagerCore.connect(subjectCaller.wallet).addFactory(subjectFactory);
    }

    it("should be stored in the factories array", async () => {
      await subject();

      const factories = await managerCore.getFactories();
      expect(factories.length).to.eq(1);
    });

    it("should be returned as a valid factory", async () => {
      await subject();

      const validFactory = await managerCore.isFactory(delegatedManagerFactory.address);
      expect(validFactory).to.eq(true);
    });

    it("should emit the FactoryAdded event", async () => {
      await expect(subject()).to.emit(managerCore, "FactoryAdded").withArgs(subjectFactory);
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when zero address passed for a factory", async () => {
      beforeEach(async () => {
        subjectFactory = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when the factory already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Factory already exists");
      });
    });
  });

  describe("#removeFactory", async () => {
    let subjectFactory: Address;
    let subjectCaller: Account;
    let subjectManagerCore: ManagerCore;

    beforeEach(async () => {
      await managerCore.initialize([], [delegatedManagerFactory.address]);

      subjectFactory = delegatedManagerFactory.address;
      subjectCaller = owner;
      subjectManagerCore = managerCore;
    });

    async function subject(): Promise<any> {
      return await subjectManagerCore.connect(subjectCaller.wallet).removeFactory(subjectFactory);
    }

    it("should remove factory from factories array", async () => {
      await subject();

      const factories = await managerCore.getFactories();
      expect(factories.length).to.eq(0);
    });

    it("should return false as a valid factory", async () => {
      await subject();

      const validFactory = await managerCore.isFactory(delegatedManagerFactory.address);
      expect(validFactory).to.eq(false);
    });

    it("should emit the FactoryRemoved event", async () => {
      await expect(subject()).to.emit(managerCore, "FactoryRemoved").withArgs(subjectFactory);
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the factory does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Factory does not exist");
      });
    });
  });

  describe("#addExtension", async () => {
    let subjectExtension: Address;
    let subjectCaller: Account;
    let subjectManagerCore: ManagerCore;

    beforeEach(async () => {
      await managerCore.initialize([], []);

      subjectExtension = mockExtension.address;
      subjectCaller = owner;
      subjectManagerCore = managerCore;
    });

    async function subject(): Promise<any> {
      return await subjectManagerCore.connect(subjectCaller.wallet).addExtension(subjectExtension);
    }

    it("should be stored in the extensions array", async () => {
      await subject();

      const extensions = await managerCore.getExtensions();
      expect(extensions.length).to.eq(1);
    });

    it("should be returned as a valid extension", async () => {
      await subject();

      const validExtension = await managerCore.isExtension(mockExtension.address);
      expect(validExtension).to.eq(true);
    });

    it("should emit the ExtensionAdded event", async () => {
      await expect(subject()).to.emit(managerCore, "ExtensionAdded").withArgs(subjectExtension);
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when zero address passed for an extension", async () => {
      beforeEach(async () => {
        subjectExtension = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero address submitted.");
      });
    });

    describe("when the extension already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension already exists");
      });
    });
  });

  describe("#removeExtension", async () => {
    let subjectExtension: Address;
    let subjectCaller: Account;
    let subjectManagerCore: ManagerCore;

    beforeEach(async () => {
      await managerCore.initialize([mockExtension.address], []);

      subjectExtension = mockExtension.address;
      subjectCaller = owner;
      subjectManagerCore = managerCore;
    });

    async function subject(): Promise<any> {
      return await subjectManagerCore.connect(subjectCaller.wallet).removeExtension(subjectExtension);
    }

    it("should remove extension from extensions array", async () => {
      await subject();

      const extensions = await managerCore.getExtensions();
      expect(extensions.length).to.eq(0);
    });

    it("should return false as a valid extension", async () => {
      await subject();

      const validExtension = await managerCore.isExtension(mockExtension.address);
      expect(validExtension).to.eq(false);
    });

    it("should emit the ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(managerCore, "ExtensionRemoved").withArgs(subjectExtension);
    });

    describe("when the ManagerCore is not initialized", async () => {
      beforeEach(async () => {
        subjectManagerCore = await deployer.managerCore.deployManagerCore();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Contract must be initialized.");
      });
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when the extension does not exist", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension does not exist");
      });
    });
  });
});
