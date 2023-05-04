import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers, network } from "hardhat";

import {
  Address,
  Account,
  AaveContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings,
} from "@utils/types";
import { impersonateAccount } from "../../../utils/test/testingUtils";
import { ADDRESS_ZERO, EMPTY_BYTES, ZERO, ONE, TWO, THREE, MAX_UINT_256 } from "@utils/constants";
import { BaseManager, ChainlinkAggregatorV3Mock } from "@utils/contracts/index";
import {
  AaveV2VariableDebtToken,
  AaveV2VariableDebtToken__factory,
  AaveV3LeverageModule,
  AaveV3LeverageStrategyExtension,
  ContractCallerMock,
  Controller,
  Controller__factory,
  IAaveOracle,
  IAaveOracle__factory,
  IPoolConfigurator,
  IPoolConfigurator__factory,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  SetToken,
  SetToken__factory,
  IERC20,
  IERC20__factory,
  IAaveProtocolDataProvider,
  IAaveProtocolDataProvider__factory,
  IPool,
  IPool__factory,
  TradeAdapterMock,
} from "../../../typechain";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getEthBalance,
  getWaffleExpect,
  getRandomAccount,
  getLastBlockTimestamp,
  increaseTimeAsync,
  preciseMul,
  calculateNewLeverageRatio,
  calculateCollateralRebalanceUnits,
  calculateMaxBorrowForDelever,
  calculateMaxRedeemForDeleverToZero,
} from "@utils/index";
import { calculateTotalRebalanceNotionalAave } from "@utils/flexibleLeverageUtils/flexibleLeverage";

const expect = getWaffleExpect();
const provider = ethers.provider;

const contractAddresses = {
  aaveV3AddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  aaveV3ProtocolDataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
  aaveV3Oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
  aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  aaveV3PoolConfigurator: "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27",
  aaveGovernance: "0xEE56e2B3D491590B5b31738cC34d5232F378a8D5",
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
  uniswapV3ExchangeAdapterV2: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  uniswapV3Router: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  wethDaiPool: "0x60594a405d53811d3bc4766596efd80fd545a270",
  aTokenImpl: "0x7EfFD7b47Bfd17e52fB7559d3f924201b9DbfF3d",
  stableDebtTokenImpl: "0x15C5620dfFaC7c7366EED66C20Ad222DDbB1eD57",
  variableDebtTokenImpl: "0xaC725CB59D16C81061BDeA61041a8A5e73DA9EC6",
  interestRateStrategy: "0x76884cAFeCf1f7d4146DA6C4053B18B76bf6ED14",
  aaveTreasury: "0x464C71f6c2F760DdA6093dCB91C24c39e5d6e18c",
  aaveIncentivesController: "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb",
};

const tokenAddresses = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  aWethV3: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  aWethVariableDebtTokenV3: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  aDaiV3: "0x018008bfb33d285247A21d44E50697654f754e63",
  aDaiVariableDebtTokenV3: "0xcF8d0c70c850859266f5C338b38F9D663181C314",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  aUSDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  aUsdcVariableDebtTokenV3: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
  stEth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  wstEth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  awstEthV3: "0x0B925eD163218f6662a35e0f0371Ac234f9E9371",
};

const whales = {
  dai: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  aWeth: "0x702a39a9d7D84c6B269efaA024dff4037499bBa9",
  awsteth: "0xAF06acFD1BD492B913d5807d562e4FC3A6343C4E",
  wsteth: "0x5fEC2f34D80ED82370F733043B6A536d7e9D7f8d",
  weth: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28",
  usdc: "0xCFFAd3200574698b78f32232aa9D63eABD290703",
};

