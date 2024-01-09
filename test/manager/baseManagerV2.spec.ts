import "module-alias/register";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { BaseManagerV2, BaseExtensionMock, StreamingFeeSplitExtension } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
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

import { solidityKeccak256 } from "ethers/lib/utils";
import { ContractTransaction } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

const expect = getWaffleExpect();

describe("BaseManagerV2", () => {
  let operator: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let newManager: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManager: BaseManagerV2;
  let baseExtension: BaseExtensionMock;

  async function validateMutualUprade(txHash: ContractTransaction, caller: Address) {
    const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, caller]);
    const isLogged = await baseManager.mutualUpgrades(expectedHash);
    expect(isLogged).to.be.true;
  }

  before(async () => {
    [
      operator,
      otherAccount,
      newManager,
      methodologist,
    ] = await getAccounts();

    deployer = new DeployHelper(operator.wallet);

    setV2Setup = getSetFixture(operator.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [
        setV2Setup.issuanceModule.address,
        setV2Setup.streamingFeeModule.address,
        setV2Setup.governanceModule.address,
      ]
    );

    // Initialize modules
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await setV2Setup.governanceModule.initialize(setToken.address);

    const feeRecipient = operator.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    // Deploy BaseManager
    baseManager = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );

    // Transfer operatorship to BaseManager
    await setToken.setManager(baseManager.address);

    baseExtension = await deployer.mocks.deployBaseExtensionMock(baseManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetToken: Address;
    let subjectOperator: Address;
    let subjectMethodologist: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectOperator = operator.address;
      subjectMethodologist = methodologist.address;
    });

    async function subject(): Promise<BaseManagerV2> {
      return await deployer.manager.deployBaseManagerV2(
        subjectSetToken,
        subjectOperator,
        subjectMethodologist
      );
    }

    it("should set the correct SetToken address", async () => {
      const retrievedICManager = await subject();

      const actualToken = await retrievedICManager.setToken();
      expect (actualToken).to.eq(subjectSetToken);
    });

    it("should set the correct Operator address", async () => {
      const retrievedICManager = await subject();

      const actualOperator = await retrievedICManager.operator();
      expect (actualOperator).to.eq(subjectOperator);
    });

    it("should set the correct Methodologist address", async () => {
      const retrievedICManager = await subject();

      const actualMethodologist = await retrievedICManager.methodologist();
      expect (actualMethodologist).to.eq(subjectMethodologist);
    });

    it("should not be initialized by default", async () => {
      const retrievedICManager = await subject();

      const initialized = await retrievedICManager.initialized();
      expect(initialized).to.be.false;
    });
  });

  describe("#authorizeInitialization", () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).authorizeInitialization();
    }

    it("sets initialized to true", async() => {
      const defaultInitialized = await baseManager.initialized();

      await subject();

      const updatedInitialized = await baseManager.initialized();

      expect(defaultInitialized).to.be.false;
      expect(updatedInitialized).to.be.true;
    });

    describe("when the caller is not the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });

    describe("when the manager is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Initialization authorized");
      });
    });
  });

  describe("#setManager", async () => {
    let subjectNewManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewManager = newManager.address;
      subjectCaller = operator;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager.connect(caller.wallet).setManager(subjectNewManager);
    }

    it("should change the manager address", async () => {
      await subject(operator);
      await subject(methodologist);
      const manager = await setToken.manager();

      expect(manager).to.eq(newManager.address);
    });

    describe("when a single mutual upgrade party calls", () => {
      it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
        const txHash = await subject(operator);
        await validateMutualUprade(txHash, operator.address);
      });
    });

    describe("when passed manager is the zero address", async () => {
      beforeEach(async () => {
        subjectNewManager = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await subject(operator);
        await expect(subject(methodologist)).to.be.revertedWith("Zero address not valid");
      });
    });

    describe("when the caller is not the operator or the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject(subjectCaller)).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#addExtension", async () => {
    let subjectModule: Address;
    let subjectExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectExtension = baseExtension.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).addExtension(subjectExtension);
    }

    it("should add the extension address", async () => {
      await subject();
      const extensions = await baseManager.getExtensions();

      expect(extensions[0]).to.eq(baseExtension.address);
    });

    it("should set the extension mapping", async () => {
      await subject();
      const isExtension = await baseManager.isExtension(subjectExtension);

      expect(isExtension).to.be.true;
    });

    it("should emit the correct ExtensionAdded event", async () => {
      await expect(subject()).to.emit(baseManager, "ExtensionAdded").withArgs(baseExtension.address);
    });

    describe("when the extension already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension already exists");
      });
    });

    describe("when extension has different manager address", async () => {
      beforeEach(async () => {
        subjectExtension = (await deployer.mocks.deployBaseExtensionMock(await getRandomAddress())).address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension manager invalid");
      });
    });

    describe("when an emergency is in progress", async () => {
      beforeEach(async () => {
        baseManager.connect(operator.wallet);
        await baseManager.protectModule(subjectModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectModule);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Upgrades paused by emergency");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#removeExtension", async () => {
    let subjectModule: Address;
    let subjectAdditionalModule: Address;
    let subjectExtension: Address;
    let subjectAdditionalExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await baseManager.connect(operator.wallet).addExtension(baseExtension.address);

      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalModule = setV2Setup.issuanceModule.address;
      subjectExtension = baseExtension.address;
      subjectAdditionalExtension = (await deployer.mocks.deployBaseExtensionMock(baseManager.address)).address;
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).removeExtension(subjectExtension);
    }

    it("should remove the extension address", async () => {
      await subject();
      const extensions = await baseManager.getExtensions();

      expect(extensions.length).to.eq(0);
    });

    it("should set the extension mapping", async () => {
      await subject();
      const isExtension = await baseManager.isExtension(subjectExtension);

      expect(isExtension).to.be.false;
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(baseManager, "ExtensionRemoved").withArgs(baseExtension.address);
    });

    describe("when the extension does not exist", async () => {
      beforeEach(async () => {
        subjectExtension = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension does not exist");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when the extension is authorized for a protected module", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Extension used by protected module");
      });
    });

    // This test for the coverage report - hits an alternate branch condition the authorized
    // extensions search method....
    describe("when multiple extensionsa are authorized for multiple protected modules", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectAdditionalModule, [subjectAdditionalExtension]);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Extension used by protected module");
      });
    });
  });

  describe("#authorizeExtension", () => {
    let subjectModule: Address;
    let subjectExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectExtension = baseExtension.address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager.connect(caller.wallet).authorizeExtension(subjectModule, subjectExtension);
    }

    describe("when extension is not authorized and already added", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should authorize the extension", async () => {
        const initialAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject(operator);
        await subject(methodologist);

        const finalAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialAuthorization).to.be.false;
        expect(finalAuthorization).to.be.true;
      });

      it("should emit the correct ExtensionAuthorized event", async () => {
        await subject(operator);

        await expect(subject(methodologist)).to
          .emit(baseManager, "ExtensionAuthorized")
          .withArgs(subjectModule, subjectExtension);
      });
    });

    describe("when extension is not already added to the manager", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should add and authorize the extension", async () => {
        const initialIsExtension = await baseManager.isExtension(subjectExtension);
        const initialAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject(operator);
        await subject(methodologist);

        const finalIsExtension = await baseManager.isExtension(subjectExtension);
        const finalAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialIsExtension).to.be.false;
        expect(initialAuthorization).to.be.false;
        expect(finalIsExtension).to.be.true;
        expect(finalAuthorization).to.be.true;
      });
    });

    describe("when the extension is already authorized for target module", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should revert", async () => {
        await subject(operator);
        await expect(subject(methodologist)).to.be.revertedWith("Extension already authorized");
      });
    });

    describe("when target module is not protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
      });

      it("should revert", async () => {
        const isProtected = await baseManager.protectedModules(subjectModule);

        await subject(operator);

        await expect(isProtected).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Module not protected");
      });
    });

    describe("when a single mutual upgrade party calls", () => {
      it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
        const txHash = await subject(operator);
        await validateMutualUprade(txHash, operator.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject(subjectCaller)).to.be.revertedWith("Must be authorized");
      });
    });
  });

  describe("#revokeExtensionAuthorization", () => {
    let subjectModule: Address;
    let subjectAdditionalModule: Address;
    let subjectExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalModule = setV2Setup.issuanceModule.address;
      subjectExtension = baseExtension.address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager.connect(caller.wallet).revokeExtensionAuthorization(subjectModule, subjectExtension);
    }

    describe("when extension is authorized", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should revoke extension authorization", async () => {
        const initialAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject(operator);
        await subject(methodologist);

        const finalAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialAuthorization).to.be.true;
        expect(finalAuthorization).to.be.false;
      });

      it("should emit the correct ExtensionAuthorizationRevoked event", async () => {
        await subject(operator);

        await expect(subject(methodologist)).to
          .emit(baseManager, "ExtensionAuthorizationRevoked")
          .withArgs(subjectModule, subjectExtension);
      });
    });

    describe("when an extension is shared by protected modules", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
        await baseManager.connect(operator.wallet).protectModule(subjectAdditionalModule, [subjectExtension]);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should only revoke authorization for the specified module", async () => {
        const initialAuth = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);
        const initialAdditionalAuth = await baseManager.isAuthorizedExtension(subjectAdditionalModule, subjectExtension);

        await subject(operator);
        await subject(methodologist);

        const finalAuth = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);
        const finalAdditionalAuth = await baseManager.isAuthorizedExtension(subjectAdditionalModule, subjectExtension);

        expect(initialAuth).to.be.true;
        expect(initialAdditionalAuth).to.be.true;
        expect(finalAuth).to.be.false;
        expect(finalAdditionalAuth).to.be.true;
      });
    });

    describe("when extension is not added to the manager", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        const initialExtensionStatus = await baseManager.connect(operator.wallet).isExtension(subjectExtension);

        await subject(operator);

        await expect(initialExtensionStatus).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Extension does not exist");
      });
    });

    describe("when the extension is not authorized for target module", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        const initialAuthorization = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject(operator);
        await expect(initialAuthorization).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Extension not authorized");
      });
    });

    describe("when target module is not protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
      });

      it("should revert", async () => {
        const isProtected = await baseManager.protectedModules(subjectModule);

        await subject(operator);

        await expect(isProtected).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Module not protected");
      });
    });

    describe("when a single mutual upgrade party calls", () => {
      it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
        const txHash = await subject(operator);
        await validateMutualUprade(txHash, operator.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject(subjectCaller)).to.be.revertedWith("Must be authorized");
      });
    });
  });

  describe("#addModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectModule = otherAccount.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).addModule(subjectModule);
    }

    it("should add the module to the SetToken", async () => {
      await subject();
      const isModule = await setToken.isPendingModule(subjectModule);
      expect(isModule).to.eq(true);
    });

    describe("when an emergency is in progress", async () => {
      beforeEach(async () => {
        subjectModule = setV2Setup.streamingFeeModule.address;
        await baseManager.protectModule(subjectModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectModule);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Upgrades paused by emergency");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#emergencyRemoveProtectedModule", () => {
    let subjectModule: Address;
    let subjectAdditionalModule: Address;
    let subjectExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalModule = setV2Setup.governanceModule.address; // Removable
      subjectExtension = baseExtension.address;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).emergencyRemoveProtectedModule(subjectModule);
    }

    describe("when module is protected", async () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should remove the module from the set token", async () => {
        await subject();
        const isModule = await setToken.isInitializedModule(subjectModule);
        expect(isModule).to.eq(false);
      });

      it("should unprotect the module", async () => {
        await subject();
        const isProtected = await baseManager.protectedModules(subjectModule);
        expect(isProtected).to.be.false;
      });

      it("should clear the protected modules authorized extension registries", async () => {
        const initialAuthorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectModule);
        const initialIsAuthorized = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject();

        const finalAuthorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectModule);
        const finalIsAuthorized = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialAuthorizedExtensionsList.length).equals(1);
        expect(initialIsAuthorized).to.be.true;
        expect(finalAuthorizedExtensionsList.length).equals(0);
        expect(finalIsAuthorized).to.be.false;
      });

      it("should not preserve any settings if same module is removed and restored", async () => {
        await subject();

        await baseManager.connect(methodologist.wallet).resolveEmergency();
        await baseManager.connect(operator.wallet).addModule(subjectModule);

        // Invoke initialize on streamingFeeModule
        const feeRecipient = operator.address;
        const maxStreamingFeePercentage = ether(.1);
        const streamingFeePercentage = ether(.02);
        const streamingFeeSettings = {
          feeRecipient,
          maxStreamingFeePercentage,
          streamingFeePercentage,
          lastStreamingFeeTimestamp: ZERO,
        };

        const initializeData = setV2Setup
          .streamingFeeModule
          .interface
          .encodeFunctionData("initialize", [setToken.address, streamingFeeSettings]);

        await baseManager.connect(methodologist.wallet).authorizeInitialization();
        await baseExtension.interactManager(subjectModule, initializeData);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);

        const authorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectModule);
        const isAuthorized = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(authorizedExtensionsList.length).equals(0);
        expect(isAuthorized).to.be.false;
      });

      it("should increment the emergencies counter", async () => {
        const initialEmergencies = await baseManager.emergencies();

        await subject();

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(0);
        expect(finalEmergencies.toNumber()).equals(1);
      });

      it("should emit the correct EmergencyRemovedProtectedModule event", async () => {
        await expect(subject()).to
          .emit(baseManager, "EmergencyRemovedProtectedModule")
          .withArgs(subjectModule);
      });
    });

    describe("when an emergency is already in progress", async () => {
      beforeEach(async () => {
        baseManager.connect(operator.wallet);

        await baseManager.protectModule(subjectModule, []);
        await baseManager.protectModule(subjectAdditionalModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectAdditionalModule);
      });

      it("should increment the emergencies counter", async () => {
        const initialEmergencies = await baseManager.emergencies();

        await subject();

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(1);
        expect(finalEmergencies.toNumber()).equals(2);
      });
    });

    describe("when module is not protected", () => {
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module not protected");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#protectModule", () => {
    let subjectModule: Address;
    let subjectAdditionalModule: Address;
    let subjectExtension: Address;
    let subjectAuthorizedExtensions: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectExtension = baseExtension.address;
      subjectAdditionalModule = setV2Setup.governanceModule.address; // Removable
      subjectAuthorizedExtensions = [];
    });

    async function subject(): Promise<any> {
      return baseManager
        .connect(subjectCaller.wallet)
        .protectModule(subjectModule, subjectAuthorizedExtensions);
    }

    describe("when module already added, no extensions", () => {
      it("should protect the module", async () => {
        const initialIsProtected = await baseManager.protectedModules(subjectModule);
        const initialProtectedModulesList = await baseManager.getProtectedModules();

        await subject();

        const finalIsProtected = await baseManager.protectedModules(subjectModule);
        const finalProtectedModulesList = await baseManager.getProtectedModules();

        expect(initialIsProtected).to.be.false;
        expect(finalIsProtected).to.be.true;
        expect(initialProtectedModulesList.length).equals(0);
        expect(finalProtectedModulesList.length).equals(1);
      });
    });

    describe("when module already added, with non-added extension", () => {
      beforeEach(() => {
        subjectAuthorizedExtensions = [subjectExtension];
      });
      it("should add and authorize the extension", async () => {
        const initialIsExtension = await baseManager.isExtension(subjectExtension);
        const initialIsAuthorizedExtension = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject();

        const finalIsExtension = await baseManager.isExtension(subjectExtension);
        const finalIsAuthorizedExtension = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialIsExtension).to.be.false;
        expect(finalIsExtension).to.be.true;
        expect(initialIsAuthorizedExtension).to.be.false;
        expect(finalIsAuthorizedExtension).to.be.true;
      });

      // With extensions...
      it("should emit the correct ModuleProtected event", async () => {
        await expect(subject()).to
          .emit(baseManager, "ModuleProtected")
          .withArgs(subjectModule, subjectAuthorizedExtensions);
      });
    });

    describe("when module and extension already added", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addExtension(subjectExtension);
        subjectAuthorizedExtensions = [subjectExtension];
      });

      it("should authorize the extension", async () => {
        const initialIsExtension = await baseManager.isExtension(subjectExtension);
        const initialIsAuthorizedExtension = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject();

        const finalIsAuthorizedExtension = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialIsExtension).to.be.true;
        expect(initialIsAuthorizedExtension).to.be.false;
        expect(finalIsAuthorizedExtension).to.be.true;
      });
    });

    describe("when module not added", () => {
      beforeEach(async () => {
        await baseManager.removeModule(subjectModule);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module not added yet");
      });
    });

    describe("when module already protected", () => {
      beforeEach(async () => {
        await baseManager.protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module already protected");
      });
    });

    describe("when an emergency is in progress", async () => {
      beforeEach(async () => {
        await baseManager.protectModule(subjectAdditionalModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectAdditionalModule);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Upgrades paused by emergency");
      });
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#unProtectModule", () => {
    let subjectModule: Address;
    let subjectExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectExtension = baseExtension.address;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).unProtectModule(subjectModule);
    }

    describe("when module is protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should *not* remove the module from the set token", async () => {
        await subject();
        const isModule = await setToken.isInitializedModule(subjectModule);
        expect(isModule).to.be.true;
      });

      it("should unprotect the module", async () => {
        await subject();
        const isProtected = await baseManager.protectedModules(subjectModule);
        expect(isProtected).to.be.false;
      });

      it("should clear the protected modules authorized extension registries", async () => {
        const initialAuthorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectModule);
        const initialIsAuthorized = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        await subject();

        const finalAuthorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectModule);
        const finalIsAuthorized = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(initialAuthorizedExtensionsList.length).equals(1);
        expect(initialIsAuthorized).to.be.true;
        expect(finalAuthorizedExtensionsList.length).equals(0);
        expect(finalIsAuthorized).to.be.false;
      });

      it("should not preserve any settings if same module is removed and restored", async () => {
        await subject();

        // Restore without extension
        await baseManager.protectModule(subjectModule, []);

        const authorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectModule);
        const isAuthorized = await baseManager.isAuthorizedExtension(subjectModule, subjectExtension);

        expect(authorizedExtensionsList.length).equals(0);
        expect(isAuthorized).to.be.false;
      });

      it("should emit the correct ModuleUnprotected event", async () => {
        await expect(subject()).to
          .emit(baseManager, "ModuleUnprotected")
          .withArgs(subjectModule);
      });
    });

    describe("when module is not protected", () => {
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module not protected");
      });
    });

    describe("when the caller is not the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = operator;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#replaceProtectedModule", () => {
    let subjectOldModule: Address;
    let subjectNewModule: Address;
    let subjectOldExtension: Address;
    let subjectNewExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectCaller = operator;
      subjectOldModule = setV2Setup.streamingFeeModule.address;
      subjectNewModule = otherAccount.address;
      subjectOldExtension = baseExtension.address;
      subjectNewExtension = (await deployer.mocks.deployBaseExtensionMock(baseManager.address)).address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager
        .connect(caller.wallet)
        .replaceProtectedModule(subjectOldModule, subjectNewModule, [subjectNewExtension]);
    }

    describe("when old module is protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectOldModule, [subjectOldExtension]);
      });

      describe("when new module is not added", () => {
        it("should add new module to setToken", async () => {
          const initialModuleAdded = await setToken.isPendingModule(subjectNewModule);

          await subject(operator);
          await subject(methodologist);

          const finalModuleAdded = await setToken.isPendingModule(subjectNewModule);

          expect(initialModuleAdded).to.be.false;
          expect(finalModuleAdded).to.be.true;
        });

        it("should remove old module from setToken", async () => {
          const initialModuleAdded = await setToken.isInitializedModule(subjectOldModule);

          await subject(operator);
          await subject(methodologist);

          const finalModuleAdded = await setToken.isInitializedModule(subjectOldModule);

          expect(initialModuleAdded).to.be.true;
          expect(finalModuleAdded).to.be.false;
        });

        it("should protect the module", async () => {
          const initialIsProtected = await baseManager.protectedModules(subjectNewModule);
          const initialProtectedModulesList = await baseManager.getProtectedModules();

          await subject(operator);
          await subject(methodologist);

          const finalIsProtected = await baseManager.protectedModules(subjectNewModule);
          const finalProtectedModulesList = await baseManager.getProtectedModules();

          expect(initialIsProtected).to.be.false;
          expect(finalIsProtected).to.be.true;
          expect(initialProtectedModulesList[0]).equals(subjectOldModule);
          expect(finalProtectedModulesList[0]).equals(subjectNewModule);
        });

        it("should unprotect the old module", async () => {
          await subject(operator);
          await subject(methodologist);

          const isProtected = await baseManager.protectedModules(subjectOldModule);
          expect(isProtected).to.be.false;
        });

        it("should clear the old modules authorized extension registries", async () => {
          const initialAuthorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectOldModule);
          const initialIsAuthorized = await baseManager.isAuthorizedExtension(subjectOldModule, subjectOldExtension);

          await subject(operator);
          await subject(methodologist);

          const finalAuthorizedExtensionsList = await baseManager.getAuthorizedExtensions(subjectOldModule);
          const finalIsAuthorized = await baseManager.isAuthorizedExtension(subjectOldModule, subjectOldExtension);

          expect(initialAuthorizedExtensionsList.length).equals(1);
          expect(initialIsAuthorized).to.be.true;
          expect(finalAuthorizedExtensionsList.length).equals(0);
          expect(finalIsAuthorized).to.be.false;
        });

        it("should add and authorize the new module extension", async () => {
          const initialIsExtension = await baseManager.isExtension(subjectNewExtension);
          const initialIsAuthorizedExtension = await baseManager.isAuthorizedExtension(
            subjectNewModule, subjectNewExtension
          );

          await subject(operator);
          await subject(methodologist);

          const finalIsExtension = await baseManager.isExtension(subjectNewExtension);
          const finalIsAuthorizedExtension = await baseManager.isAuthorizedExtension(
            subjectNewModule,
            subjectNewExtension
          );

          expect(initialIsExtension).to.be.false;
          expect(finalIsExtension).to.be.true;
          expect(initialIsAuthorizedExtension).to.be.false;
          expect(finalIsAuthorizedExtension).to.be.true;
        });

        it("should emit the correct ReplacedProtectedModule event", async () => {
          await subject(operator);

          await expect(subject(methodologist)).to
            .emit(baseManager, "ReplacedProtectedModule")
            .withArgs(subjectOldModule, subjectNewModule, [subjectNewExtension]);
        });
      });

      describe("when the new module is already added", async () => {
        beforeEach(async () => {
          await baseManager.addModule(subjectNewModule);
        });

        it("should revert", async () => {
          await subject(operator);
          await expect(subject(methodologist)).to.be.revertedWith("Module must not be added");
        });
      });
    });

    describe("when old module is not protected", () => {
      it("should revert", async () => {
        await subject(operator);
        await expect(subject(methodologist)).to.be.revertedWith("Module not protected");
      });
    });

    describe("when a single mutual upgrade party calls", () => {
      it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
        const txHash = await subject(operator);
        await validateMutualUprade(txHash, operator.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject(subjectCaller)).to.be.revertedWith("Must be authorized");
      });
    });
  });

  describe("#emergencyReplaceProtectedModule", () => {
    let subjectOldModule: Address;
    let subjectAdditionalOldModule: Address;
    let subjectNewModule: Address;
    let subjectNewExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectCaller = operator;
      subjectOldModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalOldModule = setV2Setup.governanceModule.address; // Removable
      subjectNewModule = otherAccount.address;
      subjectNewExtension = (await deployer.mocks.deployBaseExtensionMock(baseManager.address)).address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager
        .connect(caller.wallet)
        .emergencyReplaceProtectedModule(subjectNewModule, [subjectNewExtension]);
    }

    describe("when new module is not added", () => {
      beforeEach(async () => {
        // Trigger emergency
        baseManager.connect(operator.wallet);
        await baseManager.protectModule(subjectOldModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectOldModule);
      });

      it("should add module to setToken", async () => {
        const initialModuleAdded = await setToken.isPendingModule(subjectNewModule);

        await subject(operator);
        await subject(methodologist);

        const finalModuleAdded = await setToken.isPendingModule(subjectNewModule);

        expect(initialModuleAdded).to.be.false;
        expect(finalModuleAdded).to.be.true;
      });

      it("should protect the module", async () => {
        const initialIsProtected = await baseManager.protectedModules(subjectNewModule);

        await subject(operator);
        await subject(methodologist);

        const finalIsProtected = await baseManager.protectedModules(subjectNewModule);

        expect(initialIsProtected).to.be.false;
        expect(finalIsProtected).to.be.true;
      });

      it("should add and authorize the new module extension", async () => {
        const initialIsExtension = await baseManager.isExtension(subjectNewExtension);
        const initialIsAuthorizedExtension = await baseManager.isAuthorizedExtension(
          subjectNewModule, subjectNewExtension
        );

        await subject(operator);
        await subject(methodologist);

        const finalIsExtension = await baseManager.isExtension(subjectNewExtension);
        const finalIsAuthorizedExtension = await baseManager.isAuthorizedExtension(
          subjectNewModule,
          subjectNewExtension
        );

        expect(initialIsExtension).to.be.false;
        expect(finalIsExtension).to.be.true;
        expect(initialIsAuthorizedExtension).to.be.false;
        expect(finalIsAuthorizedExtension).to.be.true;
      });

      it("should decrement the emergencies counter", async() => {
        const initialEmergencies = await baseManager.emergencies();

        await subject(operator);
        await subject(methodologist);

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(1);
        expect(finalEmergencies.toNumber()).equals(0);
      });

      it("should emit the correct EmergencyReplacedProtectedModule event", async () => {
        await subject(operator);

        await expect(subject(methodologist)).to
          .emit(baseManager, "EmergencyReplacedProtectedModule")
          .withArgs(subjectNewModule, [subjectNewExtension]);
      });
    });

    describe("when the new module is already added", async () => {
      beforeEach(async () => {
        baseManager.connect(operator.wallet);
        await baseManager.addModule(subjectNewModule);
        await baseManager.protectModule(subjectOldModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectOldModule);
      });

      it("should revert", async () => {
        await subject(operator);
        await expect(subject(methodologist)).to.be.revertedWith("Module must not be added");
      });
    });

    describe("when an emergency is not in progress", async () => {
      it("should revert", async () => {
        await subject(operator);
        await expect(subject(methodologist)).to.be.revertedWith("Not in emergency");
      });
    });

    describe("when more than one emergency is in progress", async () => {
      beforeEach(async () => {
        baseManager.connect(operator.wallet);
        await baseManager.protectModule(subjectOldModule, []);
        await baseManager.protectModule(subjectAdditionalOldModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectOldModule);
        await baseManager.emergencyRemoveProtectedModule(subjectAdditionalOldModule);
      });

      it("should remain in an emergency state after replacement", async () => {
        const initialEmergencies = await baseManager.emergencies();

        await subject(operator);
        await subject(methodologist);

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(2);
        expect(finalEmergencies.toNumber()).equals(1);
      });
    });

    describe("when a single mutual upgrade party calls", () => {
      it("should log the proposed streaming fee hash in the mutualUpgrades mapping", async () => {
        const txHash = await subject(operator);
        await validateMutualUprade(txHash, operator.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject(subjectCaller)).to.be.revertedWith("Must be authorized");
      });
    });
  });

  describe("#resolveEmergency", () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectCaller = methodologist;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).resolveEmergency();
    }

    describe("when an emergency is in progress", () => {
      beforeEach(async () => {
        await baseManager.protectModule(subjectModule, []);
        await baseManager.emergencyRemoveProtectedModule(subjectModule);
      });

      it("should decrement the emergency counter", async () => {
        const initialEmergencies = await baseManager.emergencies();

        await subject();

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(1);
        expect(finalEmergencies.toNumber()).equals(0);
      });

      it("should emit the correct EmergencyResolved event", async () => {
        await expect(subject()).to.emit(baseManager, "EmergencyResolved");
      });
    });

    describe("when an emergency is *not* in progress", async () => {
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Not in emergency");
      });
    });

    describe("when the caller is not the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = operator;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#interactManager", async () => {
    let subjectModule: Address;
    let subjectExtension: Address;
    let subjectCallData: Bytes;

    beforeEach(async () => {
      await baseManager.connect(operator.wallet).addExtension(baseExtension.address);

      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectExtension = baseExtension.address;

      // Invoke update fee recipient
      subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);
    });

    async function subject(): Promise<any> {
      return baseExtension.connect(operator.wallet).interactManager(subjectModule, subjectCallData);
    }

    context("when the manager is initialized", () => {
      beforeEach(async() => {
        await baseManager.connect(methodologist.wallet).authorizeInitialization();
      });

      it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
        await subject();
        const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        expect(feeStates.feeRecipient).to.eq(otherAccount.address);
      });

      describe("when the caller is not an extension", async () => {
        beforeEach(async () => {
          await baseManager.connect(operator.wallet).removeExtension(baseExtension.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be extension");
        });
      });

      describe("when the extension tries to call the SetToken", async () => {
        beforeEach(async () => {
          subjectModule = setToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Extensions cannot call SetToken");
        });
      });
    });

    context("when the manager is not initialized", () => {
      it("updateFeeRecipient should revert", async () => {
        await expect(subject()).to.be.revertedWith("Manager not initialized");
      });
    });

    context("when the module is protected and extension is authorized", () => {
      beforeEach(async () => {
        await baseManager.connect(methodologist.wallet).authorizeInitialization();
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("updateFeeRecipient should succeed", async () => {
        await subject();
        const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        expect(feeStates.feeRecipient).to.eq(otherAccount.address);
      });
    });

    context("when the module is protected and extension is not authorized", () => {
      beforeEach(async () => {
        await baseManager.connect(methodologist.wallet).authorizeInitialization();
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension not authorized for module");
      });
    });
  });

  describe("#transferTokens", async () => {
    let subjectCaller: Account;
    let subjectToken: Address;
    let subjectDestination: Address;
    let subjectAmount: BigNumber;

    beforeEach(async () => {
      await baseManager.connect(operator.wallet).addExtension(baseExtension.address);

      subjectCaller = operator;
      subjectToken = setV2Setup.weth.address;
      subjectDestination = otherAccount.address;
      subjectAmount = ether(1);

      await setV2Setup.weth.transfer(baseManager.address, subjectAmount);
    });

    async function subject(): Promise<ContractTransaction> {
      return baseExtension.connect(subjectCaller.wallet).testInvokeManagerTransfer(
        subjectToken,
        subjectDestination,
        subjectAmount
      );
    }

    it("should send the given amount from the manager to the address", async () => {
      const preManagerAmount = await setV2Setup.weth.balanceOf(baseManager.address);
      const preDestinationAmount = await setV2Setup.weth.balanceOf(subjectDestination);

      await subject();

      const postManagerAmount = await setV2Setup.weth.balanceOf(baseManager.address);
      const postDestinationAmount = await setV2Setup.weth.balanceOf(subjectDestination);

      expect(preManagerAmount.sub(postManagerAmount)).to.eq(subjectAmount);
      expect(postDestinationAmount.sub(preDestinationAmount)).to.eq(subjectAmount);
    });

    describe("when the caller is not an extension", async () => {
        beforeEach(async () => {
          await baseManager.connect(operator.wallet).removeExtension(baseExtension.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be extension");
        });
      });
  });

  describe("#removeModule", async () => {
    let subjectModule: Address;
    let subjectExtension: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectExtension = baseExtension.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).removeModule(subjectModule);
    }

    it("should remove the module from the SetToken", async () => {
      await subject();
      const isModule = await setToken.isInitializedModule(subjectModule);
      expect(isModule).to.eq(false);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when the module is protected module", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension]);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Module protected");
      });
    });
  });

  describe("#setMethodologist", async () => {
    let subjectNewMethodologist: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewMethodologist = await getRandomAddress();
      subjectCaller = methodologist;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).setMethodologist(subjectNewMethodologist);
    }

    it("should set the new methodologist", async () => {
      await subject();
      const actualIndexModule = await baseManager.methodologist();
      expect(actualIndexModule).to.eq(subjectNewMethodologist);
    });

    it("should emit the correct MethodologistChanged event", async () => {
      await expect(subject()).to.emit(baseManager, "MethodologistChanged").withArgs(methodologist.address, subjectNewMethodologist);
    });

    describe("when the caller is not the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#setOperator", async () => {
    let subjectNewOperator: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewOperator = await getRandomAddress();
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).setOperator(subjectNewOperator);
    }

    it("should set the new operator", async () => {
      await subject();
      const actualIndexModule = await baseManager.operator();
      expect(actualIndexModule).to.eq(subjectNewOperator);
    });

    it("should emit the correct OperatorChanged event", async () => {
      await expect(subject()).to.emit(baseManager, "OperatorChanged").withArgs(operator.address, subjectNewOperator);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("E2E: deployment, configuration, methodologist authorization, use", async () => {
    let subjectSetToken: Address;
    let subjectExtension: StreamingFeeSplitExtension;
    let subjectModule: Address;
    let subjectOperator: Address;
    let subjectMethodologist: Address;
    let subjectFeeSplit: BigNumber;
    let subjectOperatorFeeRecipient: Address;
    let subjectManager: BaseManagerV2;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectOperator = operator.address;
      subjectMethodologist = methodologist.address;
      subjectFeeSplit = ether(.7);
      subjectOperatorFeeRecipient = operator.address;

      // Deploy new manager
      subjectManager = await deployer.manager.deployBaseManagerV2(
        subjectSetToken,
        subjectOperator,
        subjectMethodologist
      );

      // Deploy new fee extension
      subjectExtension = await deployer.extensions.deployStreamingFeeSplitExtension(
        subjectManager.address,
        subjectModule,
        subjectFeeSplit,
        subjectOperatorFeeRecipient
      );

      // Operator protects module and adds extension
      await subjectManager.connect(operator.wallet).protectModule(subjectModule, [subjectExtension.address]);

      // Methodologist authorizes new manager
      await subjectManager.connect(methodologist.wallet).authorizeInitialization();

      // Transfer ownership from old to new manager
      await baseManager.connect(operator.wallet).setManager(subjectManager.address);
      await baseManager.connect(methodologist.wallet).setManager(subjectManager.address);
    });

    // Makes mutual upgrade call which routes call to module via interactManager
    async function subject(): Promise<void> {
      await subjectExtension.connect(operator.wallet).updateFeeRecipient(subjectExtension.address);
      await subjectExtension.connect(methodologist.wallet).updateFeeRecipient(subjectExtension.address);
    }

    it("allows protected calls", async() => {
      const initialFeeRecipient = (await setV2Setup.streamingFeeModule.feeStates(subjectSetToken)).feeRecipient;

      await subject();

      const finalFeeRecipient = (await setV2Setup.streamingFeeModule.feeStates(subjectSetToken)).feeRecipient;

      expect(initialFeeRecipient).to.equal(operator.address);
      expect(finalFeeRecipient).to.equal(subjectExtension.address);
    });
  });
});
