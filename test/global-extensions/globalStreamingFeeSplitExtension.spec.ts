import "module-alias/register";

import {
  BigNumber,
  Contract,
  ContractTransaction
} from "ethers";
import {
  Address,
  Account,
  StreamingFeeState
} from "@utils/types";
import { ADDRESS_ZERO, ONE_YEAR_IN_SECONDS, ZERO } from "@utils/constants";
import {
  DelegatedManager,
  GlobalStreamingFeeSplitExtension,
  ManagerCore
} from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  increaseTimeAsync,
  preciseMul,
  getTransactionTimestamp,
  getSetFixture,
  getRandomAccount
} from "@utils/index";
import { getStreamingFee, getStreamingFeeInflationAmount } from "@utils/common";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("GlobalStreamingFeeSplitExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SetFixture;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let streamingFeeSplitExtension: GlobalStreamingFeeSplitExtension;

  let feeRecipient: Address;
  let maxStreamingFeePercentage: BigNumber;
  let streamingFeePercentage: BigNumber;
  let feeSettings: StreamingFeeState;

  let ownerFeeSplit: BigNumber;
  let ownerFeeRecipient: Address;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      factory,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    managerCore = await deployer.managerCore.deployManagerCore();

    streamingFeeSplitExtension = await deployer.globalExtensions.deployGlobalStreamingFeeSplitExtension(
      managerCore.address,
      setV2Setup.streamingFeeModule.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [streamingFeeSplitExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    ownerFeeSplit = ether(0.1);
    await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ownerFeeSplit);
    await delegatedManager.connect(methodologist.wallet).updateOwnerFeeSplit(ownerFeeSplit);
    ownerFeeRecipient = owner.address;
    await delegatedManager.connect(owner.wallet).updateOwnerFeeRecipient(ownerFeeRecipient);

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([streamingFeeSplitExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);

    feeRecipient = delegatedManager.address;
    maxStreamingFeePercentage = ether(.1);
    streamingFeePercentage = ether(.02);

    feeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectStreamingFeeModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
    });

    async function subject(): Promise<GlobalStreamingFeeSplitExtension> {
      return await deployer.globalExtensions.deployGlobalStreamingFeeSplitExtension(
        subjectManagerCore,
        subjectStreamingFeeModule
      );
    }

    it("should set the correct StreamingFeeModule address", async () => {
      const streamingFeeSplitExtension = await subject();

      const storedModule = await streamingFeeSplitExtension.streamingFeeModule();
      expect(storedModule).to.eq(subjectStreamingFeeModule);
    });
  });

  describe("#initializeModule", async () => {
    let subjectFeeSettings: StreamingFeeState;
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectFeeSettings = feeSettings;
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeModule(subjectDelegatedManager, subjectFeeSettings);
    }

    it("should correctly initialize the StreamingFeeModule on the SetToken", async () => {
      const txTimestamp = await getTransactionTimestamp(subject());

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(setV2Setup.streamingFeeModule.address);
      expect(isModuleInitialized).to.eq(true);

      const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(storedFeeState.feeRecipient).to.eq(feeRecipient);
      expect(storedFeeState.maxStreamingFeePercentage).to.eq(maxStreamingFeePercentage);
      expect(storedFeeState.streamingFeePercentage).to.eq(streamingFeePercentage);
      expect(storedFeeState.lastStreamingFeeTimestamp).to.eq(txTimestamp);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the StreamingFeeModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(setV2Setup.streamingFeeModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([streamingFeeSplitExtension.address]);
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the StreamingFeeModule is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be initialized");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be initialized");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#initializeExtension", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the StreamingFeeSplitExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await streamingFeeSplitExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the StreamingFeeSplitExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(streamingFeeSplitExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct StreamingFeeSplitExtensionInitialized event", async () => {
      await expect(subject()).to.emit(
        streamingFeeSplitExtension,
        "StreamingFeeSplitExtensionInitialized"
      ).withArgs(setToken.address, delegatedManager.address);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#initializeModuleAndExtension", async () => {
    let subjectFeeSettings: StreamingFeeState;
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectFeeSettings = feeSettings;
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return streamingFeeSplitExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager, subjectFeeSettings);
    }

    it("should correctly initialize the StreamingFeeModule on the SetToken", async () => {
      const txTimestamp = await getTransactionTimestamp(subject());

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(setV2Setup.streamingFeeModule.address);
      expect(isModuleInitialized).to.eq(true);

      const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(storedFeeState.feeRecipient).to.eq(feeRecipient);
      expect(storedFeeState.maxStreamingFeePercentage).to.eq(maxStreamingFeePercentage);
      expect(storedFeeState.streamingFeePercentage).to.eq(streamingFeePercentage);
      expect(storedFeeState.lastStreamingFeeTimestamp).to.eq(txTimestamp);
    });

    it("should store the correct SetToken and DelegatedManager on the StreamingFeeSplitExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await streamingFeeSplitExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the StreamingFeeSplitExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(streamingFeeSplitExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct StreamingFeeSplitExtensionInitialized event", async () => {
      await expect(subject()).to.emit(
        streamingFeeSplitExtension,
        "StreamingFeeSplitExtensionInitialized"
      ).withArgs(setToken.address, delegatedManager.address);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the StreamingFeeModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(subjectDelegatedManager, feeSettings);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(setV2Setup.streamingFeeModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the StreamingFeeModule is already initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(subjectDelegatedManager, feeSettings);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([streamingFeeSplitExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the manager is not a ManagerCore-enabled manager", async () => {
      beforeEach(async () => {
        await managerCore.connect(owner.wallet).removeManager(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be ManagerCore-enabled manager");
      });
    });
  });

  describe("#removeExtension", async () => {
    let subjectManager: Contract;
    let subjectStreamingFeeSplitExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await streamingFeeSplitExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectStreamingFeeSplitExtension = [streamingFeeSplitExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectStreamingFeeSplitExtension);
    }

    it("should clear SetToken and DelegatedManager from StreamingFeeSplitExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await streamingFeeSplitExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(
        streamingFeeSplitExtension,
        "ExtensionRemoved"
      ).withArgs(setToken.address, delegatedManager.address);
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectManager = await deployer.mocks.deployManagerMock(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be Manager");
      });
    });
  });

  describe("#updateStreamingFee", async () => {
    let mintedTokens: BigNumber;
    const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

    let subjectNewFee: BigNumber;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      mintedTokens = ether(2);
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
      await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, owner.address);

      await increaseTimeAsync(timeFastForward);

      await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address, feeSettings);

      subjectNewFee = ether(.01);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await streamingFeeSplitExtension.connect(subjectCaller.wallet).updateStreamingFee(subjectSetToken, subjectNewFee);
    }

    it("should update the streaming fee on the StreamingFeeModule", async () => {
      await subject();

      const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(storedFeeState.streamingFeePercentage).to.eq(subjectNewFee);
    });

    it("should send correct amount of fees to the DelegatedManager", async () => {
      const preManagerBalance = await setToken.balanceOf(delegatedManager.address);
      const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      const totalSupply = await setToken.totalSupply();
      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        setV2Setup.streamingFeeModule,
        setToken.address,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp,
        ether(.02)
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

      const postManagerBalance = await setToken.balanceOf(delegatedManager.address);

      expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
  });

  describe("#updateFeeRecipient", async () => {
    let subjectNewFeeRecipient: Address;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address, feeSettings);

      subjectNewFeeRecipient = factory.address;
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await streamingFeeSplitExtension.connect(subjectCaller.wallet).updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("should update the fee recipient on the StreamingFeeModule", async () => {
      await subject();

      const storedFeeState: StreamingFeeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(storedFeeState.feeRecipient).to.eq(subjectNewFeeRecipient);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });
  });

  describe("#accrueFeesAndDistribute", async () => {
    let mintedTokens: BigNumber;
    const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;
    let subjectSetToken: Address;

    beforeEach(async () => {
      await streamingFeeSplitExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address, feeSettings);

      mintedTokens = ether(2);
      await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
      await setV2Setup.issuanceModule.issue(setToken.address, mintedTokens, factory.address);

      await increaseTimeAsync(timeFastForward);

      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await streamingFeeSplitExtension.accrueFeesAndDistribute(subjectSetToken);
    }

    it("should send correct amount of fees to owner fee recipient and methodologist", async () => {
      const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      const totalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        setV2Setup.streamingFeeModule,
        setToken.address,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

      const expectedOwnerTake = preciseMul(feeInflation, ownerFeeSplit);
      const expectedMethodologistTake = feeInflation.sub(expectedOwnerTake);

      const ownerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);
      const methodologistBalance = await setToken.balanceOf(methodologist.address);

      expect(ownerFeeRecipientBalance).to.eq(expectedOwnerTake);
      expect(methodologistBalance).to.eq(expectedMethodologistTake);
    });

    it("should emit a FeesDistributed event", async () => {
      await expect(subject()).to.emit(streamingFeeSplitExtension, "FeesDistributed");
    });

    describe("when methodologist fees are 0", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ether(1));
        await delegatedManager.connect(methodologist.wallet).updateOwnerFeeSplit(ether(1));
      });

      it("should not send fees to methodologist", async () => {
        const preMethodologistBalance = await setToken.balanceOf(methodologist.address);

        await subject();

        const postMethodologistBalance = await setToken.balanceOf(methodologist.address);
        expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
      });
    });

    describe("when owner fees are 0", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ZERO);
        await delegatedManager.connect(methodologist.wallet).updateOwnerFeeSplit(ZERO);
      });

      it("should not send fees to owner fee recipient", async () => {
        const preOwnerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);

        await subject();

        const postOwnerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);
        expect(postOwnerFeeRecipientBalance.sub(preOwnerFeeRecipientBalance)).to.eq(ZERO);
      });
    });
  });
});