if (process.env.INTEGRATIONTEST) {
  describe("AaveV3LeverageStrategyExtension", () => {
    let owner: Account;
    let methodologist: Account;

    let deployer: DeployHelper;
    let setToken: SetToken;
    let controller: Controller;
    let aaveLeverageModule: AaveV3LeverageModule;
    let lendingPoolConfigurator: IPoolConfigurator;
    let lendingPool: IPool;
    let debtIssuanceModule: DebtIssuanceModuleV2;
    let protocolDataProvider: IAaveProtocolDataProvider;
    let aaveOracle: IAaveOracle;
    let integrationRegistry: IntegrationRegistry;
    let setTokenCreator: SetTokenCreator;
    let tradeAdapterMock: TradeAdapterMock;
    let tradeAdapterMock2: TradeAdapterMock;
    let aWeth: IERC20;
    let aUsdc: IERC20;
    let usdcVariableDebtToken: AaveV2VariableDebtToken;
    let weth: IERC20;
    let usdc: IERC20;

    let strategy: AaveContractSettings;
    let methodology: MethodologySettings;
    let execution: ExecutionSettings;
    let incentive: IncentiveSettings;
    const exchangeName = "MockTradeAdapter";
    const exchangeName2 = "MockTradeAdapter2";
    let exchangeSettings: ExchangeSettings;
    let customTargetLeverageRatio: any;
    let customMinLeverageRatio: any;
    let customATokenCollateralAddress: any;

    let leverageStrategyExtension: AaveV3LeverageStrategyExtension;
    let baseManagerV2: BaseManager;
    let manager: Address;

    let chainlinkCollateralPriceMock: ChainlinkAggregatorV3Mock;
    let chainlinkBorrowPriceMock: ChainlinkAggregatorV3Mock;

    cacheBeforeEach(async () => {
      [owner, methodologist] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      // Deploy Aave leverage module and add to controller
      aaveLeverageModule = await deployer.setV2.deployAaveV3LeverageModule(
        contractAddresses.controller,
        contractAddresses.aaveV3AddressProvider,
      );

      manager = owner.address;
      usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
      await usdc
        .connect(await impersonateAccount(whales.usdc))
        .transfer(owner.address, await usdc.balanceOf(whales.usdc).then(b => b.div(10)));
      weth = IERC20__factory.connect(tokenAddresses.weth, owner.wallet);
      await weth
        .connect(await impersonateAccount(whales.weth))
        .transfer(owner.address, await weth.balanceOf(whales.weth).then(b => b.div(10)));

      aaveOracle = IAaveOracle__factory.connect(
        contractAddresses.aaveV3Oracle,
        await impersonateAccount(contractAddresses.aaveGovernance),
      );
      aWeth = IERC20__factory.connect(tokenAddresses.aWethV3, owner.wallet);
      aWeth
        .connect(await impersonateAccount(whales.aWeth))
        .transfer(owner.address, await aWeth.balanceOf(whales.aWeth).then(b => b.div(10)));
      aUsdc = IERC20__factory.connect(tokenAddresses.aUSDC, owner.wallet);
      usdcVariableDebtToken = AaveV2VariableDebtToken__factory.connect(
        tokenAddresses.aUsdcVariableDebtTokenV3,
        owner.wallet,
      );

      controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);
      const controllerOwner = await controller.owner();
      const controllerOwnerSigner = await impersonateAccount(controllerOwner);
      controller = controller.connect(controllerOwnerSigner);

      await controller.addModule(aaveLeverageModule.address);

      integrationRegistry = IntegrationRegistry__factory.connect(
        contractAddresses.integrationRegistry,
        owner.wallet,
      );
      const integrationRegistryOwner = await integrationRegistry.owner();
      integrationRegistry = integrationRegistry.connect(
        await impersonateAccount(integrationRegistryOwner),
      );

      tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
      await integrationRegistry.addIntegration(
        aaveLeverageModule.address,
        exchangeName,
        tradeAdapterMock.address,
      );

      // Deploy mock trade adapter 2
      tradeAdapterMock2 = await deployer.mocks.deployTradeAdapterMock();
      await integrationRegistry.addIntegration(
        aaveLeverageModule.address,
        exchangeName2,
        tradeAdapterMock2.address,
      );

      setTokenCreator = SetTokenCreator__factory.connect(
        contractAddresses.setTokenCreator,
        owner.wallet,
      );

      protocolDataProvider = IAaveProtocolDataProvider__factory.connect(
        contractAddresses.aaveV3ProtocolDataProvider,
        owner.wallet,
      );

      lendingPoolConfigurator = IPoolConfigurator__factory.connect(
        contractAddresses.aaveV3PoolConfigurator,
        owner.wallet,
      );
      await network.provider.send("hardhat_setBalance", [
        contractAddresses.aaveGovernance,
        ether(10).toHexString(),
      ]);
      lendingPoolConfigurator = lendingPoolConfigurator.connect(
        await impersonateAccount(contractAddresses.aaveGovernance),
      );

      lendingPool = IPool__factory.connect(contractAddresses.aaveV3Pool, owner.wallet);

      debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
        contractAddresses.debtIssuanceModule,
        owner.wallet,
      );

      await integrationRegistry.addIntegration(
        aaveLeverageModule.address,
        "DefaultIssuanceModule",
        debtIssuanceModule.address,
      );
      await integrationRegistry.addIntegration(
        debtIssuanceModule.address,
        "AaveLeverageModuleV3",
        aaveLeverageModule.address,
      );

      // Deploy Chainlink mocks
      chainlinkCollateralPriceMock = await deployer.mocks.deployChainlinkAggregatorMock();
      await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
      chainlinkBorrowPriceMock = await deployer.mocks.deployChainlinkAggregatorMock();
      await chainlinkBorrowPriceMock.setPrice(10 ** 8);
      await aaveOracle.setAssetSources(
        [weth.address, usdc.address],
        [chainlinkCollateralPriceMock.address, chainlinkBorrowPriceMock.address],
      );
    });

    async function createSetToken(
      components: Address[],
      positions: BigNumber[],
      modules: Address[],
    ): Promise<SetToken> {
      const setTokenAddress = await setTokenCreator.callStatic.create(
        components,
        positions,
        modules,
        manager,
        "TestSetToken",
        "TEST",
      );

      await setTokenCreator.create(components, positions, modules, manager, "TestSetToken", "TEST");
      return SetToken__factory.connect(setTokenAddress, owner.wallet);
    }

    const initializeRootScopeContracts = async () => {
      setToken = await createSetToken(
        [tokenAddresses.aWethV3],
        [ether(1)],
        [debtIssuanceModule.address, aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await aaveLeverageModule.updateAnySetAllowed(true);

      // Initialize modules
      await debtIssuanceModule.initialize(
        setToken.address,
        ether(1),
        ZERO,
        ZERO,
        owner.address,
        ADDRESS_ZERO,
      );
      await aaveLeverageModule.initialize(setToken.address, [weth.address], [usdc.address]);

      baseManagerV2 = await deployer.manager.deployBaseManager(
        setToken.address,
        owner.address,
        methodologist.address,
      );

      // Transfer ownership to ic manager
      if ((await setToken.manager()) == owner.address) {
        await setToken.connect(owner.wallet).setManager(baseManagerV2.address);
      }

      // Deploy adapter
      const targetLeverageRatio = customTargetLeverageRatio || ether(2);
      const minLeverageRatio = customMinLeverageRatio || ether(1.7);
      const maxLeverageRatio = ether(2.3);
      const recenteringSpeed = ether(0.05);
      const rebalanceInterval = BigNumber.from(86400);

      const unutilizedLeveragePercentage = ether(0.01);
      const twapMaxTradeSize = ether(0.5);
      const twapCooldownPeriod = BigNumber.from(3000);
      const slippageTolerance = ether(0.01);

      const incentivizedTwapMaxTradeSize = ether(2);
      const incentivizedTwapCooldownPeriod = BigNumber.from(60);
      const incentivizedSlippageTolerance = ether(0.05);
      const etherReward = ether(1);
      const incentivizedLeverageRatio = ether(2.6);

      strategy = {
        setToken: setToken.address,
        leverageModule: aaveLeverageModule.address,
        aaveProtocolDataProvider: protocolDataProvider.address,
        collateralPriceOracle: chainlinkCollateralPriceMock.address,
        borrowPriceOracle: chainlinkBorrowPriceMock.address,
        targetCollateralAToken: customATokenCollateralAddress || aWeth.address,
        targetBorrowDebtToken: usdcVariableDebtToken.address,
        collateralAsset: weth.address,
        borrowAsset: usdc.address,
        collateralDecimalAdjustment: BigNumber.from(10),
        borrowDecimalAdjustment: BigNumber.from(22),
      };
      methodology = {
        targetLeverageRatio: targetLeverageRatio,
        minLeverageRatio: minLeverageRatio,
        maxLeverageRatio: maxLeverageRatio,
        recenteringSpeed: recenteringSpeed,
        rebalanceInterval: rebalanceInterval,
      };
      execution = {
        unutilizedLeveragePercentage: unutilizedLeveragePercentage,
        twapCooldownPeriod: twapCooldownPeriod,
        slippageTolerance: slippageTolerance,
      };
      incentive = {
        incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
        incentivizedSlippageTolerance: incentivizedSlippageTolerance,
        etherReward: etherReward,
        incentivizedLeverageRatio: incentivizedLeverageRatio,
      };
      const leverExchangeData = EMPTY_BYTES;
      const deleverExchangeData = EMPTY_BYTES;
      exchangeSettings = {
        twapMaxTradeSize: twapMaxTradeSize,
        incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
        exchangeLastTradeTimestamp: BigNumber.from(0),
        leverExchangeData,
        deleverExchangeData,
      };

      leverageStrategyExtension = await deployer.extensions.deployAaveV3LeverageStrategyExtension(
        baseManagerV2.address,
        strategy,
        methodology,
        execution,
        incentive,
        [exchangeName],
        [exchangeSettings],
      );

      // Add adapter
      await baseManagerV2.connect(owner.wallet).addAdapter(leverageStrategyExtension.address);
    };

    describe("#constructor", async () => {
      let subjectManagerAddress: Address;
      let subjectContractSettings: AaveContractSettings;
      let subjectMethodologySettings: MethodologySettings;
      let subjectExecutionSettings: ExecutionSettings;
      let subjectIncentiveSettings: IncentiveSettings;
      let subjectExchangeName: string;
      let subjectExchangeSettings: ExchangeSettings;

      cacheBeforeEach(initializeRootScopeContracts);

      beforeEach(async () => {
        subjectManagerAddress = baseManagerV2.address;
        subjectContractSettings = {
          setToken: setToken.address,
          leverageModule: aaveLeverageModule.address,
          aaveProtocolDataProvider: protocolDataProvider.address,
          collateralPriceOracle: chainlinkCollateralPriceMock.address,
          borrowPriceOracle: chainlinkBorrowPriceMock.address,
          targetCollateralAToken: customATokenCollateralAddress || aWeth.address,
          targetBorrowDebtToken: usdcVariableDebtToken.address,
          collateralAsset: weth.address,
          borrowAsset: usdc.address,
          collateralDecimalAdjustment: BigNumber.from(10),
          borrowDecimalAdjustment: BigNumber.from(22),
        };
        subjectMethodologySettings = {
          targetLeverageRatio: ether(2),
          minLeverageRatio: ether(1.7),
          maxLeverageRatio: ether(2.3),
          recenteringSpeed: ether(0.05),
          rebalanceInterval: BigNumber.from(86400),
        };
        subjectExecutionSettings = {
          unutilizedLeveragePercentage: ether(0.01),
          twapCooldownPeriod: BigNumber.from(120),
          slippageTolerance: ether(0.01),
        };
        subjectIncentiveSettings = {
          incentivizedTwapCooldownPeriod: BigNumber.from(60),
          incentivizedSlippageTolerance: ether(0.05),
          etherReward: ether(1),
          incentivizedLeverageRatio: ether(3.5),
        };
        subjectExchangeName = exchangeName;
        const leverExchangeData = EMPTY_BYTES;
        const deleverExchangeData = EMPTY_BYTES;
        subjectExchangeSettings = {
          twapMaxTradeSize: ether(0.1),
          incentivizedTwapMaxTradeSize: ether(1),
          exchangeLastTradeTimestamp: BigNumber.from(0),
          leverExchangeData,
          deleverExchangeData,
        };
      });

      async function subject(): Promise<AaveV3LeverageStrategyExtension> {
        return await deployer.extensions.deployAaveV3LeverageStrategyExtension(
          subjectManagerAddress,
          subjectContractSettings,
          subjectMethodologySettings,
          subjectExecutionSettings,
          subjectIncentiveSettings,
          [subjectExchangeName],
          [subjectExchangeSettings],
        );
      }

      it("should set the manager address", async () => {
        const retrievedAdapter = await subject();

        const manager = await retrievedAdapter.manager();

        expect(manager).to.eq(subjectManagerAddress);
      });

      it("should set the contract addresses", async () => {
        const retrievedAdapter = await subject();
        const strategy = await retrievedAdapter.getStrategy();

        expect(strategy.setToken).to.eq(subjectContractSettings.setToken);
        expect(strategy.leverageModule).to.eq(subjectContractSettings.leverageModule);
        expect(strategy.aaveProtocolDataProvider).to.eq(
          subjectContractSettings.aaveProtocolDataProvider,
        );
        expect(strategy.collateralPriceOracle).to.eq(subjectContractSettings.collateralPriceOracle);
        expect(strategy.borrowPriceOracle).to.eq(subjectContractSettings.borrowPriceOracle);
        expect(strategy.targetCollateralAToken).to.eq(
          subjectContractSettings.targetCollateralAToken,
        );
        expect(strategy.targetBorrowDebtToken).to.eq(subjectContractSettings.targetBorrowDebtToken);
        expect(strategy.collateralAsset).to.eq(subjectContractSettings.collateralAsset);
        expect(strategy.borrowAsset).to.eq(subjectContractSettings.borrowAsset);
      });

      it("should set the correct methodology parameters", async () => {
        const retrievedAdapter = await subject();
        const methodology = await retrievedAdapter.getMethodology();

        expect(methodology.targetLeverageRatio).to.eq(
          subjectMethodologySettings.targetLeverageRatio,
        );
        expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
        expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
        expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
        expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
      });

      it("should set the correct execution parameters", async () => {
        const retrievedAdapter = await subject();
        const execution = await retrievedAdapter.getExecution();

        expect(execution.unutilizedLeveragePercentage).to.eq(
          subjectExecutionSettings.unutilizedLeveragePercentage,
        );
        expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
        expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
      });

      it("should set the correct incentive parameters", async () => {
        const retrievedAdapter = await subject();
        const incentive = await retrievedAdapter.getIncentive();

        expect(incentive.incentivizedTwapCooldownPeriod).to.eq(
          subjectIncentiveSettings.incentivizedTwapCooldownPeriod,
        );
        expect(incentive.incentivizedSlippageTolerance).to.eq(
          subjectIncentiveSettings.incentivizedSlippageTolerance,
        );
        expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
        expect(incentive.incentivizedLeverageRatio).to.eq(
          subjectIncentiveSettings.incentivizedLeverageRatio,
        );
      });

      it("should set the correct exchange settings for the initial exchange", async () => {
        const retrievedAdapter = await subject();
        const exchangeSettings = await retrievedAdapter.getExchangeSettings(subjectExchangeName);

        expect(exchangeSettings.leverExchangeData).to.eq(subjectExchangeSettings.leverExchangeData);
        expect(exchangeSettings.deleverExchangeData).to.eq(
          subjectExchangeSettings.deleverExchangeData,
        );
        expect(exchangeSettings.twapMaxTradeSize).to.eq(subjectExchangeSettings.twapMaxTradeSize);
        expect(exchangeSettings.incentivizedTwapMaxTradeSize).to.eq(
          subjectExchangeSettings.incentivizedTwapMaxTradeSize,
        );
        expect(exchangeSettings.exchangeLastTradeTimestamp).to.eq(
          subjectExchangeSettings.exchangeLastTradeTimestamp,
        );
      });

      describe("when min leverage ratio is 0", async () => {
        beforeEach(async () => {
          subjectMethodologySettings.minLeverageRatio = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid min leverage");
        });
      });

      describe("when min leverage ratio is above target", async () => {
        beforeEach(async () => {
          subjectMethodologySettings.minLeverageRatio = ether(2.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid min leverage");
        });
      });

      describe("when max leverage ratio is below target", async () => {
        beforeEach(async () => {
          subjectMethodologySettings.maxLeverageRatio = ether(1.9);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid max leverage");
        });
      });

      describe("when recentering speed is >100%", async () => {
        beforeEach(async () => {
          subjectMethodologySettings.recenteringSpeed = ether(1.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
        });
      });

      describe("when recentering speed is 0%", async () => {
        beforeEach(async () => {
          subjectMethodologySettings.recenteringSpeed = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
        });
      });

      describe("when unutilizedLeveragePercentage is >100%", async () => {
        beforeEach(async () => {
          subjectExecutionSettings.unutilizedLeveragePercentage = ether(1.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
        });
      });

      describe("when slippage tolerance is >100%", async () => {
        beforeEach(async () => {
          subjectExecutionSettings.slippageTolerance = ether(1.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
        });
      });

      describe("when incentivized slippage tolerance is >100%", async () => {
        beforeEach(async () => {
          subjectIncentiveSettings.incentivizedSlippageTolerance = ether(1.1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "Incentivized slippage tolerance must be <100%",
          );
        });
      });

      describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
        beforeEach(async () => {
          subjectIncentiveSettings.incentivizedLeverageRatio = ether(2.29);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "Incentivized leverage ratio must be > max leverage ratio",
          );
        });
      });

      describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
        beforeEach(async () => {
          subjectMethodologySettings.rebalanceInterval = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "Rebalance interval must be greater than TWAP cooldown period",
          );
        });
      });

      describe("when TWAP cooldown period is shorter than incentivized TWAP cooldown period", async () => {
        beforeEach(async () => {
          subjectExecutionSettings.twapCooldownPeriod = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "TWAP cooldown must be greater than incentivized TWAP cooldown",
          );
        });
      });

      describe("when an exchange has a twapMaxTradeSize of 0", async () => {
        beforeEach(async () => {
          subjectExchangeSettings.twapMaxTradeSize = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
        });
      });
    });

    describe("#setEModeCategory", () => {
      let subjectCaller: Account;
      let subjectEModeCategory: number;
      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(() => {
        subjectCaller = owner;
      });
      async function subject() {
        return await leverageStrategyExtension
          .connect(subjectCaller.wallet)
          .setEModeCategory(subjectEModeCategory);
      }

      describe("When setting eModeCategory to ETH-Category from default", () => {
        beforeEach(() => {
          subjectEModeCategory = 1;
        });

        it("sets the EMode category for the set Token user correctly", async () => {
          await subject();
          const categoryId = await lendingPool.getUserEMode(setToken.address);
          expect(categoryId).to.eq(subjectEModeCategory);
        });

        describe("When the caller is not the operator", () => {
          beforeEach(() => {
            subjectCaller = methodologist;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });
      describe("When setting the category back to default", () => {
        beforeEach(async () => {
          await leverageStrategyExtension.connect(owner.wallet).setEModeCategory(1);
          subjectEModeCategory = 0;
        });

        it("sets the EMode category for the set Token user correctly", async () => {
          await subject();
          const categoryId = await lendingPool.getUserEMode(setToken.address);
          expect(categoryId).to.eq(subjectEModeCategory);
        });
      });
    });
    describe("#engage", async () => {
      let destinationTokenQuantity: BigNumber;
      let subjectCaller: Account;
      let subjectExchangeName: string;

      context(
        "when rebalance notional is greater than max trade size and greater than max borrow",
        async () => {
          let issueQuantity: BigNumber;

          const intializeContracts = async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await aWeth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            destinationTokenQuantity = ether(0.5);
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          };

          const initializeSubjectVariables = () => {
            subjectCaller = owner;
            subjectExchangeName = exchangeName;
          };

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.engage(subjectExchangeName);
          }

          describe("when the collateral balance is not zero", () => {
            cacheBeforeEach(intializeContracts);
            beforeEach(initializeSubjectVariables);

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should set the exchange's last trade timestamp", async () => {
              await subject();

              const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
                subjectExchangeName,
              );
              const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should set the TWAP leverage ratio", async () => {
              await subject();

              const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

              expect(twapLeverageRatio).to.eq(methodology.targetLeverageRatio);
            });

            it("should update the collateral position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // aWeth position is increased
              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];

              // Get expected aTokens position size
              const expectedFirstPositionUnit = initialPositions[0].unit.add(
                destinationTokenQuantity,
              );

              expect(initialPositions.length).to.eq(1);
              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(aWeth.address);
              expect(newFirstPosition.positionState).to.eq(0); // Default
              expect(newFirstPosition.unit).to.be.gte(expectedFirstPositionUnit.mul(999).div(1000));
              expect(newFirstPosition.unit).to.be.lte(
                expectedFirstPositionUnit.mul(1001).div(1000),
              );
              expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
            });

            it("should update the borrow position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // aWeth position is increased
              const currentPositions = await setToken.getPositions();
              const newSecondPosition = (await setToken.getPositions())[1];

              const expectedSecondPositionUnit = (
                await usdcVariableDebtToken.balanceOf(setToken.address)
              ).mul(-1);

              expect(initialPositions.length).to.eq(1);
              expect(currentPositions.length).to.eq(2);
              expect(newSecondPosition.component).to.eq(usdc.address);
              expect(newSecondPosition.positionState).to.eq(1); // External
              expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
              expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
            });

            it("should emit Engaged event", async () => {
              await expect(subject()).to.emit(leverageStrategyExtension, "Engaged");
            });

            describe("when borrow balance is not 0", async () => {
              beforeEach(async () => {
                await subject();
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Debt must be 0");
              });
            });

            describe("when SetToken has 0 supply", async () => {
              beforeEach(async () => {
                await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
              });
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

          describe("when collateral balance is zero", async () => {
            beforeEach(async () => {
              // Set collateral asset to cUSDC with 0 balance
              customATokenCollateralAddress = aUsdc.address;
              await intializeContracts();
              initializeSubjectVariables();
            });

            afterEach(async () => {
              customATokenCollateralAddress = undefined;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
            });
          });
        },
      );

      context(
        "when rebalance notional is less than max trade size and greater than max borrow",
        async () => {
          cacheBeforeEach(async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await aWeth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(1.9),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.leverExchangeData,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            // Traded amount is equal to account liquidity * buffer percentage
            destinationTokenQuantity = ether(0.8 * 0.99);
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          beforeEach(() => {
            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.engage(subjectExchangeName);
          }

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(methodology.targetLeverageRatio);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aToken position unit
            const expectedFirstPositionUnit = initialPositions[0].unit.add(
              destinationTokenQuantity,
            );

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        },
      );

      context(
        "when rebalance notional is less than max trade size and less than max borrow",
        async () => {
          before(async () => {
            customTargetLeverageRatio = ether(1.25); // Change to 1.25x
            customMinLeverageRatio = ether(1.1);
          });

          after(async () => {
            customTargetLeverageRatio = undefined;
            customMinLeverageRatio = undefined;
          });

          cacheBeforeEach(async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await aWeth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
            destinationTokenQuantity = ether(0.25);
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          beforeEach(() => {
            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.engage(subjectExchangeName);
          }

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aWeth position units
            const expectedFirstPositionUnit = customTargetLeverageRatio;

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        },
      );
    });

    describe("#rebalance", async () => {
      let destinationTokenQuantity: BigNumber;
      let subjectCaller: Account;
      let subjectExchangeName: string;
      let ifEngaged: boolean;

      before(async () => {
        ifEngaged = true;
        subjectExchangeName = exchangeName;
      });

      const intializeContracts = async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        if (ifEngaged) {
          // Engage to initial leverage
          await leverageStrategyExtension.engage(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100000));
          await weth.transfer(tradeAdapterMock.address, ether(0.5));
          await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
        }
      };

      cacheBeforeEach(intializeContracts);

      context("when current leverage ratio is below target (lever)", async () => {
        cacheBeforeEach(async () => {
          destinationTokenQuantity = ether(0.1);
          await increaseTimeAsync(BigNumber.from(100000));
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
          await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        beforeEach(() => {
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .rebalance(subjectExchangeName);
        }

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
            subjectExchangeName,
          );
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // aWeth position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected aTokens position units;
          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(aWeth.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // aWeth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (
            await usdcVariableDebtToken.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });

        it("should emit Rebalanced event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "Rebalanced");
        });

        describe("when rebalance interval has not elapsed but is below min leverage ratio and lower than max trade size", async () => {
          cacheBeforeEach(async () => {
            await subject();
            // ~1.6x leverage
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1300).mul(10 ** 8));
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(1.9),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.deleverExchangeData,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            destinationTokenQuantity = ether(1);
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aToken position unit
            const expectedFirstPositionUnit = initialPositions[0].unit.add(
              destinationTokenQuantity,
            );

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when rebalance interval has not elapsed below min leverage ratio and greater than max trade size", async () => {
          cacheBeforeEach(async () => {
            await subject();

            // > Max trade size
            destinationTokenQuantity = ether(0.5);
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(0.01),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.deleverExchangeData,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1500).mul(10 ** 8));
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatio(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            expect(previousTwapLeverageRatio).to.eq(ZERO);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            await subject();
            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aToken position units
            const expectedFirstPositionUnit = initialPositions[0].unit.add(ether(0.5));

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when rebalance interval has not elapsed", async () => {
          beforeEach(async () => {
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Cooldown not elapsed or not valid leverage ratio",
            );
          });
        });

        describe("when in a TWAP rebalance", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(BigNumber.from(100000));
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(0.01),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.deleverExchangeData,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            await weth.transfer(tradeAdapterMock.address, ether(0.01));
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must call iterate");
          });
        });

        describe("when borrow balance is 0", async () => {
          beforeEach(async () => {
            // Repay entire borrow balance of USDC on behalf of SetToken
            await usdc.approve(lendingPool.address, MAX_UINT_256);
            await lendingPool.repay(
              usdc.address,
              await usdcVariableDebtToken.balanceOf(setToken.address),
              2,
              setToken.address,
            );
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("STH");
          });
        });

        describe("when caller is not an allowed trader", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });

        describe("when caller is a contract", async () => {
          let subjectTarget: Address;
          let subjectCallData: string;
          let subjectValue: BigNumber;

          let contractCaller: ContractCallerMock;

          beforeEach(async () => {
            contractCaller = await deployer.setV2.deployContractCallerMock();

            subjectTarget = leverageStrategyExtension.address;
            subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("rebalance", [
              subjectExchangeName,
            ]);
            subjectValue = ZERO;
          });

          async function subjectContractCaller(): Promise<any> {
            return await contractCaller.invoke(subjectTarget, subjectValue, subjectCallData);
          }

          it("the trade reverts", async () => {
            await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
          });
        });

        describe("when SetToken has 0 supply", async () => {
          beforeEach(async () => {
            await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
            await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
          });
        });
      });

      context("when current leverage ratio is above target (delever)", async () => {
        cacheBeforeEach(async () => {
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));
          // Set to $990 so need to delever
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));
        });

        beforeEach(() => {
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .rebalance(subjectExchangeName);
        }

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
            subjectExchangeName,
          );
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          const previousATokenBalance = await aWeth.balanceOf(setToken.address);

          await subject();

          // aWeth position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed,
          );
          // Get expected redeemed
          const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
            currentLeverageRatio,
            expectedNewLeverageRatio,
            previousATokenBalance,
            ether(1), // Total supply
          );

          const expectedFirstPositionUnit = initialPositions[0].unit.sub(
            expectedCollateralAssetsRedeemed,
          );

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(aWeth.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // aWeth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (
            await usdcVariableDebtToken.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });

        describe("when rebalance interval has not elapsed above max leverage ratio and lower than max trade size", async () => {
          cacheBeforeEach(async () => {
            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
            // ~2.4x leverage
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(1.9),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.deleverExchangeData,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            await usdc.transfer(tradeAdapterMock.address, BigNumber.from(100000000));
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should not set the TWAP leverage ratio", async () => {
            await subject();

            const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            expect(twapLeverageRatio).to.eq(ZERO);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const previousATokenBalance = await aWeth.balanceOf(setToken.address);

            await subject();

            // aWeth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            const expectedNewLeverageRatio = calculateNewLeverageRatio(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            // Get expected redeemed
            const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
              currentLeverageRatio,
              expectedNewLeverageRatio,
              previousATokenBalance,
              ether(1), // Total supply
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(
              expectedCollateralAssetsRedeemed,
            );

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when rebalance interval has not elapsed above max leverage ratio and greater than max trade size", async () => {
          let newTWAPMaxTradeSize: BigNumber;

          cacheBeforeEach(async () => {
            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

            // > Max trade size
            newTWAPMaxTradeSize = ether(0.01);
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: newTWAPMaxTradeSize,
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.deleverExchangeData,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            // ~2.4x leverage
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
            await usdc.transfer(tradeAdapterMock.address, BigNumber.from(10000000));
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatio(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            expect(previousTwapLeverageRatio).to.eq(ZERO);
            expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Max TWAP collateral units
            const expectedFirstPositionUnit = initialPositions[0].unit.sub(newTWAPMaxTradeSize);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        context("when using two exchanges", async () => {
          let subjectExchangeToUse: string;

          cacheBeforeEach(async () => {
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(2),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: exchangeSettings.leverExchangeData,
              deleverExchangeData: exchangeSettings.deleverExchangeData,
            };

            await leverageStrategyExtension.updateEnabledExchange(
              exchangeName,
              newExchangeSettings,
            );
            await leverageStrategyExtension.addEnabledExchange(exchangeName2, newExchangeSettings);

            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
            await usdc.transfer(tradeAdapterMock.address, BigNumber.from(100).mul(10 ** 6));
            await usdc.transfer(tradeAdapterMock2.address, BigNumber.from(100).mul(10 ** 6));
          });

          beforeEach(() => {
            subjectCaller = owner;
            subjectExchangeToUse = exchangeName;
          });

          async function subject(): Promise<any> {
            return leverageStrategyExtension
              .connect(subjectCaller.wallet)
              .rebalance(subjectExchangeToUse);
          }

          describe("when leverage ratio is above max and it drops further between rebalances", async () => {
            it("should set the global and exchange timestamps correctly", async () => {
              await subject();
              const timestamp1 = await getLastBlockTimestamp();

              subjectExchangeToUse = exchangeName2;
              await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));

              await subject();
              const timestamp2 = await getLastBlockTimestamp();

              expect(await leverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
              expect(
                (await leverageStrategyExtension.getExchangeSettings(exchangeName))
                  .exchangeLastTradeTimestamp,
              ).to.eq(timestamp1);
              expect(
                (await leverageStrategyExtension.getExchangeSettings(exchangeName2))
                  .exchangeLastTradeTimestamp,
              ).to.eq(timestamp2);
            });
          });

          describe("when performing the epoch rebalance and rebalance is called twice with different exchanges", async () => {
            beforeEach(async () => {
              await increaseTimeAsync(BigNumber.from(100000));
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "Cooldown not elapsed or not valid leverage ratio",
              );
            });
          });

          describe("when leverage ratio is above max and rebalance is called twice with different exchanges", async () => {
            beforeEach(async () => {
              await increaseTimeAsync(BigNumber.from(100000));
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "Cooldown not elapsed or not valid leverage ratio",
              );
            });
          });
        });

        describe("when above incentivized leverage ratio threshold", async () => {
          beforeEach(async () => {
            await subject();

            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
          });
        });

        describe("when using an exchange that has not been added", async () => {
          beforeEach(async () => {
            subjectExchangeName = "NonExistentExchange";
          });

          it("should revert", async () => {
            await expect(subject()).to.revertedWith("Must be valid exchange");
          });
        });
      });

      context("when not engaged", async () => {
        async function subject(): Promise<any> {
          return leverageStrategyExtension.rebalance(subjectExchangeName);
        }

        describe("when collateral balance is zero", async () => {
          beforeEach(async () => {
            subjectExchangeName = exchangeName;
            // Set collateral asset to aUSDC with 0 balance
            customATokenCollateralAddress = aUsdc.address;
            ifEngaged = false;
            await intializeContracts();
          });

          after(async () => {
            customATokenCollateralAddress = undefined;
            ifEngaged = true;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
          });
        });
      });
    });

    describe("#iterateRebalance", async () => {
      let destinationTokenQuantity: BigNumber;
      let subjectCaller: Account;
      let subjectExchangeName: string;
      let ifEngaged: boolean;
      let issueQuantity: BigNumber;

      before(async () => {
        ifEngaged = true;
        subjectExchangeName = exchangeName;
      });

      const intializeContracts = async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        if (ifEngaged) {
          // Engage to initial leverage
          await leverageStrategyExtension.engage(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100000));
          await weth.transfer(tradeAdapterMock.address, ether(0.5));
          await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
        }
      };

      cacheBeforeEach(intializeContracts);

      context("when currently in the last chunk of a TWAP rebalance", async () => {
        cacheBeforeEach(async () => {
          await increaseTimeAsync(BigNumber.from(100000));
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

          destinationTokenQuantity = ether(0.01);
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: destinationTokenQuantity,
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await leverageStrategyExtension.updateEnabledExchange(
            subjectExchangeName,
            newExchangeSettings,
          );
          await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

          await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

          await increaseTimeAsync(BigNumber.from(4000));
          await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        beforeEach(() => {
          subjectCaller = owner;
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .iterateRebalance(subjectExchangeName);
        }

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
            subjectExchangeName,
          );
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should remove the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          await subject();
          // aWeth position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected aTokens minted
          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(aWeth.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // aWeth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (
            await usdcVariableDebtToken.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.lt(expectedSecondPositionUnit.mul(999).div(1000));
          expect(newSecondPosition.unit).to.gt(expectedSecondPositionUnit.mul(1001).div(1000));
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });
      });

      context(
        "when current leverage ratio is above target and middle of a TWAP rebalance",
        async () => {
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(BigNumber.from(100000));
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

            destinationTokenQuantity = ether(0.0001);
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: destinationTokenQuantity,
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: EMPTY_BYTES,
              deleverExchangeData: EMPTY_BYTES,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            // Initialize TWAP
            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
            await increaseTimeAsync(BigNumber.from(4000));
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          beforeEach(() => {
            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            return leverageStrategyExtension
              .connect(subjectCaller.wallet)
              .iterateRebalance(subjectExchangeName);
          }

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              subjectExchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the TWAP leverage ratio", async () => {
            const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            await subject();

            const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

            const expectedNewLeverageRatio = calculateNewLeverageRatio(
              preTwapLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            expect(previousTwapLeverageRatio).to.gt(expectedNewLeverageRatio.mul(999).div(1000));
            expect(previousTwapLeverageRatio).to.lt(expectedNewLeverageRatio.mul(1001).div(1000));
            expect(currentTwapLeverageRatio).to.gt(expectedNewLeverageRatio.mul(999).div(1000));
            expect(currentTwapLeverageRatio).to.lt(expectedNewLeverageRatio.mul(1001).div(1000));
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            await subject();
            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aTokens minted
            const expectedFirstPositionUnit = initialPositions[0].unit.add(
              destinationTokenQuantity,
            );

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.lt(expectedSecondPositionUnit.mul(999).div(1000));
            expect(newSecondPosition.unit).to.gt(expectedSecondPositionUnit.mul(1001).div(1000));
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });

          it("should emit RebalanceIterated event", async () => {
            await expect(subject()).to.emit(leverageStrategyExtension, "RebalanceIterated");
          });

          describe("when price has moved advantageously towards target leverage ratio", async () => {
            beforeEach(async () => {
              await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should set the exchange's last trade timestamp", async () => {
              await subject();

              const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
                subjectExchangeName,
              );
              const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should remove the TWAP leverage ratio", async () => {
              const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

              await subject();

              const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

              const expectedNewLeverageRatio = calculateNewLeverageRatio(
                preTwapLeverageRatio,
                methodology.targetLeverageRatio,
                methodology.minLeverageRatio,
                methodology.maxLeverageRatio,
                methodology.recenteringSpeed,
              );
              expect(previousTwapLeverageRatio).to.gt(expectedNewLeverageRatio.mul(999).div(1000));
              expect(previousTwapLeverageRatio).to.lt(expectedNewLeverageRatio.mul(1001).div(1000));
              expect(currentTwapLeverageRatio).to.eq(ZERO);
            });

            it("should not update the positions on the SetToken", async () => {
              const initialPositions = await setToken.getPositions();
              await subject();
              const currentPositions = await setToken.getPositions();

              expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
              expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
            });
          });

          describe("when above incentivized leverage ratio threshold", async () => {
            beforeEach(async () => {
              await subject();

              await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "Must be below incentivized leverage ratio",
              );
            });
          });

          describe("when cooldown has not elapsed", async () => {
            beforeEach(async () => {
              await subject();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "Cooldown not elapsed or not valid leverage ratio",
              );
            });
          });

          describe("when borrow balance is 0", async () => {
            beforeEach(async () => {
              // Repay entire balance of USDC on behalf of SetToken
              await usdc.approve(lendingPool.address, MAX_UINT_256);
              await lendingPool.repay(
                usdc.address,
                await usdcVariableDebtToken.balanceOf(setToken.address),
                2,
                setToken.address,
              );

              const debtBalanceAfter = await usdcVariableDebtToken.balanceOf(setToken.address);
              if (debtBalanceAfter.gt(ZERO)) {
                await lendingPool.repay(usdc.address, debtBalanceAfter, 2, setToken.address);
              }
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Borrow balance must exist");
            });
          });

          describe("when caller is not an allowed trader", async () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Address not permitted to call");
            });
          });

          describe("when caller is a contract", async () => {
            let subjectTarget: Address;
            let subjectCallData: string;
            let subjectValue: BigNumber;

            let contractCaller: ContractCallerMock;

            beforeEach(async () => {
              contractCaller = await deployer.setV2.deployContractCallerMock();

              subjectTarget = leverageStrategyExtension.address;
              subjectCallData = leverageStrategyExtension.interface.encodeFunctionData(
                "iterateRebalance",
                [subjectExchangeName],
              );
              subjectValue = ZERO;
            });

            async function subjectContractCaller(): Promise<any> {
              return await contractCaller.invoke(subjectTarget, subjectValue, subjectCallData);
            }

            it("the trade reverts", async () => {
              await expect(subjectContractCaller()).to.be.revertedWith(
                "Caller must be EOA Address",
              );
            });
          });

          describe("when SetToken has 0 supply", async () => {
            beforeEach(async () => {
              await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
              await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
            });
          });

          describe("when using an exchange that has not been added", async () => {
            beforeEach(async () => {
              subjectExchangeName = "NonExistentExchange";
            });

            it("should revert", async () => {
              await expect(subject()).to.revertedWith("Must be valid exchange");
            });
          });
        },
      );

      context(
        "when current leverage ratio is below target and middle of a TWAP rebalance",
        async () => {
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(BigNumber.from(10000000));
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));

            destinationTokenQuantity = ether(0.0001);
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: destinationTokenQuantity,
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: EMPTY_BYTES,
              deleverExchangeData: EMPTY_BYTES,
            };
            subjectExchangeName = exchangeName;
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
            await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
            await increaseTimeAsync(BigNumber.from(4000));
            await usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));
          });

          beforeEach(() => {
            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            return leverageStrategyExtension
              .connect(subjectCaller.wallet)
              .iterateRebalance(subjectExchangeName);
          }

          describe("when price has moved advantageously towards target leverage ratio", async () => {
            beforeEach(async () => {
              await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should set the exchange's last trade timestamp", async () => {
              await subject();

              const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
                subjectExchangeName,
              );
              const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should remove the TWAP leverage ratio", async () => {
              const previousTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

              await subject();

              const currentTwapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

              const expectedNewLeverageRatio = calculateNewLeverageRatio(
                preTwapLeverageRatio,
                methodology.targetLeverageRatio,
                methodology.minLeverageRatio,
                methodology.maxLeverageRatio,
                methodology.recenteringSpeed,
              );
              expect(previousTwapLeverageRatio).to.lt(expectedNewLeverageRatio.mul(1001).div(1000));
              expect(previousTwapLeverageRatio).to.gt(expectedNewLeverageRatio.mul(999).div(1000));
              expect(currentTwapLeverageRatio).to.eq(ZERO);
            });

            it("should not update the positions on the SetToken", async () => {
              const initialPositions = await setToken.getPositions();
              await subject();
              const currentPositions = await setToken.getPositions();

              expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
              expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
            });
          });
        },
      );

      context("when using two exchanges", async () => {
        let subjectExchangeToUse: string;

        cacheBeforeEach(async () => {
          await increaseTimeAsync(BigNumber.from(100000));
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

          destinationTokenQuantity = ether(0.0001);
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: destinationTokenQuantity,
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await leverageStrategyExtension.updateEnabledExchange(
            subjectExchangeName,
            newExchangeSettings,
          );
          await leverageStrategyExtension.addEnabledExchange(exchangeName2, newExchangeSettings);
          await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

          // Initialize TWAP
          await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(4000));
          await weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          await weth.transfer(tradeAdapterMock2.address, destinationTokenQuantity);
        });

        beforeEach(() => {
          subjectCaller = owner;
          subjectExchangeToUse = exchangeName;
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .iterateRebalance(subjectExchangeToUse);
        }

        describe("when in a twap rebalance and under target leverage ratio", async () => {
          it("should set the global and exchange timestamps correctly", async () => {
            await subject();
            const timestamp1 = await getLastBlockTimestamp();

            subjectExchangeToUse = exchangeName2;
            await subject();
            const timestamp2 = await getLastBlockTimestamp();

            expect(await leverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
            expect(
              (await leverageStrategyExtension.getExchangeSettings(exchangeName))
                .exchangeLastTradeTimestamp,
            ).to.eq(timestamp1);
            expect(
              (await leverageStrategyExtension.getExchangeSettings(exchangeName2))
                .exchangeLastTradeTimestamp,
            ).to.eq(timestamp2);
          });
        });
      });

      context("when not in TWAP state", async () => {
        async function subject(): Promise<any> {
          return leverageStrategyExtension.iterateRebalance(subjectExchangeName);
        }

        describe("when collateral balance is zero", async () => {
          beforeEach(async () => {
            await increaseTimeAsync(BigNumber.from(100000));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Not in TWAP state");
          });
        });
      });

      context("when not engaged", async () => {
        async function subject(): Promise<any> {
          return leverageStrategyExtension.iterateRebalance(subjectExchangeName);
        }

        describe("when collateral balance is zero", async () => {
          beforeEach(async () => {
            // Set collateral asset to cUSDC with 0 balance
            customATokenCollateralAddress = aUsdc.address;
            ifEngaged = false;
            await intializeContracts();
            subjectCaller = owner;
          });

          after(async () => {
            customATokenCollateralAddress = undefined;
            ifEngaged = true;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
          });
        });
      });
    });

    describe("#ripcord", async () => {
      let transferredEth: BigNumber;
      let subjectCaller: Account;
      let subjectExchangeName: string;
      let ifEngaged: boolean;

      before(async () => {
        ifEngaged = true;
        subjectExchangeName = exchangeName;
      });

      const intializeContracts = async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        if (ifEngaged) {
          // Engage to initial leverage
          await leverageStrategyExtension.engage(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100000));
          await weth.transfer(tradeAdapterMock.address, ether(0.5));
          await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
        }
      };

      const initializeSubjectVariables = () => {
        subjectCaller = owner;
      };

      cacheBeforeEach(intializeContracts);
      beforeEach(initializeSubjectVariables);

      // increaseTime
      context("when not in a TWAP rebalance", async () => {
        cacheBeforeEach(async () => {
          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));

          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(450000000));

          transferredEth = ether(1);
          await owner.wallet.sendTransaction({
            to: leverageStrategyExtension.address,
            value: transferredEth,
          });
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .ripcord(subjectExchangeName);
        }

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
            exchangeName,
          );
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          const previousATokenBalance = await aWeth.balanceOf(setToken.address);

          await subject();

          // aWeth position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed,
          );
          // Get expected USDC redeemed
          const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
            currentLeverageRatio,
            expectedNewLeverageRatio,
            previousATokenBalance,
            ether(1), // Total supply
          );

          const expectedFirstPositionUnit = initialPositions[0].unit.sub(
            expectedCollateralAssetsRedeemed,
          );

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(aWeth.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // aWeth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (
            await usdcVariableDebtToken.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });

        it("should transfer incentive", async () => {
          const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const previousOwnerEthBalance = await getEthBalance(owner.address);

          const txHash = await subject();
          const txReceipt = await provider.getTransactionReceipt(txHash.hash);
          const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const currentOwnerEthBalance = await getEthBalance(owner.address);
          const expectedOwnerEthBalance = previousOwnerEthBalance
            .add(incentive.etherReward)
            .sub(txReceipt.gasUsed.mul(txHash.gasPrice));

          expect(previousContractEthBalance).to.eq(transferredEth);
          expect(currentContractEthBalance).to.eq(transferredEth.sub(incentive.etherReward));
          expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
        });

        it("should emit RipcordCalled event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "RipcordCalled");
        });

        describe("when greater than incentivized max trade size", async () => {
          let newIncentivizedMaxTradeSize: BigNumber;

          cacheBeforeEach(async () => {
            newIncentivizedMaxTradeSize = ether(0.01);
            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(0.001),
              incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: EMPTY_BYTES,
              deleverExchangeData: EMPTY_BYTES,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              exchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Max TWAP collateral units
            const expectedFirstPositionUnit = initialPositions[0].unit.sub(
              newIncentivizedMaxTradeSize,
            );

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });

          describe("when incentivized cooldown period has not elapsed", async () => {
            beforeEach(async () => {
              await subject();
              await chainlinkCollateralPriceMock.setPrice(BigNumber.from(400).mul(10 ** 8));
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("TWAP cooldown must have elapsed");
            });
          });
        });

        describe("when greater than max borrow", async () => {
          beforeEach(async () => {
            // Set to above max borrow
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
              exchangeName,
            );
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            // Get max borrow
            const previousCollateralBalance = await aWeth.balanceOf(setToken.address);

            const previousBorrowBalance = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(BigNumber.from(10).pow(12));

            const collateralPrice = ether(650);
            const borrowPrice = ether(1);
            const reserveConfig = await protocolDataProvider.getReserveConfigurationData(
              weth.address,
            );
            const collateralFactor = reserveConfig.liquidationThreshold.mul(
              BigNumber.from(10).pow(14),
            );

            await subject();

            // aWeth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            const maxRedeemCollateral = calculateMaxBorrowForDelever(
              previousCollateralBalance,
              collateralFactor,
              execution.unutilizedLeveragePercentage,
              collateralPrice,
              borrowPrice,
              previousBorrowBalance,
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCollateral);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when below incentivized leverage ratio threshold", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(2000).mul(10 ** 8));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be above incentivized leverage ratio");
          });
        });

        describe("when borrow balance is 0", async () => {
          beforeEach(async () => {
            // Repay entire balance of USDC on behalf of SetToken
            await usdc.approve(lendingPool.address, MAX_UINT_256);
            await lendingPool.repay(
              usdc.address,
              await usdcVariableDebtToken.balanceOf(setToken.address),
              2,
              setToken.address,
            );
            const debtBalanceAfter = await usdcVariableDebtToken.balanceOf(setToken.address);
            if (debtBalanceAfter.gt(0)) {
              await lendingPool.repay(usdc.address, debtBalanceAfter, 2, setToken.address);
            }
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Borrow balance must exist");
          });
        });

        describe("when caller is a contract", async () => {
          let subjectTarget: Address;
          let subjectCallData: string;
          let subjectValue: BigNumber;

          let contractCaller: ContractCallerMock;

          beforeEach(async () => {
            contractCaller = await deployer.setV2.deployContractCallerMock();

            subjectTarget = leverageStrategyExtension.address;
            subjectCallData = leverageStrategyExtension.interface.encodeFunctionData("ripcord", [
              subjectExchangeName,
            ]);
            subjectValue = ZERO;
          });

          async function subjectContractCaller(): Promise<any> {
            return await contractCaller.invoke(subjectTarget, subjectValue, subjectCallData);
          }

          it("the trade reverts", async () => {
            await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
          });
        });

        describe("when SetToken has 0 supply", async () => {
          beforeEach(async () => {
            await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
            await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
          });
        });

        describe("when using an exchange that has not been added", async () => {
          beforeEach(async () => {
            subjectExchangeName = "NonExistentExchange";
          });

          it("should revert", async () => {
            await expect(subject()).to.revertedWith("Must be valid exchange");
          });
        });
      });

      context("when in the midst of a TWAP rebalance", async () => {
        let newIncentivizedMaxTradeSize: BigNumber;

        cacheBeforeEach(async () => {
          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));
          transferredEth = ether(1);
          await owner.wallet.sendTransaction({
            to: leverageStrategyExtension.address,
            value: transferredEth,
          });

          // > Max trade size
          newIncentivizedMaxTradeSize = ether(0.001);
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.001),
            incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          subjectExchangeName = exchangeName;
          await leverageStrategyExtension.updateEnabledExchange(
            subjectExchangeName,
            newExchangeSettings,
          );

          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));

          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

          // Start TWAP rebalance
          await leverageStrategyExtension.rebalance(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100));
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .ripcord(subjectExchangeName);
        }

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await leverageStrategyExtension.getExchangeSettings(
            exchangeName,
          );
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio to 0", async () => {
          await subject();

          const twapLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });
      });

      context("when using two exchanges", async () => {
        let subjectExchangeToUse: string;

        cacheBeforeEach(async () => {
          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));

          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(300000000));
          await usdc.transfer(tradeAdapterMock2.address, BigNumber.from(300000000));

          await leverageStrategyExtension.updateEnabledExchange(exchangeName, exchangeSettings);
          await leverageStrategyExtension.addEnabledExchange(exchangeName2, exchangeSettings);
          await increaseTimeAsync(BigNumber.from(100000));
        });

        beforeEach(() => {
          subjectCaller = owner;
          subjectExchangeToUse = exchangeName;
        });

        async function subject(): Promise<any> {
          return leverageStrategyExtension
            .connect(subjectCaller.wallet)
            .ripcord(subjectExchangeToUse);
        }

        describe("when leverage ratio is above max and it drops further between ripcords", async () => {
          it("should set the global and exchange timestamps correctly", async () => {
            await subject();
            const timestamp1 = await getLastBlockTimestamp();

            subjectExchangeToUse = exchangeName2;
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(600).mul(10 ** 8));

            await subject();
            const timestamp2 = await getLastBlockTimestamp();

            expect(await leverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
            expect(
              (await leverageStrategyExtension.getExchangeSettings(exchangeName))
                .exchangeLastTradeTimestamp,
            ).to.eq(timestamp1);
            expect(
              (await leverageStrategyExtension.getExchangeSettings(exchangeName2))
                .exchangeLastTradeTimestamp,
            ).to.eq(timestamp2);
          });
        });
      });

      context("when not engaged", async () => {
        async function subject(): Promise<any> {
          return leverageStrategyExtension.ripcord(subjectExchangeName);
        }

        describe("when collateral balance is zero", async () => {
          beforeEach(async () => {
            // Set collateral asset to aUSDC with 0 balance
            customATokenCollateralAddress = aUsdc.address;
            ifEngaged = false;

            await intializeContracts();
            initializeSubjectVariables();
          });

          after(async () => {
            customATokenCollateralAddress = undefined;
            ifEngaged = true;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
          });
        });
      });
    });

    describe("#disengage", async () => {
      let subjectCaller: Account;
      let subjectExchangeName: string;
      let ifEngaged: boolean;

      context(
        "when notional is greater than max trade size and total rebalance notional is greater than max borrow",
        async () => {
          before(async () => {
            ifEngaged = true;
            subjectExchangeName = exchangeName;
          });

          const intializeContracts = async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await aWeth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            await weth.transfer(tradeAdapterMock.address, ether(0.5));

            if (ifEngaged) {
              // Add allowed trader
              await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
              // Engage to initial leverage
              await leverageStrategyExtension.engage(subjectExchangeName);
              await increaseTimeAsync(BigNumber.from(100000));
              await weth.transfer(tradeAdapterMock.address, ether(0.5));
              await leverageStrategyExtension.iterateRebalance(subjectExchangeName);

              // Withdraw balance of USDC from exchange contract from engage
              await tradeAdapterMock.withdraw(usdc.address);
              await usdc.transfer(tradeAdapterMock.address, BigNumber.from(550000000));
            }
          };

          const initializeSubjectVariables = () => {
            subjectCaller = owner;
          };

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.disengage(subjectExchangeName);
          }

          describe("when engaged", () => {
            cacheBeforeEach(intializeContracts);
            beforeEach(initializeSubjectVariables);

            it("should update the collateral position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // aWeth position is decreased
              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];

              // Max TWAP collateral units
              const expectedFirstPositionUnit = initialPositions[0].unit.sub(
                exchangeSettings.twapMaxTradeSize,
              );

              expect(initialPositions.length).to.eq(2);
              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(aWeth.address);
              expect(newFirstPosition.positionState).to.eq(0); // Default
              expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
              expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
              expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
            });

            it("should update the borrow position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // aWeth position is increased
              const currentPositions = await setToken.getPositions();
              const newSecondPosition = (await setToken.getPositions())[1];

              const expectedSecondPositionUnit = (
                await usdcVariableDebtToken.balanceOf(setToken.address)
              ).mul(-1);

              expect(initialPositions.length).to.eq(2);
              expect(currentPositions.length).to.eq(2);
              expect(newSecondPosition.component).to.eq(usdc.address);
              expect(newSecondPosition.positionState).to.eq(1); // External
              expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
              expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
            });

            describe("when borrow balance is 0", async () => {
              beforeEach(async () => {
                // Repay entire balance of cUSDC on behalf of SetToken
                await usdc.approve(lendingPool.address, MAX_UINT_256);
                await lendingPool.repay(
                  usdc.address,
                  await usdcVariableDebtToken.balanceOf(setToken.address),
                  2,
                  setToken.address,
                );
                const debtTokenBalance = await usdcVariableDebtToken.balanceOf(setToken.address);
                if (debtTokenBalance.gt(0)) {
                  await lendingPool.repay(usdc.address, debtTokenBalance, 2, setToken.address);
                }
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Borrow balance must exist");
              });
            });

            describe("when SetToken has 0 supply", async () => {
              beforeEach(async () => {
                await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
                await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
              });
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

          describe("when not engaged", () => {
            describe("when collateral balance is zero", async () => {
              beforeEach(async () => {
                // Set collateral asset to cUSDC with 0 balance
                customATokenCollateralAddress = aUsdc.address;
                ifEngaged = false;

                await intializeContracts();
                initializeSubjectVariables();
              });

              after(async () => {
                customATokenCollateralAddress = undefined;
                ifEngaged = true;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
              });
            });
          });
        },
      );

      context(
        "when notional is less than max trade size and total rebalance notional is greater than max borrow",
        async () => {
          cacheBeforeEach(async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await aWeth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            await weth.transfer(tradeAdapterMock.address, ether(0.5));

            // Engage to initial leverage
            await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
            await leverageStrategyExtension.engage(subjectExchangeName);
            await increaseTimeAsync(BigNumber.from(4000));
            await weth.transfer(tradeAdapterMock.address, ether(0.5));
            await leverageStrategyExtension.iterateRebalance(subjectExchangeName);

            // Clear balance of USDC from exchange contract from engage
            await tradeAdapterMock.withdraw(usdc.address);
            await usdc.transfer(tradeAdapterMock.address, BigNumber.from(800000000));

            const newExchangeSettings: ExchangeSettings = {
              twapMaxTradeSize: ether(1.9),
              incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
              exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
              leverExchangeData: EMPTY_BYTES,
              deleverExchangeData: EMPTY_BYTES,
            };
            await leverageStrategyExtension.updateEnabledExchange(
              subjectExchangeName,
              newExchangeSettings,
            );

            // Set price to reduce borrowing power
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));

            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.disengage(subjectExchangeName);
          }

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            // Get max borrow
            const previousCollateralBalance = await aWeth.balanceOf(setToken.address);

            const previousBorrowBalance = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(BigNumber.from(10).pow(12));

            const collateralPrice = ether(1000);
            const borrowPrice = ether(1);
            const reserveConfig = await protocolDataProvider.getReserveConfigurationData(
              weth.address,
            );
            const collateralFactor = reserveConfig.liquidationThreshold.mul(
              BigNumber.from(10).pow(14),
            );

            await subject();

            // aWeth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            const maxRedeemCollateral = calculateMaxBorrowForDelever(
              previousCollateralBalance,
              collateralFactor,
              execution.unutilizedLeveragePercentage,
              collateralPrice,
              borrowPrice,
              previousBorrowBalance,
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCollateral);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWeth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];
            const expectedSecondPositionUnit = (
              await usdcVariableDebtToken.balanceOf(setToken.address)
            ).mul(-1);
            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        },
      );

      context(
        "when notional is less than max trade size and total rebalance notional is less than max borrow",
        async () => {
          before(async () => {
            customTargetLeverageRatio = ether(1.25); // Change to 1.25x
            customMinLeverageRatio = ether(1.1);
          });

          after(async () => {
            customTargetLeverageRatio = undefined;
            customMinLeverageRatio = undefined;
          });

          cacheBeforeEach(async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await aWeth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            await weth.transfer(tradeAdapterMock.address, ether(0.25));

            // Engage to initial leverage
            await leverageStrategyExtension.engage(subjectExchangeName);

            // Withdraw balance of USDC from exchange contract from engage
            await tradeAdapterMock.withdraw(usdc.address);

            const usdcBorrowBalance = await usdcVariableDebtToken.balanceOf(setToken.address);
            // Transfer more than the borrow balance to the exchange
            await usdc.transfer(tradeAdapterMock.address, usdcBorrowBalance.add(1000000000));
            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.disengage(subjectExchangeName);
          }

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const previousATokenBalance = await aWeth.balanceOf(setToken.address);

            await subject();

            // cEther position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected cTokens redeemed
            const expectedCollateralAssetsRedeemed = calculateMaxRedeemForDeleverToZero(
              currentLeverageRatio,
              ether(1), // 1x leverage
              previousATokenBalance,
              ether(1), // Total supply
              execution.slippageTolerance,
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(
              expectedCollateralAssetsRedeemed,
            );
            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWeth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should wipe out the debt on Aave", async () => {
            await subject();

            const borrowDebt = (await usdcVariableDebtToken.balanceOf(setToken.address)).mul(-1);

            expect(borrowDebt).to.eq(ZERO);
          });

          it("should remove any external positions on the borrow asset", async () => {
            await subject();

            const borrowAssetExternalModules = await setToken.getExternalPositionModules(
              usdc.address,
            );
            const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              aaveLeverageModule.address,
            );
            const isPositionModule = await setToken.isExternalPositionModule(
              usdc.address,
              aaveLeverageModule.address,
            );

            expect(borrowAssetExternalModules.length).to.eq(0);
            expect(borrowExternalUnit).to.eq(ZERO);
            expect(isPositionModule).to.eq(false);
          });

          it("should update the borrow asset equity on the SetToken correctly", async () => {
            await subject();

            // The USDC position is positive and represents equity
            const newSecondPosition = (await setToken.getPositions())[1];
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(0); // Default
            expect(BigNumber.from(newSecondPosition.unit)).to.gt(ZERO);
            expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
          });
        },
      );
    });

    describe("#setMethodologySettings", async () => {
      let subjectMethodologySettings: MethodologySettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectMethodologySettings = {
          targetLeverageRatio: ether(2.1),
          minLeverageRatio: ether(1.1),
          maxLeverageRatio: ether(2.5),
          recenteringSpeed: ether(0.1),
          rebalanceInterval: BigNumber.from(43200),
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setMethodologySettings(subjectMethodologySettings);
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should set the correct methodology parameters", async () => {
          await subject();
          const methodology = await leverageStrategyExtension.getMethodology();

          expect(methodology.targetLeverageRatio).to.eq(
            subjectMethodologySettings.targetLeverageRatio,
          );
          expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
          expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
          expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
          expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
        });

        it("should emit MethodologySettingsUpdated event", async () => {
          await expect(subject())
            .to.emit(leverageStrategyExtension, "MethodologySettingsUpdated")
            .withArgs(
              subjectMethodologySettings.targetLeverageRatio,
              subjectMethodologySettings.minLeverageRatio,
              subjectMethodologySettings.maxLeverageRatio,
              subjectMethodologySettings.recenteringSpeed,
              subjectMethodologySettings.rebalanceInterval,
            );
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });

        describe("when min leverage ratio is 0", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.minLeverageRatio = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid min leverage");
          });
        });

        describe("when min leverage ratio is above target", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.minLeverageRatio = ether(2.2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid min leverage");
          });
        });

        describe("when max leverage ratio is below target", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.maxLeverageRatio = ether(1.9);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid max leverage");
          });
        });

        describe("when max leverage ratio is above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.maxLeverageRatio = ether(5);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Incentivized leverage ratio must be > max leverage ratio",
            );
          });
        });

        describe("when recentering speed is >100%", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.recenteringSpeed = ether(1.1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
          });
        });

        describe("when recentering speed is 0%", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.recenteringSpeed = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
          });
        });

        describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
          beforeEach(async () => {
            subjectMethodologySettings.rebalanceInterval = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Rebalance interval must be greater than TWAP cooldown period",
            );
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          // Approve tokens to issuance module and call issue
          await aWeth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await weth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setExecutionSettings", async () => {
      let subjectExecutionSettings: ExecutionSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectExecutionSettings = {
          unutilizedLeveragePercentage: ether(0.05),
          twapCooldownPeriod: BigNumber.from(360),
          slippageTolerance: ether(0.02),
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setExecutionSettings(subjectExecutionSettings);
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);
        it("should set the correct execution parameters", async () => {
          await subject();
          const execution = await leverageStrategyExtension.getExecution();

          expect(execution.unutilizedLeveragePercentage).to.eq(
            subjectExecutionSettings.unutilizedLeveragePercentage,
          );
          expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
          expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
        });

        it("should emit ExecutionSettingsUpdated event", async () => {
          await expect(subject())
            .to.emit(leverageStrategyExtension, "ExecutionSettingsUpdated")
            .withArgs(
              subjectExecutionSettings.unutilizedLeveragePercentage,
              subjectExecutionSettings.twapCooldownPeriod,
              subjectExecutionSettings.slippageTolerance,
            );
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });

        describe("when unutilizedLeveragePercentage is >100%", async () => {
          beforeEach(async () => {
            subjectExecutionSettings.unutilizedLeveragePercentage = ether(1.1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
          });
        });

        describe("when slippage tolerance is >100%", async () => {
          beforeEach(async () => {
            subjectExecutionSettings.slippageTolerance = ether(1.1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
          });
        });

        describe("when TWAP cooldown period is greater than rebalance interval", async () => {
          beforeEach(async () => {
            subjectExecutionSettings.twapCooldownPeriod = ether(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Rebalance interval must be greater than TWAP cooldown period",
            );
          });
        });

        describe("when TWAP cooldown period is shorter than incentivized TWAP cooldown period", async () => {
          beforeEach(async () => {
            subjectExecutionSettings.twapCooldownPeriod = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "TWAP cooldown must be greater than incentivized TWAP cooldown",
            );
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          // Approve tokens to issuance module and call issue
          await aWeth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await weth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#setIncentiveSettings", async () => {
      let subjectIncentiveSettings: IncentiveSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectIncentiveSettings = {
          incentivizedTwapCooldownPeriod: BigNumber.from(30),
          incentivizedSlippageTolerance: ether(0.1),
          etherReward: ether(5),
          incentivizedLeverageRatio: ether(3.2),
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setIncentiveSettings(subjectIncentiveSettings);
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should set the correct incentive parameters", async () => {
          await subject();
          const incentive = await leverageStrategyExtension.getIncentive();

          expect(incentive.incentivizedTwapCooldownPeriod).to.eq(
            subjectIncentiveSettings.incentivizedTwapCooldownPeriod,
          );
          expect(incentive.incentivizedSlippageTolerance).to.eq(
            subjectIncentiveSettings.incentivizedSlippageTolerance,
          );
          expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
          expect(incentive.incentivizedLeverageRatio).to.eq(
            subjectIncentiveSettings.incentivizedLeverageRatio,
          );
        });

        it("should emit IncentiveSettingsUpdated event", async () => {
          await expect(subject())
            .to.emit(leverageStrategyExtension, "IncentiveSettingsUpdated")
            .withArgs(
              subjectIncentiveSettings.etherReward,
              subjectIncentiveSettings.incentivizedLeverageRatio,
              subjectIncentiveSettings.incentivizedSlippageTolerance,
              subjectIncentiveSettings.incentivizedTwapCooldownPeriod,
            );
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });

        describe("when incentivized TWAP cooldown period is greater than TWAP cooldown period", async () => {
          beforeEach(async () => {
            subjectIncentiveSettings.incentivizedTwapCooldownPeriod = ether(1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "TWAP cooldown must be greater than incentivized TWAP cooldown",
            );
          });
        });

        describe("when incentivized slippage tolerance is >100%", async () => {
          beforeEach(async () => {
            subjectIncentiveSettings.incentivizedSlippageTolerance = ether(1.1);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Incentivized slippage tolerance must be <100%",
            );
          });
        });

        describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
          beforeEach(async () => {
            subjectIncentiveSettings.incentivizedLeverageRatio = ether(2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Incentivized leverage ratio must be > max leverage ratio",
            );
          });
        });
      });

      describe("when rebalance is in progress", async () => {
        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          // Approve tokens to issuance module and call issue
          await aWeth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await weth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#addEnabledExchange", async () => {
      let subjectExchangeName: string;
      let subjectExchangeSettings: ExchangeSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectExchangeName = "NewExchange";
        subjectExchangeSettings = {
          twapMaxTradeSize: ether(100),
          incentivizedTwapMaxTradeSize: ether(200),
          exchangeLastTradeTimestamp: BigNumber.from(0),
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.addEnabledExchange(
          subjectExchangeName,
          subjectExchangeSettings,
        );
      }

      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      it("should set the correct exchange parameters", async () => {
        await subject();
        const exchange = await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);

        expect(exchange.twapMaxTradeSize).to.eq(subjectExchangeSettings.twapMaxTradeSize);
        expect(exchange.incentivizedTwapMaxTradeSize).to.eq(
          subjectExchangeSettings.incentivizedTwapMaxTradeSize,
        );
        expect(exchange.exchangeLastTradeTimestamp).to.eq(0);
        expect(exchange.leverExchangeData).to.eq(subjectExchangeSettings.leverExchangeData);
        expect(exchange.deleverExchangeData).to.eq(subjectExchangeSettings.deleverExchangeData);
      });

      it("should add exchange to enabledExchanges", async () => {
        await subject();
        const finalExchanges = await leverageStrategyExtension.getEnabledExchanges();

        expect(finalExchanges.length).to.eq(2);
        expect(finalExchanges[1]).to.eq(subjectExchangeName);
      });

      it("should emit an ExchangeAdded event", async () => {
        await expect(subject())
          .to.emit(leverageStrategyExtension, "ExchangeAdded")
          .withArgs(
            subjectExchangeName,
            subjectExchangeSettings.twapMaxTradeSize,
            subjectExchangeSettings.exchangeLastTradeTimestamp,
            subjectExchangeSettings.incentivizedTwapMaxTradeSize,
            subjectExchangeSettings.leverExchangeData,
            subjectExchangeSettings.deleverExchangeData,
          );
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });

      describe("when exchange has already been added", async () => {
        beforeEach(() => {
          subjectExchangeName = exchangeName;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Exchange already enabled");
        });
      });

      describe("when an exchange has a twapMaxTradeSize of 0", async () => {
        beforeEach(async () => {
          subjectExchangeSettings.twapMaxTradeSize = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
        });
      });
    });

    describe("#updateEnabledExchange", async () => {
      let subjectExchangeName: string;
      let subjectNewExchangeSettings: ExchangeSettings;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectExchangeName = exchangeName;
        subjectNewExchangeSettings = {
          twapMaxTradeSize: ether(101),
          incentivizedTwapMaxTradeSize: ether(201),
          exchangeLastTradeTimestamp: BigNumber.from(0),
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.updateEnabledExchange(
          subjectExchangeName,
          subjectNewExchangeSettings,
        );
      }

      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      it("should set the correct exchange parameters", async () => {
        await subject();
        const exchange = await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);

        expect(exchange.twapMaxTradeSize).to.eq(subjectNewExchangeSettings.twapMaxTradeSize);
        expect(exchange.incentivizedTwapMaxTradeSize).to.eq(
          subjectNewExchangeSettings.incentivizedTwapMaxTradeSize,
        );
        expect(exchange.exchangeLastTradeTimestamp).to.eq(
          subjectNewExchangeSettings.exchangeLastTradeTimestamp,
        );
        expect(exchange.leverExchangeData).to.eq(subjectNewExchangeSettings.leverExchangeData);
        expect(exchange.deleverExchangeData).to.eq(subjectNewExchangeSettings.deleverExchangeData);
      });

      it("should not add duplicate entry to enabledExchanges", async () => {
        await subject();
        const finalExchanges = await leverageStrategyExtension.getEnabledExchanges();

        expect(finalExchanges.length).to.eq(1);
        expect(finalExchanges[0]).to.eq(subjectExchangeName);
      });

      it("should emit an ExchangeUpdated event", async () => {
        await expect(subject())
          .to.emit(leverageStrategyExtension, "ExchangeUpdated")
          .withArgs(
            subjectExchangeName,
            subjectNewExchangeSettings.twapMaxTradeSize,
            subjectNewExchangeSettings.exchangeLastTradeTimestamp,
            subjectNewExchangeSettings.incentivizedTwapMaxTradeSize,
            subjectNewExchangeSettings.leverExchangeData,
            subjectNewExchangeSettings.deleverExchangeData,
          );
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });

      describe("when exchange has not already been added", async () => {
        beforeEach(() => {
          subjectExchangeName = "NewExchange";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Exchange not enabled");
        });
      });

      describe("when an exchange has a twapMaxTradeSize of 0", async () => {
        beforeEach(async () => {
          subjectNewExchangeSettings.twapMaxTradeSize = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
        });
      });
    });

    describe("#removeEnabledExchange", async () => {
      let subjectExchangeName: string;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectExchangeName = exchangeName;
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.removeEnabledExchange(subjectExchangeName);
      }

      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      it("should set the exchange parameters to their default values", async () => {
        await subject();
        const exchange = await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);

        expect(exchange.twapMaxTradeSize).to.eq(0);
        expect(exchange.incentivizedTwapMaxTradeSize).to.eq(0);
        expect(exchange.exchangeLastTradeTimestamp).to.eq(0);
        expect(exchange.leverExchangeData).to.eq(EMPTY_BYTES);
        expect(exchange.deleverExchangeData).to.eq(EMPTY_BYTES);
      });

      it("should remove entry from enabledExchanges list", async () => {
        await subject();
        const finalExchanges = await leverageStrategyExtension.getEnabledExchanges();

        expect(finalExchanges.length).to.eq(0);
      });

      it("should emit an ExchangeRemoved event", async () => {
        await expect(subject())
          .to.emit(leverageStrategyExtension, "ExchangeRemoved")
          .withArgs(subjectExchangeName);
      });

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });

      describe("when exchange has not already been added", async () => {
        beforeEach(() => {
          subjectExchangeName = "NewExchange";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Exchange not enabled");
        });
      });
    });

    describe("#withdrawEtherBalance", async () => {
      let etherReward: BigNumber;
      let subjectCaller: Account;

      const initializeSubjectVariables = async () => {
        etherReward = ether(0.1);
        // Send ETH to contract as reward
        await owner.wallet.sendTransaction({
          to: leverageStrategyExtension.address,
          value: etherReward,
        });
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.withdrawEtherBalance();
      }

      describe("when rebalance is not in progress", () => {
        cacheBeforeEach(initializeRootScopeContracts);
        beforeEach(initializeSubjectVariables);

        it("should withdraw ETH balance on contract to operator", async () => {
          const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const previousOwnerEthBalance = await getEthBalance(owner.address);

          const txHash = await subject();
          const txReceipt = await provider.getTransactionReceipt(txHash.hash);
          const currentContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const currentOwnerEthBalance = await getEthBalance(owner.address);
          const expectedOwnerEthBalance = previousOwnerEthBalance
            .add(etherReward)
            .sub(txReceipt.gasUsed.mul(txHash.gasPrice));

          expect(previousContractEthBalance).to.eq(etherReward);
          expect(currentContractEthBalance).to.eq(ZERO);
          expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
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

      describe("when rebalance is in progress", async () => {
        beforeEach(async () => {
          await initializeRootScopeContracts();
          initializeSubjectVariables();

          // Approve tokens to issuance module and call issue
          await aWeth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await weth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
      });
    });

    describe("#getCurrentEtherIncentive", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        await leverageStrategyExtension.iterateRebalance(exchangeName);
      });

      async function subject(): Promise<any> {
        return leverageStrategyExtension.getCurrentEtherIncentive();
      }

      describe("when above incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await owner.wallet.sendTransaction({
            to: leverageStrategyExtension.address,
            value: ether(1),
          });
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(incentive.etherReward);
        });

        describe("when ETH balance is below ETH reward amount", async () => {
          beforeEach(async () => {
            await leverageStrategyExtension.withdrawEtherBalance();
            // Transfer 0.01 ETH to contract
            await owner.wallet.sendTransaction({
              to: leverageStrategyExtension.address,
              value: ether(0.01),
            });
          });

          it("should return the correct value", async () => {
            const etherIncentive = await subject();

            expect(etherIncentive).to.eq(ether(0.01));
          });
        });
      });

      describe("when below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(2000).mul(10 ** 8));
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(ZERO);
        });
      });
    });

    describe("#shouldRebalance", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        await leverageStrategyExtension.iterateRebalance(exchangeName);
      });

      async function subject(): Promise<[string[], number[]]> {
        return leverageStrategyExtension.shouldRebalance();
      }

      context("when in the midst of a TWAP rebalance", async () => {
        cacheBeforeEach(async () => {
          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);

          // > Max trade size
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.001),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await leverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);

          // Set up new rebalance TWAP
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100000));
          await leverageStrategyExtension.rebalance(exchangeName);
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));
          });

          it("should return ripcord", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(THREE);
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(4000));
          });

          it("should return iterate rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(TWO);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });
      });

      context("when not in a TWAP rebalance", async () => {
        describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));
          });

          it("should return ripcord", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(THREE);
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100000));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });
      });
    });

    describe("#shouldRebalanceWithBounds", async () => {
      let subjectMinLeverageRatio: BigNumber;
      let subjectMaxLeverageRatio: BigNumber;

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        await leverageStrategyExtension.iterateRebalance(exchangeName);
      });

      beforeEach(() => {
        subjectMinLeverageRatio = ether(1.6);
        subjectMaxLeverageRatio = ether(2.4);
      });

      async function subject(): Promise<[string[], number[]]> {
        return leverageStrategyExtension.shouldRebalanceWithBounds(
          subjectMinLeverageRatio,
          subjectMaxLeverageRatio,
        );
      }

      context("when in the midst of a TWAP rebalance", async () => {
        beforeEach(async () => {
          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);

          // > Max trade size
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.001),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await leverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);

          // Set up new rebalance TWAP
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100000));
          await leverageStrategyExtension.rebalance(exchangeName);
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));
          });

          it("should return ripcord", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(THREE);
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(4000));
          });

          it("should return iterate rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(TWO);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });
      });

      context("when not in a TWAP rebalance", async () => {
        describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100));
          });

          it("should return ripcord", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(THREE);
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
            await increaseTimeAsync(BigNumber.from(100000));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when custom min leverage ratio is above methodology min leverage ratio", async () => {
          beforeEach(async () => {
            subjectMinLeverageRatio = ether(1.9);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
          });
        });

        describe("when custom max leverage ratio is below methodology max leverage ratio", async () => {
          beforeEach(async () => {
            subjectMinLeverageRatio = ether(2.2);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
          });
        });
      });
    });

    describe("#getChunkRebalanceNotional", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await aWeth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Add second exchange
        const exchangeSettings2 = exchangeSettings;
        exchangeSettings2.twapMaxTradeSize = ether(1);
        exchangeSettings2.incentivizedTwapMaxTradeSize = ether(2);
        await leverageStrategyExtension.addEnabledExchange(exchangeName2, exchangeSettings2);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await weth.transfer(tradeAdapterMock.address, ether(0.5));

        await leverageStrategyExtension.iterateRebalance(exchangeName);
      });

      async function subject(): Promise<[BigNumber[], Address, Address]> {
        return await leverageStrategyExtension.getChunkRebalanceNotional([
          exchangeName,
          exchangeName2,
        ]);
      }

      context("when in the midst of a TWAP rebalance", async () => {
        beforeEach(async () => {
          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);

          // > Max trade size
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.001),
            incentivizedTwapMaxTradeSize: ether(0.002),
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await leverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);

          // Set up new rebalance TWAP
          await usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100000));
          await leverageStrategyExtension.rebalance(exchangeName);
        });

        describe("when above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const newLeverageRatio = methodology.maxLeverageRatio;
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(
              setToken,
              aWeth,
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(ether(0.002));
            expect(chunkRebalances[1]).to.eq(expectedTotalRebalance);
          });
        });

        describe("when below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(
              setToken,
              aWeth,
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(ether(0.001));
            expect(chunkRebalances[1]).to.eq(expectedTotalRebalance);
          });
        });
      });

      context("when not in a TWAP rebalance", async () => {
        beforeEach(async () => {
          const exchangeSettings2 = exchangeSettings;
          exchangeSettings2.twapMaxTradeSize = ether(0.001);
          exchangeSettings2.incentivizedTwapMaxTradeSize = ether(0.002);
          await leverageStrategyExtension.updateEnabledExchange(exchangeName2, exchangeSettings2);
        });

        describe("when above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const newLeverageRatio = methodology.maxLeverageRatio;
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(
              setToken,
              aWeth,
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
            expect(chunkRebalances[1]).to.eq(ether(0.002));
          });
        });

        describe("when between max and min leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatio(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(
              setToken,
              aWeth,
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
            expect(chunkRebalances[1]).to.eq(ether(0.001));
          });
        });

        describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatio(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            const expectedTotalRebalance = await calculateTotalRebalanceNotionalAave(
              setToken,
              aWeth,
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
            expect(chunkRebalances[1]).to.eq(ether(0.001));
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = calculateNewLeverageRatio(
              currentLeverageRatio,
              methodology.targetLeverageRatio,
              methodology.minLeverageRatio,
              methodology.maxLeverageRatio,
              methodology.recenteringSpeed,
            );
            const totalCollateralRebalance = await calculateTotalRebalanceNotionalAave(
              setToken,
              aWeth,
              currentLeverageRatio,
              newLeverageRatio,
            );
            // Multiply collateral by conversion rate (1400 USDC per ETH) and adjust for decimals
            const expectedTotalRebalance = preciseMul(totalCollateralRebalance, ether(1400)).div(
              BigNumber.from(10).pow(12),
            );

            expect(sellAsset).to.eq(strategy.borrowAsset);
            expect(buyAsset).to.eq(strategy.collateralAsset);
            expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
            expect(chunkRebalances[1]).to.eq(
              preciseMul(ether(0.001), ether(1400)).div(BigNumber.from(10).pow(12)),
            );
          });
        });
      });
    });
  });
}
