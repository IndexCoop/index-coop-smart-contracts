import "module-alias/register";

import { BigNumber } from "ethers";
import { Address, Account, ReinvestmentExchangeSettings } from "@utils/types";
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

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await setV2Setup.weth.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();

    const initialRewardTokens = [rewardToken];
    const initialExchangeSettings: ReinvestmentExchangeSettings[] = [{
      exchangeName: tradeAdapterName,
      exchangeCallData: EMPTY_BYTES,
    }];
    const initialWrapPairs = [[weth, wrapAdapter.address]];

    reinvestmentExtension = await deployer.extensions.deployReinvestmentExtensionV1(
      baseManagerV2.address,
      weth,
      setV2Setup.airdropModule.address,
      tradeModule.address,
      wrapModule.address,
      initialRewardTokens,
      initialExchangeSettings,
      initialWrapPairs
    );

    await baseManagerV2.connect(operator.wallet).addExtension(reinvestmentExtension.address);
    await reinvestmentExtension.connect(operator.wallet).updateCallerStatus([operator.address], [true]);

    await setToken.setManager(baseManagerV2.address);

    await setV2Setup.weth.transfer(tradeMock.address, ether(10));
    await setV2Setup.wbtc.transfer(tradeMock.address, bitcoin(10));
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", () => {
    let subjectManager: Address;
    let subjectWeth: Address;
    let subjectAirdropModule: Address;
    let subjectTradeModule: Address;
    let subjectWrapModule: Address;
    let subjectInitialRewardTokens: Address[];
    let subjectInitialExchangeSettings: any[];
    let subjectInitialWrapPairs: Address[][];

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectWeth = weth;
      subjectAirdropModule = setV2Setup.airdropModule.address;
      subjectTradeModule = tradeModule.address;
      subjectWrapModule = wrapModule.address;
      subjectInitialRewardTokens = [rewardToken];
      subjectInitialExchangeSettings = [{
        exchangeName: tradeAdapterName,
        exchangeCallData: EMPTY_BYTES,
      }];
      subjectInitialWrapPairs = [[weth, wrapAdapter.address]];
    });

    async function subject(): Promise<ReinvestmentExtensionV1> {
      return await deployer.extensions.deployReinvestmentExtensionV1(
        subjectManager,
        subjectWeth,
        subjectAirdropModule,
        subjectTradeModule,
        subjectWrapModule,
        subjectInitialRewardTokens,
        subjectInitialExchangeSettings,
        subjectInitialWrapPairs
      );
    }

    it("should set the correct state variables", async () => {
      const extension = await subject();

      expect(await extension.manager()).to.eq(subjectManager);
      expect(await extension.WETH()).to.eq(subjectWeth);
      expect(await extension.airdropModule()).to.eq(subjectAirdropModule);
      expect(await extension.tradeModule()).to.eq(subjectTradeModule);
      expect(await extension.wrapModule()).to.eq(subjectWrapModule);
    });

    it("should set the initial exchange settings", async () => {
      const extension = await subject();

      const exchangeSettings = await extension.exchangeSettings(rewardToken);
      expect(exchangeSettings.exchangeName).to.eq(tradeAdapterName);
      expect(exchangeSettings.exchangeCallData).to.eq(EMPTY_BYTES);
    });

    it("should set the initial wrap pairs", async () => {
      const extension = await subject();

      const isApproved = await extension.approvedWrapPairs(weth, wrapAdapter.address);
      expect(isApproved).to.be.true;
    });

    describe("when WETH address is zero", () => {
      beforeEach(async () => {
        subjectWeth = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid WETH address");
      });
    });

    describe("when arrays length mismatch", () => {
      beforeEach(async () => {
        subjectInitialExchangeSettings = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Arrays length mismatch");
      });
    });

    describe("when reward token is zero address", () => {
      beforeEach(async () => {
        subjectInitialRewardTokens = [ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid reward token");
      });
    });

    describe("when wrap pair contains zero address", () => {
      beforeEach(async () => {
        subjectInitialWrapPairs = [[ADDRESS_ZERO, wrapAdapter.address]];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid token address");
      });
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
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;
    let subjectIntegrationName: string;
    let subjectWrapData: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      await reinvestmentExtension.connect(operator.wallet).initializeWrapModule();

      await setV2Setup.weth.transfer(setToken.address, ether(1));
      await setV2Setup.weth.transfer(wrapAdapter.address, ether(10));

      subjectUnderlyingToken = weth;
      subjectWrappedToken = wrapAdapter.address;
      subjectUnderlyingUnits = ether(0.1);
      subjectIntegrationName = wrapAdapterName;
      subjectWrapData = EMPTY_BYTES;
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension.connect(subjectCaller.wallet).wrap(
        subjectUnderlyingToken,
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

    describe("when underlying units is zero", () => {
      beforeEach(async () => {
        subjectUnderlyingUnits = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid units");
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

    describe("when wrap pair is not approved", () => {
      beforeEach(async () => {
        await reinvestmentExtension.connect(operator.wallet).removeWrapPair(subjectUnderlyingToken, subjectWrappedToken);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unapproved wrap pair");
      });
    });
  });

  describe("#updateExchangeSettings", () => {
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
        .updateExchangeSettings(subjectRewardToken, subjectSettings);
    }

    it("should update the exchange settings", async () => {
      await subject();

      const newSettings = await reinvestmentExtension.exchangeSettings(subjectRewardToken);
      expect(newSettings.exchangeName).to.eq(subjectSettings.exchangeName);
      expect(newSettings.exchangeCallData).to.eq(subjectSettings.exchangeCallData);
    });

    describe("when reward token is zero address", () => {
      beforeEach(async () => {
        subjectRewardToken = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid reward token");
      });
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

  describe("#addWrapPair", () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectUnderlyingToken = setV2Setup.usdc.address;
      subjectWrappedToken = wrapAdapter.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension
        .connect(subjectCaller.wallet)
        .addWrapPair(subjectUnderlyingToken, subjectWrappedToken);
    }

    it("should add the wrap pair", async () => {
      await subject();

      const isApproved = await reinvestmentExtension.approvedWrapPairs(
        subjectUnderlyingToken,
        subjectWrappedToken
      );
      expect(isApproved).to.be.true;
    });

    describe("when pair already exists", () => {
      beforeEach(async () => {
        await reinvestmentExtension
          .connect(operator.wallet)
          .addWrapPair(subjectUnderlyingToken, subjectWrappedToken);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pair already exists");
      });
    });

    describe("when token addresses are invalid", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid token address");
      });
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

  describe("#removeWrapPair", () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectUnderlyingToken = weth;
      subjectWrappedToken = wrapAdapter.address;
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return reinvestmentExtension
        .connect(subjectCaller.wallet)
        .removeWrapPair(subjectUnderlyingToken, subjectWrappedToken);
    }

    it("should remove the wrap pair", async () => {
      await subject();

      const isApproved = await reinvestmentExtension.approvedWrapPairs(
        subjectUnderlyingToken,
        subjectWrappedToken
      );
      expect(isApproved).to.be.false;
    });

    describe("when pair does not exist", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = setV2Setup.usdc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pair does not exist");
      });
    });

    describe("when token addresses are invalid", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid token address");
      });
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