import "module-alias/register";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { BaseManager, BaseAdapterMock } from "@utils/contracts/index";
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

const expect = getWaffleExpect();

describe("BaseManager", () => {
  let operator: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let newManager: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManager: BaseManager;
  let baseAdapter: BaseAdapterMock;

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
    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      operator.address,
      methodologist.address,
      [],
      [[]]
    );

    // Transfer operatorship to BaseManager
    await setToken.setManager(baseManager.address);

    baseAdapter = await deployer.mocks.deployBaseAdapterMock(baseManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetToken: Address;
    let subjectAdapter: Address;
    let subjectModule: Address;
    let subjectAdditionalModule: Address;
    let subjectAdditionalAdapter: Address;
    let subjectOperator: Address;
    let subjectMethodologist: Address;
    let subjectProtectedModules: Address[];
    let subjectAuthorizedAdapters: Address[][];

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalModule = setV2Setup.issuanceModule.address;
      subjectAdapter = baseAdapter.address;
      subjectAdditionalAdapter = ADDRESS_ZERO; // Deploy as needed
      subjectOperator = operator.address;
      subjectMethodologist = methodologist.address;
      subjectProtectedModules = [subjectModule];
      subjectAuthorizedAdapters = [[]];
    });

    async function subject(): Promise<BaseManager> {
      return await deployer.manager.deployBaseManager(
        subjectSetToken,
        subjectOperator,
        subjectMethodologist,
        subjectProtectedModules,
        subjectAuthorizedAdapters
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

    describe("protectedModules: single, no extensions", () => {
      beforeEach(() => {
        subjectProtectedModules = [subjectModule];
      });

      // This test is borked... module initialized in before block..
      it("should add module to setToken", async () => {
        await subject();

        const initialized = await setToken.isInitializedModule(subjectModule);

        expect(initialized).to.be.true;
      });

      it("should protect the module", async () => {
        const retrievedICManager = await subject();

        const isProtected = await retrievedICManager.protectedModules(subjectModule);
        expect(isProtected).to.be.true;
      });

      it("should be added to the protectedModules list", async () => {
        const retrievedICManager = await subject();

        const protectedModules = await retrievedICManager.getProtectedModules();
        expect(protectedModules.includes(subjectModule)).to.be.true;
      });
    });

    describe("protectedModules: single, with multiple extension", () => {
      beforeEach(async () => {
        subjectAdditionalAdapter = (await deployer.mocks.deployBaseAdapterMock(baseManager.address)).address;
        subjectProtectedModules = [subjectModule];
        subjectAuthorizedAdapters = [[subjectAdapter, subjectAdditionalAdapter]];
      });

      it("should protect the module", async () => {
        const retrievedICManager = await subject();

        const isProtected = await retrievedICManager.protectedModules(subjectModule);
        expect(isProtected).to.be.true;
      });

      it("should add the extensions", async () => {
        const retrievedICManager = await subject();

        const isSubjectAdapter = await retrievedICManager.isAdapter(subjectAdapter);
        const isSubjectAdditionalAdapter = await retrievedICManager.isAdapter(subjectAdditionalAdapter);

        expect(isSubjectAdapter).to.be.true;
        expect(isSubjectAdditionalAdapter).to.be.true;
      });

      it("should authorize the extensions for the module", async () => {
        const retrievedICManager = await subject();

        const isAuthorizedSubjectAdapter = await retrievedICManager
          .isAuthorizedAdapter(subjectModule, subjectAdapter);

        const isAuthorizedSubjectAdditionalAdapter = await retrievedICManager
          .isAuthorizedAdapter(subjectModule, subjectAdditionalAdapter);

        expect(isAuthorizedSubjectAdapter).to.be.true;
        expect(isAuthorizedSubjectAdditionalAdapter).to.be.true;
      });
    });

    describe("protectedModules: multiple, with extensions", () => {
      beforeEach(async () => {
        subjectAdditionalAdapter = (await deployer.mocks.deployBaseAdapterMock(baseManager.address)).address;
        subjectProtectedModules = [subjectModule, subjectAdditionalModule];
        subjectAuthorizedAdapters = [ [subjectAdapter], [subjectAdditionalAdapter] ];
      });

      it("should protect the module", async () => {
        const retrievedICManager = await subject();

        const isProtectedSubjectModule = await retrievedICManager
          .protectedModules(subjectModule);

        const isProtectedSubjectAdditionalModule = await retrievedICManager
          .protectedModules(subjectAdditionalModule);

        expect(isProtectedSubjectModule).to.be.true;
        expect(isProtectedSubjectAdditionalModule).to.be.true;
      });

      it("should add the adapters", async () => {
        const retrievedICManager = await subject();

        const isSubjectAdapter = await retrievedICManager.isAdapter(subjectAdapter);
        const isSubjectAdditionalAdapter = await retrievedICManager.isAdapter(subjectAdditionalAdapter);

        expect(isSubjectAdapter).to.be.true;
        expect(isSubjectAdditionalAdapter).to.be.true;
      });

      it("should authorize the adapters correctly", async () => {
        const retrievedICManager = await subject();

        const isAuthorizedSubjectAdapter = await retrievedICManager
          .isAuthorizedAdapter(subjectModule, subjectAdapter);

        const isAuthorizedSubjectAdditionalAdapter = await retrievedICManager
          .isAuthorizedAdapter(subjectAdditionalModule, subjectAdditionalAdapter);

        const transposedAdapterIsAuthorized = await retrievedICManager
          .isAuthorizedAdapter(subjectModule, subjectAdditionalAdapter);

        expect(isAuthorizedSubjectAdapter).to.be.true;
        expect(isAuthorizedSubjectAdditionalAdapter).to.be.true;
        expect(transposedAdapterIsAuthorized).to.be.false;
      });
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

  describe("#addAdapter", async () => {
    let subjectModule: Address;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).addAdapter(subjectAdapter);
    }

    it("should add the adapter address", async () => {
      await subject();
      const adapters = await baseManager.getAdapters();

      expect(adapters[0]).to.eq(baseAdapter.address);
    });

    it("should set the adapter mapping", async () => {
      await subject();
      const isAdapter = await baseManager.isAdapter(subjectAdapter);

      expect(isAdapter).to.be.true;
    });

    it("should emit the correct AdapterAdded event", async () => {
      await expect(subject()).to.emit(baseManager, "AdapterAdded").withArgs(baseAdapter.address);
    });

    describe("when the adapter already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter already exists");
      });
    });

    describe("when adapter has different manager address", async () => {
      beforeEach(async () => {
        subjectAdapter = (await deployer.mocks.deployBaseAdapterMock(await getRandomAddress())).address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter manager invalid");
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

  describe("#removeAdapter", async () => {
    let subjectModule: Address;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await baseManager.connect(operator.wallet).addAdapter(baseAdapter.address);

      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).removeAdapter(subjectAdapter);
    }

    it("should remove the adapter address", async () => {
      await subject();
      const adapters = await baseManager.getAdapters();

      expect(adapters.length).to.eq(0);
    });

    it("should set the adapter mapping", async () => {
      await subject();
      const isAdapter = await baseManager.isAdapter(subjectAdapter);

      expect(isAdapter).to.be.false;
    });

    it("should emit the correct AdapterRemoved event", async () => {
      await expect(subject()).to.emit(baseManager, "AdapterRemoved").withArgs(baseAdapter.address);
    });

    describe("when the adapter does not exist", async () => {
      beforeEach(async () => {
        subjectAdapter = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter does not exist");
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

    describe("when the adapter is authorized for a protected module", () => {
      beforeEach(() => {
        baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
      });

      it("should revert", async() => {
        await expect(subject()).to.be.revertedWith("Adapter used by protected module");
      });
    });
  });

  describe("#authorizeAdapter", () => {
    let subjectModule: Address;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager.connect(caller.wallet).authorizeAdapter(subjectModule, subjectAdapter);
    }

    describe("when adapter is not authorized and already added", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should authorize the adapter", async () => {
        const initialAuthorization = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject(operator);
        await subject(methodologist);

        const finalAuthorization = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(initialAuthorization).to.be.false;
        expect(finalAuthorization).to.be.true;
      });
    });

    describe("when adapter is not already added to the manager", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        const initialAdapterStatus = await baseManager.connect(operator.wallet).isAdapter(subjectAdapter);

        await subject(operator);

        await expect(initialAdapterStatus).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Adapter does not exist");
      });
    });

    describe("when the adapter is already authorized for target module", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
      });

      it("should revert", async () => {
        await subject(operator);
        await expect(subject(methodologist)).to.be.revertedWith("Adapter already authorized");
      });
    });

    describe("when target module is not protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
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

  describe("#revokeAdapterAuthorization", () => {
    let subjectModule: Address;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager.connect(caller.wallet).revokeAdapterAuthorization(subjectModule, subjectAdapter);
    }

    describe("when adapter is authorized", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
      });

      it("should revoke adapter authorization", async () => {
        const initialAuthorization = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject(operator);
        await subject(methodologist);

        const finalAuthorization = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(initialAuthorization).to.be.true;
        expect(finalAuthorization).to.be.false;
      });
    });

    describe("when adapter is not added to the manager", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        const initialAdapterStatus = await baseManager.connect(operator.wallet).isAdapter(subjectAdapter);

        await subject(operator);

        await expect(initialAdapterStatus).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Adapter does not exist");
      });
    });

    describe("when the adapter is not authorized for target module", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        const initialAuthorization = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject(operator);
        await expect(initialAuthorization).to.be.false;
        await expect(subject(methodologist)).to.be.revertedWith("Adapter not authorized");
      });
    });

    describe("when target module is not protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
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
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalModule = setV2Setup.governanceModule.address; // Removable
      subjectAdapter = baseAdapter.address;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).emergencyRemoveProtectedModule(subjectModule);
    }

    describe("when module is protected", async () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
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
        const initialAuthorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectModule);
        const initialIsAuthorized = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject();

        const finalAuthorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectModule);
        const finalIsAuthorized = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(initialAuthorizedAdaptersList.length).equals(1);
        expect(initialIsAuthorized).to.be.true;
        expect(finalAuthorizedAdaptersList.length).equals(0);
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
        await baseAdapter.interactManager(subjectModule, initializeData);
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);

        const authorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectModule);
        const isAuthorized = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(authorizedAdaptersList.length).equals(0);
        expect(isAuthorized).to.be.false;
      });

      it("should increment the emergencies counter", async () => {
        const initialEmergencies = await baseManager.emergencies();

        await subject();

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(0);
        expect(finalEmergencies.toNumber()).equals(1);
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
    let subjectAdapter: Address;
    let subjectAuthorizedAdapters: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
      subjectAdditionalModule = setV2Setup.governanceModule.address; // Removable
      subjectAuthorizedAdapters = [];
    });

    async function subject(): Promise<any> {
      return baseManager
        .connect(subjectCaller.wallet)
        .protectModule(subjectModule, subjectAuthorizedAdapters);
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

    describe("when module already added, with non-added adapter", () => {
      beforeEach(() => {
        subjectAuthorizedAdapters = [subjectAdapter];
      });
      it("should add and authorize the adapter", async () => {
        const initialIsAdapter = await baseManager.isAdapter(subjectAdapter);
        const initialIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject();

        const finalIsAdapter = await baseManager.isAdapter(subjectAdapter);
        const finalIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(initialIsAdapter).to.be.false;
        expect(finalIsAdapter).to.be.true;
        expect(initialIsAuthorizedAdapter).to.be.false;
        expect(finalIsAuthorizedAdapter).to.be.true;
      });
    });

    describe("when module and adapter already added", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).addAdapter(subjectAdapter);
        subjectAuthorizedAdapters = [subjectAdapter];
      });

      it("should authorize the adapter", async () => {
        const initialIsAdapter = await baseManager.isAdapter(subjectAdapter);
        const initialIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject();

        const finalIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(initialIsAdapter).to.be.true;
        expect(initialIsAuthorizedAdapter).to.be.false;
        expect(finalIsAuthorizedAdapter).to.be.true;
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
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
    });

    async function subject(): Promise<any> {
      return baseManager.connect(subjectCaller.wallet).unProtectModule(subjectModule);
    }

    describe("when module is protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
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
        const initialAuthorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectModule);
        const initialIsAuthorized = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        await subject();

        const finalAuthorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectModule);
        const finalIsAuthorized = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(initialAuthorizedAdaptersList.length).equals(1);
        expect(initialIsAuthorized).to.be.true;
        expect(finalAuthorizedAdaptersList.length).equals(0);
        expect(finalIsAuthorized).to.be.false;
      });

      it("should not preserve any settings if same module is removed and restored", async () => {
        await subject();

        // Restore without adapter
        await baseManager.protectModule(subjectModule, []);

        const authorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectModule);
        const isAuthorized = await baseManager.isAuthorizedAdapter(subjectModule, subjectAdapter);

        expect(authorizedAdaptersList.length).equals(0);
        expect(isAuthorized).to.be.false;
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
    let subjectOldAdapter: Address;
    let subjectNewAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectCaller = operator;
      subjectOldModule = setV2Setup.streamingFeeModule.address;
      subjectNewModule = otherAccount.address;
      subjectOldAdapter = baseAdapter.address;
      subjectNewAdapter = (await deployer.mocks.deployBaseAdapterMock(baseManager.address)).address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager
        .connect(caller.wallet)
        .replaceProtectedModule(subjectOldModule, subjectNewModule, [subjectNewAdapter]);
    }

    describe("when old module is protected", () => {
      beforeEach(async () => {
        await baseManager.connect(operator.wallet).protectModule(subjectOldModule, [subjectOldAdapter]);
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

        it("should clear the old modules authorized adapter registries", async () => {
          const initialAuthorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectOldModule);
          const initialIsAuthorized = await baseManager.isAuthorizedAdapter(subjectOldModule, subjectOldAdapter);

          await subject(operator);
          await subject(methodologist);

          const finalAuthorizedAdaptersList = await baseManager.getAuthorizedAdapters(subjectOldModule);
          const finalIsAuthorized = await baseManager.isAuthorizedAdapter(subjectOldModule, subjectOldAdapter);

          expect(initialAuthorizedAdaptersList.length).equals(1);
          expect(initialIsAuthorized).to.be.true;
          expect(finalAuthorizedAdaptersList.length).equals(0);
          expect(finalIsAuthorized).to.be.false;
        });

        it("should add and authorize the new module adapter", async () => {
          const initialIsAdapter = await baseManager.isAdapter(subjectNewAdapter);
          const initialIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(
            subjectNewModule, subjectNewAdapter
          );

          await subject(operator);
          await subject(methodologist);

          const finalIsAdapter = await baseManager.isAdapter(subjectNewAdapter);
          const finalIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(
            subjectNewModule,
            subjectNewAdapter
          );

          expect(initialIsAdapter).to.be.false;
          expect(finalIsAdapter).to.be.true;
          expect(initialIsAuthorizedAdapter).to.be.false;
          expect(finalIsAuthorizedAdapter).to.be.true;
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
    let subjectNewAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectCaller = operator;
      subjectOldModule = setV2Setup.streamingFeeModule.address;
      subjectAdditionalOldModule = setV2Setup.governanceModule.address; // Removable
      subjectNewModule = otherAccount.address;
      subjectNewAdapter = (await deployer.mocks.deployBaseAdapterMock(baseManager.address)).address;
    });

    async function subject(caller: Account): Promise<any> {
      return baseManager
        .connect(caller.wallet)
        .emergencyReplaceProtectedModule(subjectNewModule, [subjectNewAdapter]);
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

      it("should add and authorize the new module adapter", async () => {
        const initialIsAdapter = await baseManager.isAdapter(subjectNewAdapter);
        const initialIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(
          subjectNewModule, subjectNewAdapter
        );

        await subject(operator);
        await subject(methodologist);

        const finalIsAdapter = await baseManager.isAdapter(subjectNewAdapter);
        const finalIsAuthorizedAdapter = await baseManager.isAuthorizedAdapter(
          subjectNewModule,
          subjectNewAdapter
        );

        expect(initialIsAdapter).to.be.false;
        expect(finalIsAdapter).to.be.true;
        expect(initialIsAuthorizedAdapter).to.be.false;
        expect(finalIsAuthorizedAdapter).to.be.true;
      });

      it("should decrement the emergencies counter", async() => {
        const initialEmergencies = await baseManager.emergencies();

        await subject(operator);
        await subject(methodologist);

        const finalEmergencies = await baseManager.emergencies();

        expect(initialEmergencies.toNumber()).equals(1);
        expect(finalEmergencies.toNumber()).equals(0);
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
    });

    describe("when an emergency is *not* in progress", async () => {
      it("should revert", async () => {});
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
    let subjectAdapter: Address;
    let subjectCallData: Bytes;

    beforeEach(async () => {
      await baseManager.connect(operator.wallet).addAdapter(baseAdapter.address);

      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;

      // Invoke update fee recipient
      subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);
    });

    async function subject(): Promise<any> {
      return baseAdapter.interactManager(subjectModule, subjectCallData);
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

      describe("when the caller is not an adapter", async () => {
        beforeEach(async () => {
          await baseManager.connect(operator.wallet).removeAdapter(baseAdapter.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be adapter");
        });
      });
    });

    context("when the manager is not initialized", () => {
      it("updateFeeRecipient should revert", async () => {
        expect(subject()).to.be.revertedWith("Manager not initialized");
      });
    });

    context("when the module is protected and adapter is authorized", () => {
      beforeEach(async () => {
        await baseManager.connect(methodologist.wallet).authorizeInitialization();
        await baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
      });

      it("updateFeeRecipient should succeed", async () => {
        await subject();
        const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        expect(feeStates.feeRecipient).to.eq(otherAccount.address);
      });
    });

    context("when the module is protected and adapter is not authorized", () => {
      beforeEach(async () => {
        await baseManager.connect(methodologist.wallet).authorizeInitialization();
        await baseManager.connect(operator.wallet).protectModule(subjectModule, []);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter not authorized for module");
      });
    });
  });

  describe("#removeModule", async () => {
    let subjectModule: Address;
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectAdapter = baseAdapter.address;
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
      beforeEach(() => {
        baseManager.connect(operator.wallet).protectModule(subjectModule, [subjectAdapter]);
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
});
