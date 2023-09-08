import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO_BYTES } from "@utils/constants";
import {
  DelegatedManager,
  GlobalWrapExtension,
  ManagerCore,
} from "@utils/contracts/index";
import {
  SetToken,
  WrapModuleV2,
  WrapV2AdapterMock
} from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  preciseMul,
  getProvider,
  getRandomAccount,
  getSetFixture,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("GlobalWrapExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SetFixture;

  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;
  let wrapExtension: GlobalWrapExtension;

  let wrapModule: WrapModuleV2;
  let wrapAdapterMock: WrapV2AdapterMock;
  const wrapAdapterMockIntegrationName: string = "MOCK_WRAPPER_V2";

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

    wrapModule = await deployer.setV2.deployWrapModuleV2(setV2Setup.controller.address, setV2Setup.weth.address);
    await setV2Setup.controller.addModule(wrapModule.address);

    wrapAdapterMock = await deployer.setV2.deployWrapV2AdapterMock();

    await setV2Setup.integrationRegistry.addIntegration(
      wrapModule.address,
      wrapAdapterMockIntegrationName,
      wrapAdapterMock.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();

    wrapExtension = await deployer.globalExtensions.deployGlobalWrapExtension(
      managerCore.address,
      wrapModule.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, wrapModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [wrapExtension.address],
      [operator.address],
      [setV2Setup.dai.address, setV2Setup.weth.address, setV2Setup.wbtc.address],
      true
    );

    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([wrapExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerCore: Address;
    let subjectWrapModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectWrapModule = wrapModule.address;
    });

    async function subject(): Promise<GlobalWrapExtension> {
      return await deployer.globalExtensions.deployGlobalWrapExtension(
        subjectManagerCore,
        subjectWrapModule
      );
    }

    it("should set the correct WrapModuleV2 address", async () => {
      const wrapExtension = await subject();

      const storedModule = await wrapExtension.wrapModule();
      expect(storedModule).to.eq(subjectWrapModule);
    });
  });

  describe("#initializeModule", async () => {
    let subjectDelegatedManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return wrapExtension.connect(subjectCaller.wallet).initializeModule(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(wrapModule.address);
      expect(isModuleInitialized).to.eq(true);
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
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(wrapModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be initialized extension");
      });
    });

    describe("when the extension is pending", async () => {
      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
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
      return wrapExtension.connect(subjectCaller.wallet).initializeExtension(subjectDelegatedManager);
    }

    it("should store the correct SetToken and DelegatedManager on the WrapExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await wrapExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the WrapExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(wrapExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct WrapExtensionInitialized event", async () => {
      await expect(subject()).to.emit(wrapExtension, "WrapExtensionInitialized").withArgs(
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
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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

    beforeEach(async () => {
      subjectDelegatedManager = delegatedManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return wrapExtension.connect(subjectCaller.wallet).initializeModuleAndExtension(subjectDelegatedManager);
    }

    it("should initialize the module on the SetToken", async () => {
      await subject();

      const isModuleInitialized: Boolean = await setToken.isInitializedModule(wrapModule.address);
      expect(isModuleInitialized).to.eq(true);
    });

    it("should store the correct SetToken and DelegatedManager on the WrapExtension", async () => {
      await subject();

      const storedDelegatedManager: Address = await wrapExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(delegatedManager.address);
    });

    it("should initialize the WrapExtension on the DelegatedManager", async () => {
      await subject();

      const isExtensionInitialized: Boolean = await delegatedManager.isInitializedExtension(wrapExtension.address);
      expect(isExtensionInitialized).to.eq(true);
    });

    it("should emit the correct WrapExtensionInitialized event", async () => {
      await expect(subject()).to.emit(wrapExtension, "WrapExtensionInitialized").withArgs(
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

    describe("when the module is not pending or initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).setManager(owner.address);
        await setToken.connect(owner.wallet).removeModule(wrapModule.address);
        await setToken.connect(owner.wallet).setManager(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the module is already initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
        await delegatedManager.connect(owner.wallet).addExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the extension is not pending or initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
        await delegatedManager.connect(owner.wallet).removeExtensions([wrapExtension.address]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Extension must be pending");
      });
    });

    describe("when the extension is already initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);
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
    let subjectWrapExtension: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      await wrapExtension.connect(owner.wallet).initializeExtension(delegatedManager.address);

      subjectManager = delegatedManager;
      subjectWrapExtension = [wrapExtension.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return subjectManager.connect(subjectCaller.wallet).removeExtensions(subjectWrapExtension);
    }

    it("should clear SetToken and DelegatedManager from WrapExtension state", async () => {
      await subject();

      const storedDelegatedManager: Address = await wrapExtension.setManagers(setToken.address);
      expect(storedDelegatedManager).to.eq(ADDRESS_ZERO);
    });

    it("should emit the correct ExtensionRemoved event", async () => {
      await expect(subject()).to.emit(wrapExtension, "ExtensionRemoved").withArgs(
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

  context("when the WrapExtension is initialized and SetToken has been issued", async () => {
    let setTokensIssued: BigNumber;

    before(async () => {
      wrapExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address);

      // Issue some Sets
      setTokensIssued = ether(10);
      const underlyingRequired = setTokensIssued;
      await setV2Setup.weth.approve(setV2Setup.issuanceModule.address, underlyingRequired);
      await setV2Setup.issuanceModule.issue(setToken.address, setTokensIssued, owner.address);
    });

    describe("#wrap", async () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectUnderlyingUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectWrapData: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).addAllowedAssets([wrapAdapterMock.address]);

        subjectSetToken = setToken.address;
        subjectUnderlyingToken = setV2Setup.weth.address;
        subjectWrappedToken = wrapAdapterMock.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = wrapAdapterMockIntegrationName;
        subjectWrapData = ZERO_BYTES;
        subjectCaller = operator;
      });

      async function subject(): Promise<any> {
        return wrapExtension.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName,
          subjectWrapData
        );
      }

      it("should mint the correct wrapped asset to the SetToken", async () => {
        await subject();
        const wrappedBalance = await wrapAdapterMock.balanceOf(setToken.address);
        const expectedTokenBalance = setTokensIssued;
        expect(wrappedBalance).to.eq(expectedTokenBalance);
      });

      it("should reduce the correct quantity of the underlying quantity", async () => {
        const previousUnderlyingBalance = await setV2Setup.weth.balanceOf(setToken.address);

        await subject();
        const underlyingTokenBalance = await setV2Setup.weth.balanceOf(setToken.address);
        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(setTokensIssued);
        expect(underlyingTokenBalance).to.eq(expectedUnderlyingBalance);
      });

      it("remove the underlying position and replace with the wrapped token position", async () => {
        await subject();

        const positions = await setToken.getPositions();
        const receivedWrappedTokenPosition = positions[0];

        expect(positions.length).to.eq(1);
        expect(receivedWrappedTokenPosition.component).to.eq(subjectWrappedToken);
        expect(receivedWrappedTokenPosition.unit).to.eq(subjectUnderlyingUnits);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be approved operator");
        });
      });

      describe("when the wrapped token is not an allowed asset", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([wrapAdapterMock.address]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });

    describe("#wrapWithEther", async () => {
      let subjectSetToken: Address;
      let subjectWrappedToken: Address;
      let subjectUnderlyingUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectWrapData: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        await delegatedManager.connect(owner.wallet).addAllowedAssets([wrapAdapterMock.address]);

        subjectSetToken = setToken.address;
        subjectWrappedToken = wrapAdapterMock.address;
        subjectUnderlyingUnits = ether(1);
        subjectIntegrationName = wrapAdapterMockIntegrationName;
        subjectWrapData = ZERO_BYTES;
        subjectCaller = operator;
      });

      async function subject(): Promise<any> {
        return wrapExtension.connect(subjectCaller.wallet).wrapWithEther(
          subjectSetToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName,
          subjectWrapData
        );
      }

      it("should mint the correct wrapped asset to the SetToken", async () => {
        await subject();
        const wrappedBalance = await wrapAdapterMock.balanceOf(setToken.address);
        const expectedTokenBalance = setTokensIssued;
        expect(wrappedBalance).to.eq(expectedTokenBalance);
      });

      it("should reduce the correct quantity of WETH", async () => {
        const previousUnderlyingBalance = await setV2Setup.weth.balanceOf(setToken.address);

        await subject();
        const underlyingTokenBalance = await setV2Setup.weth.balanceOf(setToken.address);
        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(setTokensIssued);
        expect(underlyingTokenBalance).to.eq(expectedUnderlyingBalance);
      });

      it("should send the correct quantity of ETH to the external protocol", async () => {
        const provider = getProvider();
        const preEthBalance = await provider.getBalance(wrapAdapterMock.address);

        await subject();

        const postEthBalance = await provider.getBalance(wrapAdapterMock.address);
        expect(postEthBalance).to.eq(preEthBalance.add(preciseMul(subjectUnderlyingUnits, setTokensIssued)));
      });

      it("removes the underlying position and replace with the wrapped token position", async () => {
        await subject();

        const positions = await setToken.getPositions();
        const receivedWrappedTokenPosition = positions[0];

        expect(positions.length).to.eq(1);
        expect(receivedWrappedTokenPosition.component).to.eq(subjectWrappedToken);
        expect(receivedWrappedTokenPosition.unit).to.eq(subjectUnderlyingUnits);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be approved operator");
        });
      });

      describe("when the wrapped token is not an allowed asset", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([wrapAdapterMock.address]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });

    describe("#unwrap", async () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectWrappedTokenUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectUnwrapData: string;
      let subjectCaller: Account;

      let wrappedQuantity: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = setV2Setup.weth.address;
        subjectWrappedToken = wrapAdapterMock.address;
        subjectWrappedTokenUnits = ether(0.5);
        subjectIntegrationName = wrapAdapterMockIntegrationName;
        subjectUnwrapData = ZERO_BYTES;
        subjectCaller = operator;

        wrappedQuantity = ether(1);

        await delegatedManager.connect(owner.wallet).addAllowedAssets([wrapAdapterMock.address]);

        await wrapExtension.connect(operator.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          wrappedQuantity,
          subjectIntegrationName,
          ZERO_BYTES
        );
      });

      async function subject(): Promise<any> {
        return wrapExtension.connect(subjectCaller.wallet).unwrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectWrappedTokenUnits,
          subjectIntegrationName,
          subjectUnwrapData
        );
      }

      it("should burn the correct wrapped asset to the SetToken", async () => {
        await subject();
        const newWrappedBalance = await wrapAdapterMock.balanceOf(setToken.address);
        const expectedTokenBalance = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));
        expect(newWrappedBalance).to.eq(expectedTokenBalance);
      });

      it("should properly update the underlying and wrapped token units", async () => {
        await subject();

        const positions = await setToken.getPositions();
        const [receivedWrappedPosition, receivedUnderlyingPosition] = positions;

        expect(positions.length).to.eq(2);
        expect(receivedWrappedPosition.component).to.eq(subjectWrappedToken);
        expect(receivedWrappedPosition.unit).to.eq(ether(0.5));

        expect(receivedUnderlyingPosition.component).to.eq(subjectUnderlyingToken);
        expect(receivedUnderlyingPosition.unit).to.eq(ether(0.5));
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be approved operator");
        });
      });

      describe("when the underlying token is not an allowed asset", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([setV2Setup.weth.address]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });

    describe("#unwrapWithEther", async () => {
      let subjectSetToken: Address;
      let subjectWrappedToken: Address;
      let subjectWrappedTokenUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectUnwrapData: string;
      let subjectCaller: Account;

      let wrappedQuantity: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectWrappedToken = wrapAdapterMock.address;
        subjectWrappedTokenUnits = ether(0.5);
        subjectIntegrationName = wrapAdapterMockIntegrationName;
        subjectUnwrapData = ZERO_BYTES;
        subjectCaller = operator;

        wrappedQuantity = ether(1);

        await delegatedManager.connect(owner.wallet).addAllowedAssets([wrapAdapterMock.address]);

        await wrapExtension.connect(operator.wallet).wrapWithEther(
          subjectSetToken,
          subjectWrappedToken,
          wrappedQuantity,
          subjectIntegrationName,
          ZERO_BYTES
        );
      });

      async function subject(): Promise<any> {
        return wrapExtension.connect(subjectCaller.wallet).unwrapWithEther(
          subjectSetToken,
          subjectWrappedToken,
          subjectWrappedTokenUnits,
          subjectIntegrationName,
          subjectUnwrapData
        );
      }

      it("should burn the correct wrapped asset to the SetToken", async () => {
        await subject();
        const newWrappedBalance = await wrapAdapterMock.balanceOf(setToken.address);
        const expectedTokenBalance = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));
        expect(newWrappedBalance).to.eq(expectedTokenBalance);
      });

      it("should properly update the underlying and wrapped token units", async () => {
        await subject();

        const positions = await setToken.getPositions();
        const [receivedWrappedPosition, receivedUnderlyingPosition] = positions;

        expect(positions.length).to.eq(2);
        expect(receivedWrappedPosition.component).to.eq(subjectWrappedToken);
        expect(receivedWrappedPosition.unit).to.eq(ether(0.5));

        expect(receivedUnderlyingPosition.component).to.eq(setV2Setup.weth.address);
        expect(receivedUnderlyingPosition.unit).to.eq(ether(0.5));
      });

      it("should have sent the correct quantity of ETH to the SetToken", async () => {
        const provider = getProvider();
        const preEthBalance = await provider.getBalance(wrapAdapterMock.address);

        await subject();

        const postEthBalance = await provider.getBalance(wrapAdapterMock.address);
        expect(postEthBalance).to.eq(preEthBalance.sub(preciseMul(subjectWrappedTokenUnits, setTokensIssued)));
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be approved operator");
        });
      });

      describe("when the underlying token is not an allowed asset", async () => {
        beforeEach(async () => {
          await delegatedManager.connect(owner.wallet).removeAllowedAssets([setV2Setup.weth.address]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be allowed asset");
        });
      });
    });
  });
});
