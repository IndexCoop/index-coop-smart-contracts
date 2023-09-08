import "module-alias/register";

import {
  BigNumber,
  Contract,
  ContractTransaction
} from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  DelegatedManager,
  GlobalIssuanceExtension,
  ManagerCore
} from "@utils/contracts/index";
import { SetToken, DebtIssuanceModuleV2 } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  preciseMul,
  getSetFixture,
  getRandomAccount,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("GlobalIssuanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SetFixture;

  let issuanceModule: DebtIssuanceModuleV2;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let issuanceExtension: GlobalIssuanceExtension;

  let maxManagerFee: BigNumber;
  let managerIssueFee: BigNumber;
  let managerRedeemFee: BigNumber;
  let feeRecipient: Address;
  let managerIssuanceHook: Address;

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

    issuanceModule = await deployer.setV2.deployDebtIssuanceModuleV2(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(issuanceModule.address);

    managerCore = await deployer.managerCore.deployManagerCore();

    issuanceExtension = await deployer.globalExtensions.deployGlobalIssuanceExtension(
      managerCore.address,
      issuanceModule.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [issuanceModule.address]
    );

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [issuanceExtension.address],
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

    await managerCore.initialize([issuanceExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);

    maxManagerFee = ether(.1);
    managerIssueFee = ether(.02);
    managerRedeemFee = ether(.03);
    feeRecipient = delegatedManager.address;
    managerIssuanceHook = ADDRESS_ZERO;
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectIssuanceModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectIssuanceModule = issuanceModule.address;
    });

    async function subject(): Promise<GlobalIssuanceExtension> {
      return await deployer.globalExtensions.deployGlobalIssuanceExtension(
        subjectManagerCore,
        subjectIssuanceModule
      );
    }

    it("should set the correct IssuanceModule address", async () => {
      const issuanceExtension = await subject();

      const storedModule = await issuanceExtension.issuanceModule();
      expect(storedModule).to.eq(subjectIssuanceModule);
    });
  });

  describe("#initializeModule", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;
    let subjectMaxManagerFee: BigNumber;
    let subjectManagerIssueFee: BigNumber;
    let subjectManagerRedeemFee: BigNumber;
    let subjectFeeRecipient: Address;
    let subjectManagerIssuanceHook: Address;

    beforeEach(async () => {
      await issuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
      subjectMaxManagerFee = maxManagerFee;
      subjectManagerIssueFee = managerIssueFee;
      subjectManagerRedeemFee = managerRedeemFee;
      subjectFeeRecipient = feeRecipient;
      subjectManagerIssuanceHook = managerIssuanceHook;
    });

    async function subject(): Promise<ContractTransaction> {
      return issuanceExtension.connect(subjectCaller.wallet).initializeModule(
        subjectDelegatedManager,
        subjectMaxManagerFee,
        subjectManagerIssueFee,
        subjectManagerRedeemFee,
        subjectFeeRecipient,
        subjectManagerIssuanceHook
      );
    }

    it("should correctly initialize the IssuanceModule on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(issuanceModule.address);
      expect(isModuleInitialized).to.eq(true);

      const storedSettings: any = await issuanceModule.issuanceSettings(setToken.address);

      expect(storedSettings.maxManagerFee).to.eq(maxManagerFee);
      expect(storedSettings.managerIssueFee).to.eq(managerIssueFee);
      expect(storedSettings.managerRedeemFee).to.eq(managerRedeemFee);
      expect(storedSettings.feeRecipient).to.eq(feeRecipient);
      expect(storedSettings.managerIssuanceHook).to.eq(managerIssuanceHook);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the IssuanceModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(issuanceModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([issuanceExtension.address]);
        await issuanceExtension.connect(subjectCaller.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the IssuanceModule is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be initialized");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([issuanceExtension.address]);
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
      return issuanceExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the IssuanceExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await issuanceExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the IssuanceExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(issuanceExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct IssuanceExtensionInitialized event", async () => {
      await expect(subject()).to.emit(
        issuanceExtension,
        "IssuanceExtensionInitialized"
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
        await issuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await issuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;
    let subjectMaxManagerFee: BigNumber;
    let subjectManagerIssueFee: BigNumber;
    let subjectManagerRedeemFee: BigNumber;
    let subjectFeeRecipient: Address;
    let subjectManagerIssuanceHook: Address;

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
      subjectMaxManagerFee = maxManagerFee;
      subjectManagerIssueFee = managerIssueFee;
      subjectManagerRedeemFee = managerRedeemFee;
      subjectFeeRecipient = feeRecipient;
      subjectManagerIssuanceHook = managerIssuanceHook;
    });

    async function subject(): Promise<ContractTransaction> {
      return issuanceExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(
        subjectDelegatedManager,
        subjectMaxManagerFee,
        subjectManagerIssueFee,
        subjectManagerRedeemFee,
        subjectFeeRecipient,
        subjectManagerIssuanceHook
      );
    }

    it("should correctly initialize the IssuanceModule on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(issuanceModule.address);
      expect(isModuleInitialized).to.eq(true);

      const storedSettings: any = await issuanceModule.issuanceSettings(setToken.address);

      expect(storedSettings.maxManagerFee).to.eq(maxManagerFee);
      expect(storedSettings.managerIssueFee).to.eq(managerIssueFee);
      expect(storedSettings.managerRedeemFee).to.eq(managerRedeemFee);
      expect(storedSettings.feeRecipient).to.eq(feeRecipient);
      expect(storedSettings.managerIssuanceHook).to.eq(managerIssuanceHook);
    });

    it("should store the correct SetToken and DelegatedManager on the IssuanceExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await issuanceExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the IssuanceExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(issuanceExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct IssuanceExtensionInitialized event", async () => {
      await expect(subject()).to.emit(
        issuanceExtension,
        "IssuanceExtensionInitialized"
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

    describe("when the IssuanceModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await issuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
          subjectDelegatedManager,
          maxManagerFee,
          managerIssueFee,
          managerRedeemFee,
          feeRecipient,
          managerIssuanceHook
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(issuanceModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([issuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the IssuanceModule is already initialized", async () => {
      beforeEach(async () => {
        await issuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
          subjectDelegatedManager,
          maxManagerFee,
          managerIssueFee,
          managerRedeemFee,
          feeRecipient,
          managerIssuanceHook
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([issuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await issuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([issuanceExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await issuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
    let subjectIssuanceExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await issuanceExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectIssuanceExtension = [issuanceExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectIssuanceExtension);
    }

    it("should clear SetToken and DelegatedManager from IssuanceExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await issuanceExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(
        issuanceExtension,
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

  describe("#updateIssueFee", async () => {
    let subjectNewFee: BigNumber;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await issuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      subjectNewFee = ether(.03);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceExtension.connect(subjectCaller.wallet).updateIssueFee(subjectSetToken, subjectNewFee);
    }

    it("should update the issue fee on the IssuanceModule", async () => {
      await subject();

      const issueState: any = await issuanceModule.issuanceSettings(setToken.address);
      expect(issueState.managerIssueFee).to.eq(subjectNewFee);
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

  describe("#updateRedeemFee", async () => {
    let subjectNewFee: BigNumber;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await issuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      subjectNewFee = ether(.02);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceExtension.connect(subjectCaller.wallet).updateRedeemFee(subjectSetToken, subjectNewFee);
    }

    it("should update the redeem fee on the IssuanceModule", async () => {
      await subject();

      const issueState: any = await issuanceModule.issuanceSettings(setToken.address);
      expect(issueState.managerRedeemFee).to.eq(subjectNewFee);
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
      await issuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      subjectNewFeeRecipient = factory.address;
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceExtension.connect(subjectCaller.wallet).updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("should update the fee recipient on the IssuanceModule", async () => {
      await subject();

      const issueState: any = await issuanceModule.issuanceSettings(setToken.address);
      expect(issueState.feeRecipient).to.eq(subjectNewFeeRecipient);
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

  describe("#distributeFees", async () => {
    let mintedTokens: BigNumber;
    let redeemedTokens: BigNumber;
    let subjectSetToken: Address;

    beforeEach(async () => {
      await issuanceExtension.connect(owner.wallet).initializeModuleAndExtension(
        delegatedManager.address,
        maxManagerFee,
        managerIssueFee,
        managerRedeemFee,
        feeRecipient,
        managerIssuanceHook
      );

      mintedTokens = ether(2);
      await setV2Setup.dai.approve(issuanceModule.address, ether(3));
      await issuanceModule.issue(setToken.address, mintedTokens, factory.address);

      redeemedTokens = ether(1);
      await setToken.approve(issuanceModule.address, ether(2));
      await issuanceModule.connect(factory.wallet).redeem(setToken.address, redeemedTokens, factory.address);

      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceExtension.distributeFees(subjectSetToken);
    }

    it("should send correct amount of fees to owner fee recipient and methodologist", async () => {
      subject();

      const expectedMintFees = preciseMul(mintedTokens, managerIssueFee);
      const expectedRedeemFees = preciseMul(redeemedTokens, managerRedeemFee);
      const expectedMintRedeemFees = expectedMintFees.add(expectedRedeemFees);

      const expectedOwnerTake = preciseMul(expectedMintRedeemFees, ownerFeeSplit);
      const expectedMethodologistTake = expectedMintRedeemFees.sub(expectedOwnerTake);

      const ownerFeeRecipientBalance = await setToken.balanceOf(ownerFeeRecipient);
      const methodologistBalance = await setToken.balanceOf(methodologist.address);

      expect(ownerFeeRecipientBalance).to.eq(expectedOwnerTake);
      expect(methodologistBalance).to.eq(expectedMethodologistTake);
    });

    it("should emit a FeesDistributed event", async () => {
      await expect(subject()).to.emit(issuanceExtension, "FeesDistributed");
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
