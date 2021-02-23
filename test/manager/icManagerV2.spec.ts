import "module-alias/register";
import { solidityKeccak256 } from "ethers/lib/utils";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ICManagerV2 } from "@utils/contracts/index";
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
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("ICManagerV2", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let newManager: Account;
  let mockAdapter: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let icManagerV2: ICManagerV2;

  before(async () => {
    [
      owner,
      otherAccount,
      newManager,
      methodologist,
      mockAdapter,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Initialize modules
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    // Deploy ICManagerV2
    icManagerV2 = await deployer.manager.deployICManagerV2(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to ICManagerV2
    await setToken.setManager(icManagerV2.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetToken: Address;
    let subjectOperator: Address;
    let subjectMethodologist: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectOperator = owner.address;
      subjectMethodologist = methodologist.address;
    });

    async function subject(): Promise<ICManagerV2> {
      return await deployer.manager.deployICManagerV2(
        subjectSetToken,
        subjectOperator,
        subjectMethodologist,
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

  describe("#initializeAdapters", async () => {
    let subjectAdapters: Address[];

    beforeEach(async () => {
      subjectAdapters = [await getRandomAddress(), await getRandomAddress()];
    });

    async function subject(): Promise<ContractTransaction> {
      return await icManagerV2.initializeAdapters(subjectAdapters);
    }

    it("should set the correct adapters", async () => {
      await subject();

      const actualAdapters = await icManagerV2.getAdapters();
      expect(JSON.stringify(actualAdapters)).to.eq(JSON.stringify(subjectAdapters));
    });

    it("should set the adapter mapping", async () => {
      await subject();
      const isAdapterOne = await icManagerV2.isAdapter(subjectAdapters[0]);
      const isAdapterTwo = await icManagerV2.isAdapter(subjectAdapters[1]);

      expect(isAdapterOne).to.be.true;
      expect(isAdapterTwo).to.be.true;
    });

    it("flips the initialized flag to true", async () => {
      await subject();

      const isInitialized = await icManagerV2.initialized();

      expect(isInitialized).to.be.true;
    });

    describe("when the adapter already exists", async () => {
      beforeEach(async () => {
        subjectAdapters = [mockAdapter.address, mockAdapter.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter already exists");
      });
    });

    describe("when initializedAdapters has already been called", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Manager already initialized");
      });
    });
  });

  describe("#setManager", async () => {
    let subjectNewManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewManager = newManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.setManager(subjectNewManager);
    }

    it("should log the proposed manager hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManagerV2.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed manager hash is already set", async () => {
      beforeEach(async () => {
        await icManagerV2.connect(owner.wallet).setManager(newManager.address);

        subjectCaller = methodologist;
      });

      it("should change the manager address", async () => {
        await subject();
        const manager = await setToken.manager();

        expect(manager).to.eq(newManager.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#addAdapter", async () => {
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectAdapter = mockAdapter.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.addAdapter(subjectAdapter);
    }

    it("should log the proposed adapter hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManagerV2.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed adapter hash is already set", async () => {
      beforeEach(async () => {
        await icManagerV2.connect(owner.wallet).addAdapter(mockAdapter.address);

        subjectCaller = methodologist;
      });

      it("should add the adapter address", async () => {
        await subject();
        const adapters = await icManagerV2.getAdapters();

        expect(adapters[0]).to.eq(mockAdapter.address);
      });

      it("should set the adapter mapping", async () => {
        await subject();
        const isAdapter = await icManagerV2.isAdapter(subjectAdapter);

        expect(isAdapter).to.be.true;
      });

      it("should emit the correct AdapterAdded event", async () => {
        await expect(subject()).to.emit(icManagerV2, "AdapterAdded").withArgs(mockAdapter.address);
      });
    });

    describe("when the adapter already exists", async () => {
      beforeEach(async () => {
        await icManagerV2.connect(owner.wallet).addAdapter(mockAdapter.address);
        subjectCaller = methodologist;
        await subject();
        await icManagerV2.connect(owner.wallet).addAdapter(mockAdapter.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter already exists");
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#removeAdapter", async () => {
    let subjectAdapter: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await icManagerV2.connect(owner.wallet).addAdapter(mockAdapter.address);
      await icManagerV2.connect(methodologist.wallet).addAdapter(mockAdapter.address);

      subjectAdapter = mockAdapter.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.removeAdapter(subjectAdapter);
    }

    it("should log the proposed adapter hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManagerV2.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed adapter hash is already set", async () => {
      beforeEach(async () => {
        await icManagerV2.connect(owner.wallet).removeAdapter(mockAdapter.address);

        subjectCaller = methodologist;
      });

      it("should remove the adapter address", async () => {
        await subject();
        const adapters = await icManagerV2.getAdapters();

        expect(adapters.length).to.eq(0);
      });

      it("should set the adapter mapping", async () => {
        await subject();
        const isAdapter = await icManagerV2.isAdapter(subjectAdapter);

        expect(isAdapter).to.be.false;
      });

      it("should emit the correct AdapterRemoved event", async () => {
        await expect(subject()).to.emit(icManagerV2, "AdapterRemoved").withArgs(mockAdapter.address);
      });
    });

    describe("when the adapter does not exist", async () => {
      beforeEach(async () => {
        subjectAdapter = await getRandomAddress();

        await icManagerV2.connect(owner.wallet).removeAdapter(subjectAdapter);
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Adapter does not exist");
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#addModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectModule = otherAccount.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.addModule(subjectModule);
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

  describe("#interactModule", async () => {
    let subjectModule: Address;
    let subjectCallData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      await icManagerV2.connect(owner.wallet).addAdapter(owner.address);
      await icManagerV2.connect(methodologist.wallet).addAdapter(owner.address);

      subjectModule = setV2Setup.streamingFeeModule.address;

      // Invoke update fee recipient
      subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.interactModule(subjectModule, subjectCallData);
    }

    it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
      await subject();
      const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(feeStates.feeRecipient).to.eq(otherAccount.address);
    });

    describe("when the caller is not an adapter", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be adapter");
      });
    });
  });

  describe("#removeModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.removeModule(subjectModule);
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
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.setMethodologist(subjectNewMethodologist);
    }

    it("should set the new methodologist", async () => {
      await subject();
      const actualIndexModule = await icManagerV2.methodologist();
      expect(actualIndexModule).to.eq(subjectNewMethodologist);
    });

    it("should emit the correct MethodologistChanged event", async () => {
      await expect(subject()).to.emit(icManagerV2, "MethodologistChanged").withArgs(methodologist.address, subjectNewMethodologist);
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
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManagerV2 = icManagerV2.connect(subjectCaller.wallet);
      return icManagerV2.setOperator(subjectNewOperator);
    }

    it("should set the new operator", async () => {
      await subject();
      const actualIndexModule = await icManagerV2.operator();
      expect(actualIndexModule).to.eq(subjectNewOperator);
    });

    it("should emit the correct OperatorChanged event", async () => {
      await expect(subject()).to.emit(icManagerV2, "OperatorChanged").withArgs(owner.address, subjectNewOperator);
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
