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
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Initialize modules
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
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
    let subjectOperator: Address;
    let subjectMethodologist: Address;
    let subjectProtectedModules: Address[];
    let subjectAuthorizedExtensions: Address[][];

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectOperator = operator.address;
      subjectMethodologist = methodologist.address;
      subjectProtectedModules = [setV2Setup.streamingFeeModule.address];
      subjectAuthorizedExtensions = [[]];
    });

    async function subject(): Promise<BaseManager> {
      return await deployer.manager.deployBaseManager(
        subjectSetToken,
        subjectOperator,
        subjectMethodologist,
        subjectProtectedModules,
        subjectAuthorizedExtensions
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
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
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
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await baseManager.connect(operator.wallet).addAdapter(baseAdapter.address);

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

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
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
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
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
