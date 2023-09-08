import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, PRECISE_UNIT } from "@utils/constants";
import {
  DelegatedManager,
  GlobalClaimExtension,
  ManagerCore,
} from "@utils/contracts/index";
import {
  SetToken,
  AirdropModule,
  ClaimModule,
  ClaimAdapterMock
} from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getRandomAddress,
  preciseMul,
  preciseDiv,
  getSetFixture,
  getRandomAccount,
} from "@utils/index";
import { ContractTransaction } from "ethers";
import { AirdropSettings } from "@utils/types";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("GlobalClaimExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let ownerFeeRecipient: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SetFixture;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let claimExtension: GlobalClaimExtension;
  let ownerFeeSplit: BigNumber;

  let airdropModule: AirdropModule;
  let claimModule: ClaimModule;
  let claimAdapterMockOne: ClaimAdapterMock;
  let claimAdapterMockTwo: ClaimAdapterMock;
  const claimAdapterMockIntegrationNameOne: string = "MOCK_CLAIM_ONE";
  const claimAdapterMockIntegrationNameTwo: string = "MOCK_CLAIM_TWO";

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      ownerFeeRecipient,
      factory,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    airdropModule = await deployer.setV2.deployAirdropModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(airdropModule.address);

    claimModule = await deployer.setV2.deployClaimModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(claimModule.address);
    claimAdapterMockOne = await deployer.setV2.deployClaimAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      claimModule.address,
      claimAdapterMockIntegrationNameOne,
      claimAdapterMockOne.address
    );
    claimAdapterMockTwo = await deployer.setV2.deployClaimAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      claimModule.address,
      claimAdapterMockIntegrationNameTwo,
      claimAdapterMockTwo.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();

    claimExtension = await deployer.globalExtensions.deployGlobalClaimExtension(
      managerCore.address,
      airdropModule.address,
      claimModule.address,
      setV2Setup.integrationRegistry.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, airdropModule.address, claimModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [claimExtension.address],
      [operator.address],
      [setV2Setup.usdc.address, setV2Setup.weth.address],
      true
    );

    ownerFeeSplit = ether(0.6);
    await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ownerFeeSplit);
    await delegatedManager.connect(methodologist.wallet).updateOwnerFeeSplit(ownerFeeSplit);
    await delegatedManager.connect(owner.wallet).updateOwnerFeeRecipient(ownerFeeRecipient.address);

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([claimExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectAirdropModule: Address;
    let subjectClaimModule: Address;
    let subjectIntegrationRegistry: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectAirdropModule = airdropModule.address;
      subjectClaimModule = claimModule.address;
      subjectIntegrationRegistry = setV2Setup.integrationRegistry.address;
    });

    async function subject(): Promise<GlobalClaimExtension> {
      return await deployer.globalExtensions.deployGlobalClaimExtension(
        subjectManagerCore,
        subjectAirdropModule,
        subjectClaimModule,
        subjectIntegrationRegistry
      );
    }

    it("should set the correct AirdropModule address", async () => {
      const claimExtension = await subject();

      const storedModule = await claimExtension.airdropModule();
      expect(storedModule).to.eq(subjectAirdropModule);
    });

    it("should set the correct ClaimModule address", async () => {
      const claimExtension = await subject();

      const storedModule = await claimExtension.claimModule();
      expect(storedModule).to.eq(subjectClaimModule);
    });

    it("should set the correct IntegrationRegistry address", async () => {
      const claimExtension = await subject();

      const storedIntegrationRegistry = await claimExtension.integrationRegistry();
      expect(storedIntegrationRegistry).to.eq(subjectIntegrationRegistry);
    });
  });

  describe("#initializeAirdropModule", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;
    let airdropFeeRecipient: Address;

    let subjectDelegatedManager: Address;
    let subjectAirdropSettings: AirdropSettings;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setV2Setup.usdc.address, setV2Setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;
      airdropFeeRecipient = delegatedManager.address;
    });

    beforeEach(async () => {
      await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectAirdropSettings = {
        airdrops,
        feeRecipient: airdropFeeRecipient,
        airdropFee,
        anyoneAbsorb,
      } as AirdropSettings;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return claimExtension.connect(subjectCaller.wallet).initializeAirdropModule(
        subjectDelegatedManager,
        subjectAirdropSettings
      );
    }

    it("should initialize the AirdropModule on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(airdropModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should set the correct airdrops and anyoneAbsorb fields", async () => {
      await subject();

      const airdropSettings: any = await airdropModule.airdropSettings(setToken.address);
      const airdrops = await airdropModule.getAirdrops(setToken.address);

      expect(JSON.stringify(airdrops)).to.eq(JSON.stringify(airdrops));
      expect(airdropSettings.airdropFee).to.eq(airdropFee);
      expect(airdropSettings.anyoneAbsorb).to.eq(anyoneAbsorb);
    });

    it("should set the correct isAirdrop state", async () => {
      await subject();

      const wethIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.weth.address);
      const usdcIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.usdc.address);

      expect(wethIsAirdrop).to.be.true;
      expect(usdcIsAirdrop).to.be.true;
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(airdropModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
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

  describe("#initializeClaimModule", async () => {
    let subjectDelegatedManager: Address;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectAnyoneClaim: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
      subjectAnyoneClaim = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return claimExtension.connect(subjectCaller.wallet).initializeClaimModule(
        subjectDelegatedManager,
        subjectAnyoneClaim,
        subjectRewardPools,
        subjectIntegrations
      );
    }

    it("should initialize the ClaimModule on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(claimModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should set the anyoneClaim field", async () => {
      const anyoneClaimBefore = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaimBefore).to.eq(false);

      await subject();

      const anyoneClaim = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaim).to.eq(true);
    });

    it("should add the rewardPools to the rewardPoolList", async () => {
      expect((await claimModule.getRewardPools(setToken.address)).length).to.eq(0);

      await subject();

      const rewardPools = await claimModule.getRewardPools(setToken.address);
      expect(rewardPools[0]).to.eq(subjectRewardPools[0]);
      expect(rewardPools[1]).to.eq(subjectRewardPools[1]);
    });

    it("should add all new integrations for the rewardPools", async () => {
      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMockOne.address);
      expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMockTwo.address);
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await subject();
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(claimModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
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
      return claimExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the ClaimExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await claimExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the ClaimExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(claimExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ClaimExtensionInitialized event", async () => {
      await expect(subject()).to.emit(claimExtension, "ClaimExtensionInitialized").withArgs(
        setToken.address,
        delegatedManager.address
      );
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
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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

  describe("#initializeModulesAndExtension", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;
    let airdropFeeRecipient: Address;

    let subjectDelegatedManager: Address;
    let subjectAirdropSettings: AirdropSettings;
    let subjectRewardPools: Address[];
    let subjectIntegrations: string[];
    let subjectAnyoneClaim: boolean;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setV2Setup.usdc.address, setV2Setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;
      airdropFeeRecipient = delegatedManager.address;
    });

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectAirdropSettings = {
        airdrops,
        feeRecipient: airdropFeeRecipient,
        airdropFee,
        anyoneAbsorb,
      } as AirdropSettings;
      subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
      subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
      subjectAnyoneClaim = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return claimExtension.connect(subjectCaller.wallet).initializeModulesAndExtension(
        subjectDelegatedManager,
        subjectAirdropSettings,
        subjectAnyoneClaim,
        subjectRewardPools,
        subjectIntegrations
      );
    }

    it("should initialize the AirdropModule and ClaimModule on the SetToken", async () => {
      await subject();

      const isAirdropModuleInitialized: Boolean = await setToken.isInitializedModule(airdropModule.address);
      const isClaimModuleInitialized: Boolean = await setToken.isInitializedModule(claimModule.address);
      expect(isAirdropModuleInitialized).to.eq(true);
      expect(isClaimModuleInitialized).to.eq(true);
    });

    it("should set the correct airdrops and anyoneAbsorb fields", async () => {
      await subject();

      const airdropSettings: any = await airdropModule.airdropSettings(setToken.address);
      const airdrops = await airdropModule.getAirdrops(setToken.address);

      expect(JSON.stringify(airdrops)).to.eq(JSON.stringify(airdrops));
      expect(airdropSettings.airdropFee).to.eq(airdropFee);
      expect(airdropSettings.anyoneAbsorb).to.eq(anyoneAbsorb);
    });

    it("should set the correct isAirdrop state", async () => {
      await subject();

      const wethIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.weth.address);
      const usdcIsAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.usdc.address);

      expect(wethIsAirdrop).to.be.true;
      expect(usdcIsAirdrop).to.be.true;
    });

    it("should set the anyoneClaim field", async () => {
      const anyoneClaimBefore = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaimBefore).to.eq(false);

      await subject();

      const anyoneClaim = await claimModule.anyoneClaim(setToken.address);
      expect(anyoneClaim).to.eq(true);
    });

    it("should add the rewardPools to the rewardPoolList", async () => {
      expect((await claimModule.getRewardPools(setToken.address)).length).to.eq(0);

      await subject();

      const rewardPools = await claimModule.getRewardPools(setToken.address);
      expect(rewardPools[0]).to.eq(subjectRewardPools[0]);
      expect(rewardPools[1]).to.eq(subjectRewardPools[1]);
    });

    it("should add all new integrations for the rewardPools", async () => {
      await subject();

      const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
      const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
      expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMockOne.address);
      expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMockTwo.address);
    });

    it("should store the correct SetToken and DelegatedManager on the ClaimExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await claimExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the ClaimExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(claimExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct ClaimExtensionInitialized event", async () => {
      await expect(subject()).to.emit(claimExtension, "ClaimExtensionInitialized").withArgs(
        setToken.address,
        delegatedManager.address
      );
    });

    describe("when the sender is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be owner");
      });
    });

    describe("when the AirdropModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeAirdropModule(
          delegatedManager.address,
          {
            airdrops,
            feeRecipient: airdropFeeRecipient,
            airdropFee,
            anyoneAbsorb,
          } as AirdropSettings
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(airdropModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the AirdropModule is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeAirdropModule(
          delegatedManager.address,
          {
            airdrops,
            feeRecipient: airdropFeeRecipient,
            airdropFee,
            anyoneAbsorb,
          } as AirdropSettings
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the ClaimModule is not pending or initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeClaimModule(
          delegatedManager.address,
          true,
          [await getRandomAddress(), await getRandomAddress()],
          [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo]
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(claimModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the ClaimModule is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await claimExtension.connect(owner.wallet).initializeClaimModule(
          delegatedManager.address,
          true,
          [await getRandomAddress(), await getRandomAddress()],
          [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo]
        );
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([claimExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
    let subjectClaimExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await claimExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectClaimExtension = [claimExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectClaimExtension);
    }

    it("should clear SetToken and DelegatedManager from ClaimExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await claimExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(claimExtension, "ExtensionRemoved").withArgs(
        setToken.address,
        delegatedManager.address
      );
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

  context("when the ClaimExtension, AirdropModule, and ClaimModule are initialized", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;
    let airdropFeeRecipient: Address;

    let rewardPools: Address[];
    let integrations: string[];
    let anyoneClaim: boolean;

    let protocolFee: BigNumber;

    before(async () => {
      airdrops = [setV2Setup.usdc.address, setV2Setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = false;
      airdropFeeRecipient = delegatedManager.address;

      rewardPools = [await getRandomAddress(), await getRandomAddress()];
      integrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
      anyoneClaim = false;

      await claimExtension.connect(owner.wallet).initializeModulesAndExtension(
        delegatedManager.address,
        {
          airdrops,
          feeRecipient: airdropFeeRecipient,
          airdropFee,
          anyoneAbsorb,
        },
        anyoneClaim,
        rewardPools,
        integrations,
      );

      protocolFee = ether(.15);
      await setV2Setup.controller.addFee(airdropModule.address, ZERO, protocolFee);

      await setV2Setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    });

    describe("#distributeFees", async () => {
      let numTokens: BigNumber;
      let subjectToken: Address;
      let subjectSetToken: Address;

      beforeEach(async () => {
        numTokens = ether(1);
        await setV2Setup.dai.transfer(delegatedManager.address, numTokens);

        subjectToken = setV2Setup.dai.address;
        subjectSetToken = setToken.address;
      });

      async function subject(): Promise<ContractTransaction> {
        return await claimExtension.distributeFees(subjectSetToken, subjectToken);
      }

      it("should send correct amount of fees to owner fee recipient and methodologist", async () => {
        const ownerFeeRecipientBalanceBefore = await setV2Setup.dai.balanceOf(ownerFeeRecipient.address);
        const methodologistBalanceBefore = await setV2Setup.dai.balanceOf(methodologist.address);

        await subject();

        const expectedOwnerTake = preciseMul(numTokens, ownerFeeSplit);
        const expectedMethodologistTake = numTokens.sub(expectedOwnerTake);

        const ownerFeeRecipientBalanceAfter = await setV2Setup.dai.balanceOf(ownerFeeRecipient.address);
        const methodologistBalanceAfter = await setV2Setup.dai.balanceOf(methodologist.address);

        const ownerFeeRecipientBalanceIncrease = ownerFeeRecipientBalanceAfter.sub(ownerFeeRecipientBalanceBefore);
        const methodologistBalanceIncrease = methodologistBalanceAfter.sub(methodologistBalanceBefore);

        expect(ownerFeeRecipientBalanceIncrease).to.eq(expectedOwnerTake);
        expect(methodologistBalanceIncrease).to.eq(expectedMethodologistTake);
      });

      it("should emit the correct FeesDistributed event", async () => {
        const expectedOwnerTake = preciseMul(numTokens, ownerFeeSplit);
        const expectedMethodologistTake = numTokens.sub(expectedOwnerTake);

        await expect(subject()).to.emit(claimExtension, "FeesDistributed").withArgs(
          setToken.address,
          setV2Setup.dai.address,
          ownerFeeRecipient.address,
          methodologist.address,
          expectedOwnerTake,
          expectedMethodologistTake
        );
      });

      describe("when methodologist fees are 0", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ether(1));
          await delegatedManager.connect(methodologist.wallet).updateOwnerFeeSplit(ether(1));
        });

        it("should not send fees to methodologist", async () => {
          const preMethodologistBalance = await setV2Setup.dai.balanceOf(methodologist.address);

          await subject();

          const postMethodologistBalance = await setV2Setup.dai.balanceOf(methodologist.address);
          expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
        });
      });

      describe("when owner fees are 0", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).updateOwnerFeeSplit(ZERO);
          await delegatedManager.connect(methodologist.wallet).updateOwnerFeeSplit(ZERO);
        });

        it("should not send fees to owner fee recipient", async () => {
          const preOwnerFeeRecipientBalance = await setV2Setup.dai.balanceOf(owner.address);

          await subject();

          const postOwnerFeeRecipientBalance = await setV2Setup.dai.balanceOf(owner.address);
          expect(postOwnerFeeRecipientBalance.sub(preOwnerFeeRecipientBalance)).to.eq(ZERO);
        });
      });
    });

    describe("#batchAbsorb", async () => {
      let airdropOne: BigNumber;
      let airdropTwo: BigNumber;

      let subjectSetToken: Address;
      let subjectTokens: Address[];
      let subjectCaller: Account;

      beforeEach(async () => {
        airdropOne = ether(100);
        airdropTwo = ether(1);

        await setV2Setup.usdc.transfer(setToken.address, airdropOne);
        await setV2Setup.weth.transfer(setToken.address, airdropTwo);

        subjectSetToken = setToken.address;
        subjectTokens = [setV2Setup.usdc.address, setV2Setup.weth.address];
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).batchAbsorb(
          subjectSetToken,
          subjectTokens
        );
      }

      it("should create the correct new usdc position", async () => {
        const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(airdropOne);

        await subject();

        const totalSupply = await setToken.totalSupply();
        const actualBalanceAfter = await setV2Setup.usdc.balanceOf(setToken.address);

        const expectedBalanceAfter = airdropOne.sub(preciseMul(airdropOne, airdropFee));
        expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

        const positions = await setToken.getPositions();
        const expectedUnitAfter = preciseDiv(expectedBalanceAfter, totalSupply);
        expect(positions[1].component).to.eq(setV2Setup.usdc.address);
        expect(positions[1].unit).to.eq(expectedUnitAfter);
      });

      it("should transfer the correct usdc amount to the setToken feeRecipient", async () => {
        const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(airdropOne);

        await subject();

        const actualManagerTake = await setV2Setup.usdc.balanceOf(delegatedManager.address);
        const expectedManagerTake = preciseMul(preciseMul(airdropOne, airdropFee), PRECISE_UNIT.sub(protocolFee));
        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer the correct usdc amount to the protocol feeRecipient", async () => {
        const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(airdropOne);

        await subject();

        const actualProtocolTake = await setV2Setup.usdc.balanceOf(setV2Setup.feeRecipient);
        const expectedProtocolTake = preciseMul(preciseMul(airdropOne, airdropFee), protocolFee);
        expect(actualProtocolTake).to.eq(expectedProtocolTake);
      });

      it("should emit the correct ComponentAbsorbed event for USDC", async () => {
        const expectedManagerTake = preciseMul(preciseMul(airdropOne, airdropFee), PRECISE_UNIT.sub(protocolFee));
        const expectedProtocolTake = preciseMul(preciseMul(airdropOne, airdropFee), protocolFee);
        await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
          setToken.address,
          setV2Setup.usdc.address,
          airdropOne,
          expectedManagerTake,
          expectedProtocolTake
        );
      });

      it("should add the correct amount to the existing weth position", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const knownBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balanceBefore = await setV2Setup.weth.balanceOf(setToken.address);
        expect(airdropTwo).to.eq(balanceBefore.sub(knownBalance));

        await subject();

        const expectedAirdropAmount = airdropTwo.sub(preciseMul(airdropTwo, airdropFee));
        const expectedBalanceAfter = knownBalance.add(expectedAirdropAmount);

        const actualBalanceAfter = await setV2Setup.weth.balanceOf(setToken.address);
        expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

        const postPositions = await setToken.getPositions();
        expect(postPositions[0].unit).to.eq(preciseDiv(expectedBalanceAfter, totalSupply));
      });

      it("should transfer the correct weth amount to the setToken feeRecipient", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setV2Setup.weth.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

        const actualManagerTake = await setV2Setup.weth.balanceOf(delegatedManager.address);
        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer the correct weth amount to the protocol feeRecipient", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setV2Setup.weth.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);

        const actualProtocolTake = await setV2Setup.weth.balanceOf(setV2Setup.feeRecipient);
        expect(actualProtocolTake).to.eq(expectedProtocolTake);
      });

      it("should emit the correct ComponentAbsorbed event for WETH", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setV2Setup.weth.balanceOf(setToken.address);

        const airdroppedTokens = balance.sub(preDropBalance);
        const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));
        const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);
        await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
          setToken.address,
          setV2Setup.weth.address,
          airdroppedTokens,
          expectedManagerTake,
          expectedProtocolTake
        );
      });

      describe("when anyoneAbsorb is false and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid AirdropModule absorb caller");
        });
      });

      describe("when anyoneAbsorb is true and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          await claimExtension.connect(owner.wallet).updateAnyoneAbsorb(setToken.address, true);

          subjectCaller = await getRandomAccount();
        });

        it("should create the correct new usdc position", async () => {
          const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
          expect(balanceBefore).to.eq(airdropOne);

          await subject();

          const totalSupply = await setToken.totalSupply();
          const actualBalanceAfter = await setV2Setup.usdc.balanceOf(setToken.address);

          const expectedBalanceAfter = airdropOne.sub(preciseMul(airdropOne, airdropFee));
          expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

          const positions = await setToken.getPositions();
          const expectedUnitAfter = preciseDiv(expectedBalanceAfter, totalSupply);
          expect(positions[1].component).to.eq(setV2Setup.usdc.address);
          expect(positions[1].unit).to.eq(expectedUnitAfter);
        });

        it("should add the correct amount to the existing weth position", async () => {
          const totalSupply = await setToken.totalSupply();
          const prePositions = await setToken.getPositions();
          const knownBalance = preciseMul(prePositions[0].unit, totalSupply);
          const balanceBefore = await setV2Setup.weth.balanceOf(setToken.address);
          expect(airdropTwo).to.eq(balanceBefore.sub(knownBalance));

          await subject();

          const expectedAirdropAmount = airdropTwo.sub(preciseMul(airdropTwo, airdropFee));
          const expectedBalanceAfter = knownBalance.add(expectedAirdropAmount);

          const actualBalanceAfter = await setV2Setup.weth.balanceOf(setToken.address);
          expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

          const postPositions = await setToken.getPositions();
          expect(postPositions[0].unit).to.eq(preciseDiv(expectedBalanceAfter, totalSupply));
        });
      });

      describe("when a passed token is not an allowed asset", async () => {
        beforeEach(async () => {
          subjectTokens = [setV2Setup.usdc.address, setV2Setup.wbtc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });

      describe("when useAssetAllowlist is false and a passed token is not on allowed asset list", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([setV2Setup.usdc.address]);
          await delegatedManager.connect(owner.wallet).updateUseAssetAllowlist(false);

          await setV2Setup.wbtc.transfer(setToken.address, ether(1));

          await claimExtension.connect(owner.wallet).addAirdrop(setToken.address, setV2Setup.wbtc.address);

          subjectTokens = [setV2Setup.usdc.address, setV2Setup.wbtc.address];
        });

        it("should create the correct new usdc position", async () => {
          const totalSupply = await setToken.totalSupply();
          const preDropBalance = ZERO;
          const balance = await setV2Setup.usdc.balanceOf(setToken.address);

          await subject();

          const airdroppedTokens = balance.sub(preDropBalance);
          const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

          const positions = await setToken.getPositions();
          expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
        });
      });
    });

    describe("#absorb", async () => {
      let airdropOne: BigNumber;

      let subjectSetToken: Address;
      let subjectToken: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        airdropOne = ether(100);
        await setV2Setup.usdc.transfer(setToken.address, airdropOne);

        subjectSetToken = setToken.address;
        subjectToken = setV2Setup.usdc.address;
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).absorb(
          subjectSetToken,
          subjectToken
        );
      }

      it("should create the correct new usdc position", async () => {
        const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(airdropOne);

        await subject();

        const totalSupply = await setToken.totalSupply();
        const actualBalanceAfter = await setV2Setup.usdc.balanceOf(setToken.address);

        const expectedBalanceAfter = airdropOne.sub(preciseMul(airdropOne, airdropFee));
        expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

        const positions = await setToken.getPositions();
        const expectedUnitAfter = preciseDiv(expectedBalanceAfter, totalSupply);
        expect(positions[1].component).to.eq(setV2Setup.usdc.address);
        expect(positions[1].unit).to.eq(expectedUnitAfter);
      });

      it("should transfer the correct usdc amount to the setToken feeRecipient", async () => {
        const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(airdropOne);

        await subject();

        const actualManagerTake = await setV2Setup.usdc.balanceOf(delegatedManager.address);
        const expectedManagerTake = preciseMul(preciseMul(airdropOne, airdropFee), PRECISE_UNIT.sub(protocolFee));
        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer the correct usdc amount to the protocol feeRecipient", async () => {
        const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(airdropOne);

        await subject();

        const actualProtocolTake = await setV2Setup.usdc.balanceOf(setV2Setup.feeRecipient);
        const expectedProtocolTake = preciseMul(preciseMul(airdropOne, airdropFee), protocolFee);
        expect(actualProtocolTake).to.eq(expectedProtocolTake);
      });

      it("should emit the correct ComponentAbsorbed event for USDC", async () => {
        const expectedManagerTake = preciseMul(preciseMul(airdropOne, airdropFee), PRECISE_UNIT.sub(protocolFee));
        const expectedProtocolTake = preciseMul(preciseMul(airdropOne, airdropFee), protocolFee);
        await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
          setToken.address,
          setV2Setup.usdc.address,
          airdropOne,
          expectedManagerTake,
          expectedProtocolTake
        );
      });

      describe("when anyoneAbsorb is false and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid AirdropModule absorb caller");
        });
      });

      describe("when anyoneAbsorb is true and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          await claimExtension.connect(owner.wallet).updateAnyoneAbsorb(setToken.address, true);

          subjectCaller = await getRandomAccount();
        });

        it("should create the correct new usdc position", async () => {
          const balanceBefore = await setV2Setup.usdc.balanceOf(setToken.address);
          expect(balanceBefore).to.eq(airdropOne);

          await subject();

          const totalSupply = await setToken.totalSupply();
          const actualBalanceAfter = await setV2Setup.usdc.balanceOf(setToken.address);

          const expectedBalanceAfter = airdropOne.sub(preciseMul(airdropOne, airdropFee));
          expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

          const positions = await setToken.getPositions();
          const expectedUnitAfter = preciseDiv(expectedBalanceAfter, totalSupply);
          expect(positions[1].component).to.eq(setV2Setup.usdc.address);
          expect(positions[1].unit).to.eq(expectedUnitAfter);
        });
      });

      describe("when passed token is not an allowed asset", async () => {
        beforeEach(async () => {
          subjectToken = setV2Setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });

    describe("#addAirdrop", async () => {
      let subjectSetToken: Address;
      let subjectAirdrop: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAirdrop = setV2Setup.wbtc.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).addAirdrop(
          subjectSetToken,
          subjectAirdrop
        );
      }

      it("should add the new token", async () => {
        await subject();

        const airdrops = await airdropModule.getAirdrops(setToken.address);
        const isAirdrop = await airdropModule.isAirdrop(setToken.address, setV2Setup.wbtc.address);
        expect(airdrops[2]).to.eq(setV2Setup.wbtc.address);
        expect(isAirdrop).to.be.true;
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

    describe("#removeAirdrop", async () => {
      let subjectSetToken: Address;
      let subjectAirdrop: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAirdrop = setV2Setup.usdc.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).removeAirdrop(
          subjectSetToken,
          subjectAirdrop
        );
      }

      it("should remove the token", async () => {
        await subject();

        const airdrops = await airdropModule.getAirdrops(setToken.address);
        const isAirdrop = await airdropModule.isAirdrop(subjectSetToken, subjectAirdrop);
        expect(airdrops).to.not.contain(subjectAirdrop);
        expect(isAirdrop).to.be.false;
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

    describe("#updateAnyoneAbsorb", async () => {
      let subjectSetToken: Address;
      let subjectAnyoneAbsorb: boolean;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAnyoneAbsorb = true;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).updateAnyoneAbsorb(
          subjectSetToken,
          subjectAnyoneAbsorb
        );
      }

      it("should flip the anyoneAbsorb indicator", async () => {
        await subject();

        const airdropSettings = await airdropModule.airdropSettings(setToken.address);
        expect(airdropSettings.anyoneAbsorb).to.be.true;
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

    describe("#updateAirdropFeeRecipient", async () => {
      let subjectSetToken: Address;
      let subjectNewFeeRecipient: Address;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectNewFeeRecipient = await getRandomAddress();
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).updateAirdropFeeRecipient(
          subjectSetToken,
          subjectNewFeeRecipient
        );
      }

      it("should change the fee recipient to the new address", async () => {
        await subject();

        const airdropSettings = await airdropModule.airdropSettings(setToken.address);
        expect(airdropSettings.feeRecipient).to.eq(subjectNewFeeRecipient);
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

    describe("#updateAirdropFee", async () => {
      let subjectSetToken: Address;
      let subjectNewFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        await setV2Setup.usdc.transfer(setToken.address, ether(1));

        subjectSetToken = setToken.address;
        subjectNewFee = ether(.5);
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).updateAirdropFee(
          subjectSetToken,
          subjectNewFee
        );
      }

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setV2Setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should set the new fee", async () => {
        await subject();

        const airdropSettings = await airdropModule.airdropSettings(setToken.address);
        expect(airdropSettings.airdropFee).to.eq(subjectNewFee);
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

    describe("#claimAndAbsorb", async () => {
      let rewards: BigNumber;

      let subjectSetToken: Address;
      let subjectRewardPool: Address;
      let subjectIntegration: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        rewards = ether(1);
        await claimAdapterMockOne.setRewards(rewards);

        await claimExtension.connect(owner.wallet).addAirdrop(
          setToken.address,
          claimAdapterMockOne.address
        );

        await delegatedManager.connect(owner.wallet).addAllowedAssets([claimAdapterMockOne.address]);

        subjectSetToken = setToken.address;
        subjectRewardPool = rewardPools[0];
        subjectIntegration = claimAdapterMockIntegrationNameOne;
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).claimAndAbsorb(
          subjectSetToken,
          subjectRewardPool,
          subjectIntegration
        );
      }

      it("emits the correct RewardClaimed event", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPool,
          claimAdapterMockOne.address,
          rewards
        );
      });

      it("should claim the rewards and create the correct new reward token position", async () => {
        const balanceBefore = await claimAdapterMockOne.balanceOf(setToken.address);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const totalSupply = await setToken.totalSupply();
        const actualBalanceAfter = await claimAdapterMockOne.balanceOf(setToken.address);

        const expectedBalanceAfter = rewards.sub(preciseMul(rewards, airdropFee));
        expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

        const positions = await setToken.getPositions();
        const expectedUnitAfter = preciseDiv(expectedBalanceAfter, totalSupply);
        expect(positions[1].component).to.eq(claimAdapterMockOne.address);
        expect(positions[1].unit).to.eq(expectedUnitAfter);
      });

      it("should transfer the correct rewards amount to the setToken feeRecipient", async () => {
        const balanceBefore = await claimAdapterMockOne.balanceOf(delegatedManager.address);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const actualManagerTake = await claimAdapterMockOne.balanceOf(delegatedManager.address);
        const expectedManagerTake = preciseMul(preciseMul(rewards, airdropFee), PRECISE_UNIT.sub(protocolFee));

        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer the correct rewards amount to the protocol feeRecipient", async () => {
        const balanceBefore = await claimAdapterMockOne.balanceOf(setV2Setup.feeRecipient);
        expect(balanceBefore).to.eq(ZERO);

        await subject();

        const actualProtocolTake = await claimAdapterMockOne.balanceOf(setV2Setup.feeRecipient);
        const expectedProtocolTake = preciseMul(preciseMul(rewards, airdropFee), protocolFee);
        expect(actualProtocolTake).to.eq(expectedProtocolTake);
      });

      it("should emit the correct ComponentAbsorbed event for rewards", async () => {
        const expectedManagerTake = preciseMul(preciseMul(rewards, airdropFee), PRECISE_UNIT.sub(protocolFee));
        const expectedProtocolTake = preciseMul(preciseMul(rewards, airdropFee), protocolFee);
        await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
          setToken.address,
          claimAdapterMockOne.address,
          rewards,
          expectedManagerTake,
          expectedProtocolTake
        );
      });

      describe("when anyoneClaim and anyoneAbsorb are false and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid AirdropModule absorb and ClaimModule claim caller");
        });
      });

      describe("when anyoneClaim and anyoneAbsorb is true and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          await claimExtension.connect(owner.wallet).updateAnyoneClaim(setToken.address, true);
          await claimExtension.connect(owner.wallet).updateAnyoneAbsorb(setToken.address, true);

          subjectCaller = await getRandomAccount();
        });

        it("should claim the rewards and create the correct new reward token position", async () => {
          const balanceBefore = await claimAdapterMockOne.balanceOf(setToken.address);
          expect(balanceBefore).to.eq(ZERO);

          await subject();

          const totalSupply = await setToken.totalSupply();
          const actualBalanceAfter = await claimAdapterMockOne.balanceOf(setToken.address);

          const expectedBalanceAfter = rewards.sub(preciseMul(rewards, airdropFee));
          expect(actualBalanceAfter).to.eq(expectedBalanceAfter);

          const positions = await setToken.getPositions();
          const expectedUnitAfter = preciseDiv(expectedBalanceAfter, totalSupply);
          expect(positions[1].component).to.eq(claimAdapterMockOne.address);
          expect(positions[1].unit).to.eq(expectedUnitAfter);
        });
      });

      describe("when the rewards token is not an allowed asset", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([claimAdapterMockOne.address]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });

    describe("#batchClaimAndAbsorb", async () => {
      let rewardsOne: BigNumber;
      let rewardsTwo: BigNumber;

      let subjectSetToken: Address;
      let subjectRewardPools: Address[];
      let subjectIntegrations: string[];
      let subjectCaller: Account;

      beforeEach(async () => {
        rewardsOne = ether(1);
        rewardsTwo = ether(2);
        await claimAdapterMockOne.setRewards(rewardsOne);
        await claimAdapterMockTwo.setRewards(rewardsTwo);

        await claimExtension.connect(owner.wallet).addAirdrop(
          setToken.address,
          claimAdapterMockOne.address
        );

        await claimExtension.connect(owner.wallet).addAirdrop(
          setToken.address,
          claimAdapterMockTwo.address
        );

        await delegatedManager.connect(owner.wallet).addAllowedAssets(
          [claimAdapterMockOne.address, claimAdapterMockTwo.address]
        );

        subjectSetToken = setToken.address;
        subjectRewardPools = rewardPools;
        subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).batchClaimAndAbsorb(
          subjectSetToken,
          subjectRewardPools,
          subjectIntegrations
        );
      }

      it("emits the correct first RewardClaimed events", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPools[0],
          claimAdapterMockOne.address,
          rewardsOne
        );
      });

      it("emits the correct second RewardClaimed events", async () => {
        await expect(subject()).to.emit(claimModule, "RewardClaimed").withArgs(
          subjectSetToken,
          subjectRewardPools[1],
          claimAdapterMockTwo.address,
          rewardsTwo
        );
      });

      it("should claim the rewards and create the correct new reward token positions", async () => {
        const balanceOneBefore = await claimAdapterMockOne.balanceOf(setToken.address);
        const balanceTwoBefore = await claimAdapterMockTwo.balanceOf(setToken.address);
        expect(balanceOneBefore).to.eq(ZERO);
        expect(balanceTwoBefore).to.eq(ZERO);

        await subject();

        const totalSupply = await setToken.totalSupply();
        const actualBalanceOneAfter = await claimAdapterMockOne.balanceOf(setToken.address);
        const actualBalanceTwoAfter = await claimAdapterMockTwo.balanceOf(setToken.address);

        const expectedBalanceOneAfter = rewardsOne.sub(preciseMul(rewardsOne, airdropFee));
        const expectedBalanceTwoAfter = rewardsTwo.sub(preciseMul(rewardsTwo, airdropFee));
        expect(actualBalanceOneAfter).to.eq(expectedBalanceOneAfter);
        expect(actualBalanceTwoAfter).to.eq(expectedBalanceTwoAfter);

        const positions = await setToken.getPositions();
        const expectedUnitOneAfter = preciseDiv(expectedBalanceOneAfter, totalSupply);
        const expectedUnitTwoAfter = preciseDiv(expectedBalanceTwoAfter, totalSupply);
        expect(positions[1].component).to.eq(claimAdapterMockOne.address);
        expect(positions[2].component).to.eq(claimAdapterMockTwo.address);
        expect(positions[1].unit).to.eq(expectedUnitOneAfter);
        expect(positions[2].unit).to.eq(expectedUnitTwoAfter);
      });

      it("should transfer the correct rewards amounts to the setToken feeRecipient", async () => {
        const balanceOneBefore = await claimAdapterMockOne.balanceOf(delegatedManager.address);
        const balanceTwoBefore = await claimAdapterMockTwo.balanceOf(delegatedManager.address);
        expect(balanceOneBefore).to.eq(ZERO);
        expect(balanceTwoBefore).to.eq(ZERO);

        await subject();

        const actualManagerTakeOne = await claimAdapterMockOne.balanceOf(delegatedManager.address);
        const expectedManagerTakeOne = preciseMul(preciseMul(rewardsOne, airdropFee), PRECISE_UNIT.sub(protocolFee));

        const actualManagerTakeTwo = await claimAdapterMockTwo.balanceOf(delegatedManager.address);
        const expectedManagerTakeTwo = preciseMul(preciseMul(rewardsTwo, airdropFee), PRECISE_UNIT.sub(protocolFee));

        expect(actualManagerTakeOne).to.eq(expectedManagerTakeOne);
        expect(actualManagerTakeTwo).to.eq(expectedManagerTakeTwo);
      });

      it("should transfer the correct rewards amounts to the protocol feeRecipient", async () => {
        const balanceOneBefore = await claimAdapterMockOne.balanceOf(setV2Setup.feeRecipient);
        const balanceTwoBefore = await claimAdapterMockTwo.balanceOf(setV2Setup.feeRecipient);
        expect(balanceOneBefore).to.eq(ZERO);
        expect(balanceTwoBefore).to.eq(ZERO);

        await subject();

        const actualProtocolTakeOne = await claimAdapterMockOne.balanceOf(setV2Setup.feeRecipient);
        const expectedProtocolTakeOne = preciseMul(preciseMul(rewardsOne, airdropFee), protocolFee);

        const actualProtocolTakeTwo = await claimAdapterMockTwo.balanceOf(setV2Setup.feeRecipient);
        const expectedProtocolTakeTwo = preciseMul(preciseMul(rewardsTwo, airdropFee), protocolFee);

        expect(actualProtocolTakeOne).to.eq(expectedProtocolTakeOne);
        expect(actualProtocolTakeTwo).to.eq(expectedProtocolTakeTwo);
      });

      it("should emit the correct ComponentAbsorbed event for the first rewards", async () => {
        const expectedManagerTakeOne = preciseMul(preciseMul(rewardsOne, airdropFee), PRECISE_UNIT.sub(protocolFee));
        const expectedProtocolTakeOne = preciseMul(preciseMul(rewardsOne, airdropFee), protocolFee);
        await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
          setToken.address,
          claimAdapterMockOne.address,
          rewardsOne,
          expectedManagerTakeOne,
          expectedProtocolTakeOne
        );
      });

      it("should emit the correct ComponentAbsorbed event for the second rewards", async () => {
        const expectedManagerTakeTwo = preciseMul(preciseMul(rewardsTwo, airdropFee), PRECISE_UNIT.sub(protocolFee));
        const expectedProtocolTakeTwo = preciseMul(preciseMul(rewardsTwo, airdropFee), protocolFee);
        await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
          setToken.address,
          claimAdapterMockTwo.address,
          rewardsTwo,
          expectedManagerTakeTwo,
          expectedProtocolTakeTwo
        );
      });

      describe("when anyoneClaim and anyoneAbsorb are false and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid AirdropModule absorb and ClaimModule claim caller");
        });
      });

      describe("when anyoneClaim and anyoneAbsorb is true and the caller is not the DelegatedManager operator", async () => {
        beforeEach(async () => {
          await claimExtension.connect(owner.wallet).updateAnyoneClaim(setToken.address, true);
          await claimExtension.connect(owner.wallet).updateAnyoneAbsorb(setToken.address, true);

          subjectCaller = await getRandomAccount();
        });

        it("should claim the rewards and create the correct new reward token positions", async () => {
          const balanceOneBefore = await claimAdapterMockOne.balanceOf(setToken.address);
          const balanceTwoBefore = await claimAdapterMockTwo.balanceOf(setToken.address);
          expect(balanceOneBefore).to.eq(ZERO);
          expect(balanceTwoBefore).to.eq(ZERO);

          await subject();

          const totalSupply = await setToken.totalSupply();
          const actualBalanceOneAfter = await claimAdapterMockOne.balanceOf(setToken.address);
          const actualBalanceTwoAfter = await claimAdapterMockTwo.balanceOf(setToken.address);

          const expectedBalanceOneAfter = rewardsOne.sub(preciseMul(rewardsOne, airdropFee));
          const expectedBalanceTwoAfter = rewardsTwo.sub(preciseMul(rewardsTwo, airdropFee));
          expect(actualBalanceOneAfter).to.eq(expectedBalanceOneAfter);
          expect(actualBalanceTwoAfter).to.eq(expectedBalanceTwoAfter);

          const positions = await setToken.getPositions();
          const expectedUnitOneAfter = preciseDiv(expectedBalanceOneAfter, totalSupply);
          const expectedUnitTwoAfter = preciseDiv(expectedBalanceTwoAfter, totalSupply);
          expect(positions[1].component).to.eq(claimAdapterMockOne.address);
          expect(positions[2].component).to.eq(claimAdapterMockTwo.address);
          expect(positions[1].unit).to.eq(expectedUnitOneAfter);
          expect(positions[2].unit).to.eq(expectedUnitTwoAfter);
        });
      });

      describe("when the rewards token is not an allowed asset", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([claimAdapterMockTwo.address]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });

    describe("#updateAnyoneClaim", async () => {
      let subjectSetToken: Address;
      let subjectAnyoneClaim: boolean;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAnyoneClaim = true;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).updateAnyoneClaim(
          subjectSetToken,
          subjectAnyoneClaim
        );
      }

      it("should change the anyoneClaim indicator", async () => {
        const anyoneClaimBefore = await claimModule.anyoneClaim(subjectSetToken);
        expect(anyoneClaimBefore).to.eq(false);

        await subject();

        const anyoneClaim = await claimModule.anyoneClaim(subjectSetToken);
        expect(anyoneClaim).to.eq(true);

        subjectAnyoneClaim = false;
        await subject();

        const anyoneClaimAfter = await claimModule.anyoneClaim(subjectSetToken);
        expect(anyoneClaimAfter).to.eq(false);
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

    describe("#addClaim", async () => {
      let subjectSetToken: Address;
      let subjectRewardPool: Address;
      let subjectIntegration: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectRewardPool = await getRandomAddress();
        subjectIntegration = claimAdapterMockIntegrationNameTwo;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).addClaim(
          subjectSetToken,
          subjectRewardPool,
          subjectIntegration
        );
      }

      it("should add the rewardPool to the rewardPoolList and rewardPoolStatus", async () => {
        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.false;

        await subject();

        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPool)).to.be.true;
        expect(await claimModule.rewardPoolList(subjectSetToken, 2)).to.eq(subjectRewardPool);
      });

      it("should add new integration for the rewardPool", async () => {
        const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        const isIntegrationAddedBefore = await claimModule.claimSettingsStatus(setToken.address, subjectRewardPool, claimAdapterMockTwo.address);
        expect(rewardPoolClaimsBefore.length).to.eq(0);
        expect(isIntegrationAddedBefore).to.be.false;

        await subject();

        const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        const isIntegrationAdded = await claimModule.claimSettingsStatus(setToken.address, subjectRewardPool, claimAdapterMockTwo.address);
        expect(rewardPoolClaims.length).to.eq(1);
        expect(rewardPoolClaims[0]).to.eq(claimAdapterMockTwo.address);
        expect(isIntegrationAdded).to.be.true;
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

    describe("#batchAddClaim", async () => {
      let subjectSetToken: Address;
      let subjectRewardPools: Address[];
      let subjectIntegrations: string[];
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        const [rewardPoolOne, rewardPoolTwo] = [await getRandomAddress(), await getRandomAddress()];
        subjectRewardPools = [rewardPoolOne, rewardPoolOne, rewardPoolTwo];
        subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo, claimAdapterMockIntegrationNameOne];
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).batchAddClaim(
          subjectSetToken,
          subjectRewardPools,
          subjectIntegrations
        );
      }

      it("should add the rewardPools to the rewardPoolList", async () => {
        const isFirstAddedBefore = await claimModule.rewardPoolStatus(subjectSetToken, subjectRewardPools[0]);
        const isSecondAddedBefore = await claimModule.rewardPoolStatus(subjectSetToken, subjectRewardPools[2]);
        expect((await claimModule.getRewardPools(subjectSetToken)).length).to.eq(2);
        expect(isFirstAddedBefore).to.be.false;
        expect(isSecondAddedBefore).to.be.false;

        await subject();

        const rewardPools = await claimModule.getRewardPools(subjectSetToken);
        const isFirstAdded = await claimModule.rewardPoolStatus(subjectSetToken, subjectRewardPools[0]);
        const isSecondAdded = await claimModule.rewardPoolStatus(subjectSetToken, subjectRewardPools[2]);
        expect(rewardPools.length).to.eq(4);
        expect(rewardPools[2]).to.eq(subjectRewardPools[0]);
        expect(rewardPools[3]).to.eq(subjectRewardPools[2]);
        expect(isFirstAdded).to.be.true;
        expect(isSecondAdded).to.be.true;
      });

      it("should add all new integrations for the rewardPools", async () => {
        await subject();

        const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
        const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[2]);
        const isFirstIntegrationAddedPool1 = await claimModule.claimSettingsStatus(
          setToken.address,
          subjectRewardPools[0],
          claimAdapterMockOne.address
        );
        const isSecondIntegrationAddedPool1 = await claimModule.claimSettingsStatus(
          setToken.address,
          subjectRewardPools[1],
          claimAdapterMockTwo.address
        );
        const isIntegrationAddedPool2 = await claimModule.claimSettingsStatus(
          setToken.address,
          subjectRewardPools[0],
          claimAdapterMockOne.address
        );
        expect(rewardPoolOneClaims[0]).to.eq(claimAdapterMockOne.address);
        expect(rewardPoolOneClaims[1]).to.eq(claimAdapterMockTwo.address);
        expect(rewardPoolTwoClaims[0]).to.eq(claimAdapterMockOne.address);
        expect(isFirstIntegrationAddedPool1).to.be.true;
        expect(isSecondIntegrationAddedPool1).to.be.true;
        expect(isIntegrationAddedPool2).to.be.true;
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

    describe("#removeClaim", async () => {
      let subjectSetToken: Address;
      let subjectRewardPool: Address;
      let subjectIntegration: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectRewardPool = await getRandomAddress();
        subjectIntegration = claimAdapterMockIntegrationNameOne;
        subjectCaller = owner;

        await claimExtension.connect(subjectCaller.wallet).addClaim(
          subjectSetToken,
          subjectRewardPool,
          subjectIntegration
        );
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).removeClaim(
          subjectSetToken,
          subjectRewardPool,
          subjectIntegration
        );
      }

      it("should remove the adapter associated to the reward pool", async () => {
        const rewardPoolClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        const isAdapterAddedBefore = await claimModule.claimSettingsStatus(setToken.address, subjectRewardPool, claimAdapterMockOne.address);
        expect(rewardPoolClaimsBefore.length).to.eq(1);
        expect(isAdapterAddedBefore).to.be.true;

        await subject();

        const rewardPoolClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPool);
        const isAdapterAdded = await claimModule.claimSettingsStatus(setToken.address, subjectRewardPool, claimAdapterMockOne.address);
        expect(rewardPoolClaims.length).to.eq(0);
        expect(isAdapterAdded).to.be.false;
      });

      it("should remove the rewardPool from the rewardPoolStatus", async () => {
        expect(await claimModule.isRewardPool(setToken.address, subjectRewardPool)).to.be.true;

        await subject();

        expect(await claimModule.isRewardPool(setToken.address, subjectRewardPool)).to.be.false;
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

    describe("#batchRemoveClaim", async () => {
      let subjectSetToken: Address;
      let subjectRewardPools: Address[];
      let subjectIntegrations: string[];
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectRewardPools = [await getRandomAddress(), await getRandomAddress()];
        subjectIntegrations = [claimAdapterMockIntegrationNameOne, claimAdapterMockIntegrationNameTwo];
        subjectCaller = owner;

        await claimExtension.connect(subjectCaller.wallet).batchAddClaim(
          subjectSetToken,
          subjectRewardPools,
          subjectIntegrations
        );
      });

      async function subject(): Promise<ContractTransaction> {
        return claimExtension.connect(subjectCaller.wallet).batchRemoveClaim(
          subjectSetToken,
          subjectRewardPools,
          subjectIntegrations
        );
      }

      it("should remove the adapter associated to the reward pool", async () => {
        const rewardPoolOneClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
        const rewardPoolTwoClaimsBefore = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
        const isRewardPoolOneAdapterOneBefore = await claimModule.claimSettingsStatus(
          setToken.address,
          subjectRewardPools[0],
          claimAdapterMockOne.address
        );
        const isRewardPoolTwoAdapterTwoBefore = await claimModule.claimSettingsStatus(
          setToken.address,
          subjectRewardPools[1],
          claimAdapterMockTwo.address
        );
        expect(rewardPoolOneClaimsBefore.length).to.eq(1);
        expect(rewardPoolTwoClaimsBefore.length).to.eq(1);
        expect(isRewardPoolOneAdapterOneBefore).to.be.true;
        expect(isRewardPoolTwoAdapterTwoBefore).to.be.true;

        await subject();

        const rewardPoolOneClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[0]);
        const rewardPoolTwoClaims = await claimModule.getRewardPoolClaims(setToken.address, subjectRewardPools[1]);
        const isRewardPoolOneAdapterOne = await claimModule.claimSettingsStatus(setToken.address, subjectRewardPools[0], claimAdapterMockOne.address);
        const isRewardPoolTwoAdapterTwo = await claimModule.claimSettingsStatus(setToken.address, subjectRewardPools[1], claimAdapterMockTwo.address);
        expect(rewardPoolOneClaims.length).to.eq(0);
        expect(rewardPoolTwoClaims.length).to.eq(0);
        expect(isRewardPoolOneAdapterOne).to.be.false;
        expect(isRewardPoolTwoAdapterTwo).to.be.false;

      });

      it("should remove the rewardPool from the rewardPoolStatus", async () => {
        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[0])).to.be.true;
        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[1])).to.be.true;

        await subject();

        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[0])).to.be.false;
        expect(await claimModule.isRewardPool(subjectSetToken, subjectRewardPools[1])).to.be.false;
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
  });
});
