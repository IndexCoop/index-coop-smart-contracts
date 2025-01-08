import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256, ZERO } from "@utils/constants";
import {
  ReinvestmentExtensionV1,
  BaseManagerV2,
  BatchTradeAdapterMock,
  WrapV2AdapterMock
} from "@utils/contracts/index";
import {
  SetToken,
  TradeModule,
  WrapModuleV2
} from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  bitcoin,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getWaffleExpect
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("ReinvestmentExtensionV1", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;

  let setV2Setup: SetFixture;
  let deployer: DeployHelper;
  let setToken: SetToken;
  let baseManagerV2: BaseManagerV2;
  let reinvestmentExtension: ReinvestmentExtensionV1;

  let weth: Address;
  let rewardToken: Address;

  let tradeModule: TradeModule;
  let tradeMock: BatchTradeAdapterMock;
  let wrapAdapter: WrapV2AdapterMock;
  const tradeAdapterName = "TRADEMOCK";
  const wrapAdapterName = "WRAPMOCK";
  let wrapModule: WrapModuleV2;

  before(async () => {
    [owner, methodologist, operator] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    tradeModule = await deployer.setV2.deployTradeModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(tradeModule.address);

    wrapModule = await deployer.setV2.deployWrapModuleV2(
      setV2Setup.controller.address,
      setV2Setup.weth.address
    );
    await setV2Setup.controller.addModule(wrapModule.address);

    tradeMock = await deployer.mocks.deployBatchTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      tradeModule.address,
      tradeAdapterName,
      tradeMock.address
    );

    wrapAdapter = await deployer.mocks.deployWrapV2AdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      wrapModule.address,
      wrapAdapterName,
      wrapAdapter.address
    );

    weth = setV2Setup.weth.address;
    rewardToken = setV2Setup.wbtc.address;

    setToken = await setV2Setup.createSetToken(
      [weth],
      [ether(1)],
      [
        setV2Setup.issuanceModule.address,
        setV2Setup.airdropModule.address,
        tradeModule.address,
        wrapModule.address,
      ]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    await setV2Setup.weth.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();

    reinvestmentExtension = await deployer.extensions.deployReinvestmentExtensionV1(
      baseManagerV2.address,
      weth,
      setV2Setup.airdropModule.address,
      tradeModule.address,
      wrapModule.address
    );

    await baseManagerV2.connect(operator.wallet).addExtension(reinvestmentExtension.address);
    await reinvestmentExtension.connect(operator.wallet).updateCallerStatus([operator.address], [true]);

    await setToken.setManager(baseManagerV2.address);

    await setV2Setup.weth.transfer(tradeMock.address, ether(10));
    await setV2Setup.wbtc.transfer(tradeMock.address, bitcoin(10));

    await reinvestmentExtension.connect(operator.wallet).updateExecutionSettings(
      rewardToken,
      {
        exchangeName: tradeAdapterName,
        exchangeCallData: EMPTY_BYTES,
      }
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", () => {
    let subjectManager: Address;
    let subjectAirdropModule: Address;
    let subjectTradeModule: Address;
    let subjectWrapModule: Address;
    let subjectWeth: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectAirdropModule = setV2Setup.airdropModule.address;
      subjectTradeModule = tradeModule.address;
      subjectWrapModule = wrapModule.address;
      subjectWeth = weth;
    });

    async function subject(): Promise<ReinvestmentExtensionV1> {
      return await deployer.extensions.deployReinvestmentExtensionV1(
        subjectManager,
        subjectWeth,
        subjectAirdropModule,
        subjectTradeModule,
        subjectWrapModule
      );
    }

    it("should set the correct manager address", async () => {
      const extension = await subject();
      const manager = await extension.manager();
      expect(manager).to.eq(subjectManager);
    });

    it("should set the correct airdrop module address", async () => {
      const extension = await subject();
      const airdropModule = await extension.airdropModule();
      expect(airdropModule).to.eq(subjectAirdropModule);
    });

    it("should set the correct trade module address", async () => {
      const extension = await subject();
      const tradeModule = await extension.tradeModule();
      expect(tradeModule).to.eq(subjectTradeModule);
    });

    it("should set the correct wrap module address", async () => {
      const extension = await subject();
      const wrapModule = await extension.wrapModule();
      expect(wrapModule).to.eq(subjectWrapModule);
    });

    it("should set the correct WETH address", async () => {
      const extension = await subject();
      const wethAddress = await extension.WETH();
      expect(wethAddress).to.eq(subjectWeth);
    });
  });

  describe("#reinvest", () => {
    let subjectRewardToken: Address;
    let subjectMinReceiveQuantity: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      await reinvestmentExtension.connect(operator.wallet).initializeAirdropModule({
        airdrops: [rewardToken],
        feeRecipient: operator.address,
        airdropFee: ZERO,
        anyoneAbsorb: false,
      });
      await reinvestmentExtension.connect(operator.wallet).initializeTradeModule();
      await reinvestmentExtension.connect(operator.wallet).initializeWrapModule();

      await setV2Setup.wbtc.transfer(setToken.address, bitcoin(1));

      subjectRewardToken = rewardToken;
      subjectMinReceiveQuantity = ether(1);
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension
        .connect(subjectCaller.wallet)
        .reinvest(subjectRewardToken, subjectMinReceiveQuantity);
    }

    it("should absorb and trade the reward token", async () => {
      const preWethBalance = await setToken.getDefaultPositionRealUnit(weth);

      await subject();

      const postWethBalance = await setToken.getDefaultPositionRealUnit(weth);
      const postRewardBalance = await setToken.getDefaultPositionRealUnit(rewardToken);

      expect(postWethBalance).to.gt(preWethBalance);
      expect(postRewardBalance).to.eq(ZERO);
    });

    describe("when reward units are zero", () => {
      beforeEach(async () => {
        await reinvestmentExtension.connect(operator.wallet).reinvest(rewardToken, ZERO);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Reward units must be greater than zero");
      });
    });

    describe("when caller is not allowed", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to call");
      });
    });
  });

  describe("#wrap", () => {
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;
    let subjectIntegrationName: string;
    let subjectWrapData: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await reinvestmentExtension.connect(operator.wallet).initializeWrapModule();

      await setV2Setup.weth.transfer(setToken.address, ether(1));
      await setV2Setup.weth.transfer(wrapAdapter.address, ether(10));

      subjectWrappedToken = wrapAdapter.address;
      subjectUnderlyingUnits = ether(0.1);
      subjectIntegrationName = wrapAdapterName;
      subjectWrapData = EMPTY_BYTES;
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension.connect(subjectCaller.wallet).wrap(
        subjectWrappedToken,
        subjectUnderlyingUnits,
        subjectIntegrationName,
        subjectWrapData
      );
    }

    it("should wrap the correct amount of tokens", async () => {
      const preWrapUnderlyingBalance = await setToken.getDefaultPositionRealUnit(weth);

      await subject();

      const wrappedTokenUnits = await setToken.getDefaultPositionRealUnit(subjectWrappedToken);
      const expectedWrappedTokenUnits = subjectUnderlyingUnits;
      expect(wrappedTokenUnits).to.eq(expectedWrappedTokenUnits);

      const postWrapUnderlyingBalance = await setToken.getDefaultPositionRealUnit(weth);
      expect(postWrapUnderlyingBalance).to.eq(preWrapUnderlyingBalance.sub(subjectUnderlyingUnits));
    });

    describe("when caller is not operator", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#updateExecutionSettings", () => {
    let subjectRewardToken: Address;
    let subjectSettings: {
      exchangeName: string;
      exchangeCallData: string;
    };
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectRewardToken = rewardToken;
      subjectSettings = {
        exchangeName: "NewAdapter",
        exchangeCallData: "0x123456",
      };
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension
        .connect(subjectCaller.wallet)
        .updateExecutionSettings(subjectRewardToken, subjectSettings);
    }

    it("should update the execution settings", async () => {
      await subject();

      const newSettings = await reinvestmentExtension.settings(subjectRewardToken);
      expect(newSettings.exchangeName).to.eq(subjectSettings.exchangeName);
      expect(newSettings.exchangeCallData).to.eq(subjectSettings.exchangeCallData);
    });

    describe("when caller is not allowed", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to call");
      });
    });
  });

  describe("#addAirdrop", () => {
    let subjectToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await reinvestmentExtension.connect(operator.wallet).initializeAirdropModule({
        airdrops: [],
        feeRecipient: operator.address,
        airdropFee: ZERO,
        anyoneAbsorb: false,
      });

      subjectToken = setV2Setup.wbtc.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension.connect(subjectCaller.wallet).addAirdrop(subjectToken);
    }

    it("should add the token to airdrops", async () => {
      await subject();

      const airdrops = await setV2Setup.airdropModule.getAirdrops(setToken.address);
      expect(airdrops).to.include(subjectToken);
    });

    describe("when caller is not operator", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#initializeModules", () => {
    describe("#initializeAirdropModule", () => {
      let subjectAirdropSettings: any;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectAirdropSettings = {
          airdrops: [rewardToken],
          feeRecipient: operator.address,
          airdropFee: ZERO,
          anyoneAbsorb: false,
        };
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return reinvestmentExtension
          .connect(subjectCaller.wallet)
          .initializeAirdropModule(subjectAirdropSettings);
      }

      it("should initialize the airdrop module", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.airdropModule.address);
        expect(isInitialized).to.be.true;
      });

      describe("when caller is not operator", () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#initializeTradeModule", () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return reinvestmentExtension.connect(subjectCaller.wallet).initializeTradeModule();
      }

      it("should initialize the trade module", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(tradeModule.address);
        expect(isInitialized).to.be.true;
      });

      describe("when caller is not operator", () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    describe("#initializeWrapModule", () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return reinvestmentExtension.connect(subjectCaller.wallet).initializeWrapModule();
      }

      it("should initialize the wrap module", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(wrapModule.address);
        expect(isInitialized).to.be.true;
      });

      describe("when caller is not operator", () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});