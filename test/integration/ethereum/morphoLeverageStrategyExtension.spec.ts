import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers, network } from "hardhat";

import {
  Address,
  Account,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings,
} from "@utils/types";
import { impersonateAccount, setBalance } from "../../../utils/test/testingUtils";
import { ADDRESS_ZERO, EMPTY_BYTES, ZERO, THREE, TWO, ONE } from "@utils/constants";
import { BaseManager } from "@utils/contracts/index";
import {
  ChainlinkAggregatorV3Mock,
  ContractCallerMock,
  MorphoLeverageModule,
  MorphoLeverageStrategyExtension,
  Controller,
  Controller__factory,
  IMorphoOracle,
  IMorphoOracle__factory,
  IMorpho,
  IMorpho__factory,
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
  TradeAdapterMock,
  IChainlinkEACAggregatorProxy,
  IChainlinkEACAggregatorProxy__factory,
} from "../../../typechain";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getWaffleExpect,
  getRandomAccount,
  preciseDivCeil,
  increaseTimeAsync,
  calculateCollateralRebalanceUnits,
  calculateNewLeverageRatio,
  getEthBalance,
  preciseMul,
  preciseDiv,
  calculateMaxRedeemForDeleverToZero,
} from "@utils/index";
import { convertPositionToNotional } from "@utils/test";

const expect = getWaffleExpect();

const MORPHO_ORACLE_PRICE_SCALE = BigNumber.from(10).pow(36);

const contractAddresses = {
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0x04b59F9F09750C044D7CfbC177561E409085f0f3",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
  uniswapV3ExchangeAdapterV2: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  uniswapV3Router: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  wethDaiPool: "0x60594a405d53811d3bc4766596efd80fd545a270",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  // Note: This is the ultimate source for the current eth price for the morpho oracle
  chainlinkUsdcEthOracleProxy: "0x986b5E1e1755e3C2440e960477f25201B0a8bbD4",
};

const tokenAddresses = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  stEth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
};

const whales = {
  dai: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  wsteth: "0x3c22ec75ea5D745c78fc84762F7F1E6D82a2c5BF",
  weth: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28",
  usdc: "0xCFFAd3200574698b78f32232aa9D63eABD290703",
};

const wstethUsdcMarketParams = {
  loanToken: tokenAddresses.usdc,
  collateralToken: tokenAddresses.wsteth,
  oracle: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2",
  irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  lltv: ether(0.86),
};

const marketId = "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc";
if (process.env.INTEGRATIONTEST) {
  describe("MorphoLeverageStrategyExtension", () => {
    let owner: Account;
    let nonOwner: Account;
    let methodologist: Account;

    let deployer: DeployHelper;
    let setToken: SetToken;
    let morphoLeverageModule: MorphoLeverageModule;
    let debtIssuanceModule: DebtIssuanceModuleV2;
    let morphoOracle: IMorphoOracle;
    let integrationRegistry: IntegrationRegistry;
    let setTokenCreator: SetTokenCreator;
    let tradeAdapterMock: TradeAdapterMock;
    let tradeAdapterMock2: TradeAdapterMock;
    let wsteth: IERC20;
    let usdc: IERC20;
    let customTargetLeverageRatio: any;
    let customMinLeverageRatio: any;
    let morpho: IMorpho;
    let usdcEthOracleProxy: IChainlinkEACAggregatorProxy;
    let controller: Controller;

    let usdcEthOrackeMock: ChainlinkAggregatorV3Mock;

    let strategy: any;
    let methodology: MethodologySettings;
    let execution: ExecutionSettings;
    let incentive: IncentiveSettings;
    const exchangeName = "MockTradeAdapter";
    const exchangeName2 = "MockTradeAdapter2";
    let exchangeSettings: ExchangeSettings;
    let initialCollateralPriceInverted: BigNumber;

    let leverageStrategyExtension: MorphoLeverageStrategyExtension;
    let baseManagerV2: BaseManager;
    let manager: Address;

    cacheBeforeEach(async () => {
      [owner, methodologist, nonOwner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      usdcEthOrackeMock = await deployer.mocks.deployChainlinkAggregatorMock();
      usdcEthOracleProxy = IChainlinkEACAggregatorProxy__factory.connect(
        contractAddresses.chainlinkUsdcEthOracleProxy,
        owner.wallet,
      );
      initialCollateralPriceInverted = await usdcEthOracleProxy.latestAnswer();
      usdcEthOrackeMock.setPrice(initialCollateralPriceInverted);

      const oracleOwner = await usdcEthOracleProxy.owner();
      await setBalance(oracleOwner, ether(10000));
      usdcEthOracleProxy = usdcEthOracleProxy.connect(await impersonateAccount(oracleOwner));
      await usdcEthOracleProxy.proposeAggregator(usdcEthOrackeMock.address);
      await usdcEthOracleProxy.confirmAggregator(usdcEthOrackeMock.address);

      morphoLeverageModule = await deployer.setV2.deployMorphoLeverageModule(
        contractAddresses.controller,
        contractAddresses.morpho,
      );
      morpho = IMorpho__factory.connect(contractAddresses.morpho, owner.wallet);

      controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);
      const controllerOwner = await controller.owner();
      // setBalance of controller Owner to 100 eth
      await setBalance(controllerOwner, ether(100));
      controller = controller.connect(await impersonateAccount(controllerOwner));

      manager = owner.address;
      usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
      const usdcWhaleBalance = await usdc.balanceOf(whales.usdc);
      await usdc
        .connect(await impersonateAccount(whales.usdc))
        .transfer(owner.address, usdcWhaleBalance);
      wsteth = IERC20__factory.connect(tokenAddresses.wsteth, owner.wallet);
      // whale needs eth for the transfer.
      await network.provider.send("hardhat_setBalance", [whales.wsteth, ether(10).toHexString()]);
      const wstethWhaleBalance = await wsteth.balanceOf(whales.wsteth);
      await wsteth
        .connect(await impersonateAccount(whales.wsteth))
        .transfer(owner.address, wstethWhaleBalance);

      morphoOracle = IMorphoOracle__factory.connect(wstethUsdcMarketParams.oracle, owner.wallet);
      integrationRegistry = IntegrationRegistry__factory.connect(
        contractAddresses.integrationRegistry,
        owner.wallet,
      );
      const integrationRegistryOwner = await integrationRegistry.owner();
      integrationRegistry = integrationRegistry.connect(
        await impersonateAccount(integrationRegistryOwner),
      );

      setTokenCreator = SetTokenCreator__factory.connect(
        contractAddresses.setTokenCreator,
        owner.wallet,
      );

      debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
        contractAddresses.debtIssuanceModule,
        owner.wallet,
      );
    });

    const replaceRegistry = async (
      integrationModuleAddress: string,
      name: string,
      adapterAddress: string,
    ) => {
      const currentAdapterAddress = await integrationRegistry.getIntegrationAdapter(
        integrationModuleAddress,
        name,
      );
      if (!ethers.utils.isAddress(adapterAddress)) {
        throw new Error("Invalid address: " + adapterAddress + " for " + name + " adapter");
      }
      if (ethers.utils.isAddress(currentAdapterAddress) && currentAdapterAddress != ADDRESS_ZERO) {
        await integrationRegistry.editIntegration(integrationModuleAddress, name, adapterAddress);
      } else {
        await integrationRegistry.addIntegration(integrationModuleAddress, name, adapterAddress);
      }
    };
    const sharesToAssetsUp = (
      shares: BigNumber,
      totalAssets: BigNumber,
      totalShares: BigNumber,
    ) => {
      const VIRTUAL_SHARES = 1e6;
      const VIRTUAL_ASSETS = 1;
      const totalAssetsAdjusted = totalAssets.add(VIRTUAL_ASSETS);
      const totalSharesAdjusted = totalShares.add(VIRTUAL_SHARES);
      return shares
        .mul(totalAssetsAdjusted)
        .add(totalSharesAdjusted)
        .sub(1)
        .div(totalSharesAdjusted);
    };

    async function calculateTotalRebalanceNotional(
      currentLeverageRatio: BigNumber,
      newLeverageRatio: BigNumber,
    ): Promise<BigNumber> {
      const { collateralTotalBalance } = await getBorrowAndCollateralBalances();
      const a = currentLeverageRatio.gt(newLeverageRatio)
        ? currentLeverageRatio.sub(newLeverageRatio)
        : newLeverageRatio.sub(currentLeverageRatio);
      const b = preciseMul(a, collateralTotalBalance);
      return preciseDiv(b, currentLeverageRatio);
    }

    function calculateMaxBorrowForDeleverV3(
      collateralBalance: BigNumber,
      collateralPrice: BigNumber,
      borrowBalance: BigNumber,
    ) {
      const netBorrowLimit = preciseMul(
        preciseMul(
          collateralBalance.mul(collateralPrice).div(MORPHO_ORACLE_PRICE_SCALE),
          wstethUsdcMarketParams.lltv,
        ),
        ether(1).sub(execution.unutilizedLeveragePercentage),
      );
      return preciseDiv(
        preciseMul(collateralBalance, netBorrowLimit.sub(borrowBalance)),
        netBorrowLimit,
      );
    }

    async function getBorrowAndCollateralBalances() {
      const [, borrowShares, collateral] = await morpho.position(marketId, setToken.address);
      const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
      const collateralTotalBalance = collateralTokenBalance.add(collateral);
      const [, , totalBorrowAssets, totalBorrowShares, , ] = await morpho.market(marketId);
      const borrowAssets = sharesToAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
      return { collateralTotalBalance, borrowAssets };
    }

    async function checkSetComponentsAgainstMorphoPosition() {
      await morpho.accrueInterest(wstethUsdcMarketParams);
      const currentPositions = await setToken.getPositions();
      const initialSetTokenSupply = await setToken.totalSupply();
      const collateralNotional = await convertPositionToNotional(
        currentPositions[0].unit,
        setToken,
      );

      const { collateralTotalBalance, borrowAssets } = await getBorrowAndCollateralBalances();

      expect(collateralNotional).to.lte(collateralTotalBalance);
      // Maximum rounding error when converting position to notional
      expect(collateralNotional).to.gt(
        collateralTotalBalance.sub(initialSetTokenSupply.div(ether(1))),
      );
      if (borrowAssets.gt(0)) {
        const borrowNotional = await convertPositionToNotional(currentPositions[1].unit, setToken);
        // TODO: Review that this error margin is correct / expected
        expect(borrowNotional.mul(-1)).to.gte(
          borrowAssets.sub(preciseDivCeil(initialSetTokenSupply, ether(1))),
        );
        expect(borrowNotional.mul(-1)).to.lte(
          borrowAssets.add(preciseDivCeil(initialSetTokenSupply, ether(1))),
        );
      }
    }

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
      if (!(await controller.isModule(morphoLeverageModule.address))) {
        await controller.addModule(morphoLeverageModule.address);
        tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
        replaceRegistry(morphoLeverageModule.address, exchangeName, tradeAdapterMock.address);
        // Deploy mock trade adapter 2
        tradeAdapterMock2 = await deployer.mocks.deployTradeAdapterMock();
        replaceRegistry(morphoLeverageModule.address, exchangeName2, tradeAdapterMock2.address);
        replaceRegistry(
          morphoLeverageModule.address,
          "DefaultIssuanceModule",
          debtIssuanceModule.address,
        );
        replaceRegistry(
          debtIssuanceModule.address,
          "MorphoLeverageModuleV3",
          morphoLeverageModule.address,
        );
      }

      setToken = await createSetToken(
        [wsteth.address],
        [ether(1)],
        [debtIssuanceModule.address, morphoLeverageModule.address],
      );
      const ownerofLeveverageModule = await morphoLeverageModule.owner();
      if (ownerofLeveverageModule != owner.address) {
        await morphoLeverageModule
          .connect(await impersonateAccount(ownerofLeveverageModule))
          .updateAnySetAllowed(true);
      } else {
        await morphoLeverageModule.updateAnySetAllowed(true);
      }
      // Initialize modules
      await debtIssuanceModule.initialize(
        setToken.address,
        ether(1),
        ZERO,
        ZERO,
        owner.address,
        ADDRESS_ZERO,
      );

      await morphoLeverageModule.initialize(setToken.address, wstethUsdcMarketParams);

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
        leverageModule: morphoLeverageModule.address,
        collateralAsset: wsteth.address,
        borrowAsset: usdc.address,
        collateralDecimalAdjustment: BigNumber.from(10),
        borrowDecimalAdjustment: BigNumber.from(10),
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

      leverageStrategyExtension = await deployer.extensions.deployMorphoLeverageStrategyExtension(
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
      let subjectContractSettings: any;
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
          leverageModule: morphoLeverageModule.address,
          collateralAsset: wsteth.address,
          borrowAsset: usdc.address,
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

      async function subject(): Promise<MorphoLeverageStrategyExtension> {
        return await deployer.extensions.deployMorphoLeverageStrategyExtension(
          subjectManagerAddress,
          subjectContractSettings,
          subjectMethodologySettings,
          subjectExecutionSettings,
          subjectIncentiveSettings,
          [subjectExchangeName],
          [subjectExchangeSettings],
        );
      }

      it("should set overrideNoRebalanceInProgress flag", async () => {
        const retrievedAdapter = await subject();

        const overrideNoRebalanceInProgress =
          await retrievedAdapter.overrideNoRebalanceInProgress();

        expect(overrideNoRebalanceInProgress).to.be.false;
      });

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

            await wsteth.approve(debtIssuanceModule.address, ether(1000));
            // await usdc.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            issueQuantity = ether(1);

            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address, {
              gasLimit: 10000000,
            });

            destinationTokenQuantity = ether(0.5);
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
            await wsteth.transfer(tradeAdapterMock2.address, destinationTokenQuantity);
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

              const exchangeSettings =
                await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

              // wsteth position is increased
              const currentPositions = await setToken.getPositions();
              const newFirstPosition = currentPositions[0];

              // Get expected aTokens position size
              const expectedFirstPositionUnit =
                initialPositions[0].unit.add(destinationTokenQuantity);

              expect(initialPositions.length).to.eq(1);
              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(wsteth.address);
              expect(newFirstPosition.positionState).to.eq(1); // External
              expect(newFirstPosition.unit).to.be.gte(expectedFirstPositionUnit.mul(999).div(1000));
              expect(newFirstPosition.unit).to.be.lte(
                expectedFirstPositionUnit.mul(1001).div(1000),
              );
              expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
            });

            it("positions should align with token balances", async () => {
              await subject();
              await checkSetComponentsAgainstMorphoPosition();
            });

            it("should update the borrow position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // wsteth position is increased
              const currentPositions = await setToken.getPositions();
              const newSecondPosition = (await setToken.getPositions())[1];

              expect(initialPositions.length).to.eq(1);
              expect(currentPositions.length).to.eq(2);
              expect(newSecondPosition.component).to.eq(usdc.address);
              expect(newSecondPosition.positionState).to.eq(1); // External
              expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
            });

            it("should emit Engaged event", async () => {
              await expect(subject()).to.emit(leverageStrategyExtension, "Engaged");
            });

            describe("when borrow balance is not 0", async () => {
              beforeEach(async () => {
                const setTokenSigner = await impersonateAccount(setToken.address);
                await setBalance(setToken.address, ether(1));
                await wsteth.transfer(setToken.address, ether(1));
                await wsteth.connect(setTokenSigner).approve(morpho.address, ether(1));
                await morpho
                  .connect(setTokenSigner)
                  .supplyCollateral(
                    wstethUsdcMarketParams,
                    ether(1),
                    setToken.address,
                    EMPTY_BYTES,
                  );
                await morpho
                  .connect(setTokenSigner)
                  .borrow(wstethUsdcMarketParams, 1_000_000, 0, setToken.address, setToken.address);
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
                // Note: Different revert message because the enterCollateralPosition function revers already before the set token balance check
                await expect(subject()).to.be.revertedWith("Collateral balance is 0");
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
        },
      );

      context(
        "when rebalance notional is less than max trade size and greater than max borrow",
        async () => {
          cacheBeforeEach(async () => {
            await initializeRootScopeContracts();

            // Approve tokens to issuance module and call issue
            await wsteth.approve(debtIssuanceModule.address, ether(1000));
            await usdc.approve(debtIssuanceModule.address, ether(1000));

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
            destinationTokenQuantity = ether(0.85);
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
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

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aToken position unit
            const expectedFirstPositionUnit =
              initialPositions[0].unit.add(destinationTokenQuantity);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1);
            expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("positions should align with token balances", async () => {
            await subject();
            await checkSetComponentsAgainstMorphoPosition();
          });
          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = currentPositions[1];

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
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
            await wsteth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
            destinationTokenQuantity = ether(0.25);
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
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

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = currentPositions[0];

            // Get expected wsteth position units
            const expectedFirstPositionUnit = customTargetLeverageRatio;

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("positions should align with token balances", async () => {
            await subject();
            await checkSetComponentsAgainstMorphoPosition();
          });
          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        const maxIteration = 10;
        let iteration = 0;
        if (ifEngaged) {
          // Engage to initial leverage
          await leverageStrategyExtension.engage(subjectExchangeName);
          while (
            (await leverageStrategyExtension.twapLeverageRatio()).gt(0) &&
            iteration < maxIteration
          ) {
            await increaseTimeAsync(BigNumber.from(100000));
            await wsteth.transfer(tradeAdapterMock.address, ether(0.5));
            await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
            iteration++;
          }
        }
      };

      async function subject(): Promise<any> {
        return leverageStrategyExtension
          .connect(subjectCaller.wallet)
          .rebalance(subjectExchangeName);
      }
      cacheBeforeEach(intializeContracts);

      context("when methodology settings are increased beyond default maximum", () => {
        let newMethodology: MethodologySettings;
        let newIncentive: IncentiveSettings;
        beforeEach(() => {
          subjectCaller = owner;
        });
        cacheBeforeEach(async () => {
          newIncentive = {
            ...incentive,
            incentivizedLeverageRatio: ether(9.1),
          };
          await leverageStrategyExtension.setIncentiveSettings(newIncentive);
          newMethodology = {
            targetLeverageRatio: ether(8),
            minLeverageRatio: ether(7),
            maxLeverageRatio: ether(9),
            recenteringSpeed: methodology.recenteringSpeed,
            rebalanceInterval: methodology.rebalanceInterval,
          };
          await leverageStrategyExtension.setMethodologySettings(newMethodology);
          destinationTokenQuantity = ether(0.5);
          await increaseTimeAsync(BigNumber.from(100000));

          await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });
      });

      context("when current leverage ratio is below target (lever)", async () => {
        cacheBeforeEach(async () => {
          destinationTokenQuantity = ether(0.1);
          await increaseTimeAsync(BigNumber.from(100000));
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(11).div(10);
          usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        beforeEach(() => {
          subjectCaller = owner;
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings =
            await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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
          await morphoLeverageModule.sync(setToken.address);

          // wsteth position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected collateral token position units;
          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(wsteth.address);
          expect(newFirstPosition.positionState).to.eq(1); // Default
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // wsteth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
        });

        it("should emit Rebalanced event", async () => {
          await expect(subject()).to.emit(leverageStrategyExtension, "Rebalanced");
        });

        describe("when rebalance interval has not elapsed but is below min leverage ratio and lower than max trade size", async () => {
          cacheBeforeEach(async () => {
            await subject();
            // ~1.6x leverage
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(6).div(5);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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
            const expectedFirstPositionUnit =
              initialPositions[0].unit.add(destinationTokenQuantity);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });
        });

        describe("when rebalance interval has not elapsed below min leverage ratio and greater than max trade size", async () => {
          cacheBeforeEach(async () => {
            await subject();
            // ~1.6x leverage
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(6).div(5);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            // await chainlinkCollateralPriceMock.setPrice(initialCollateralPrice.mul(6).div(5));
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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
            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aToken position units
            const expectedFirstPositionUnit = initialPositions[0].unit.add(ether(0.5));

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(6).div(5);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            await wsteth.transfer(tradeAdapterMock.address, ether(0.01));
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must call iterate");
          });
        });

        describe("when borrow balance is 0", async () => {
          beforeEach(async () => {
            await usdc.approve(morpho.address, 10_000 * 10 ** 6);
            const position = await morpho.position(marketId, setToken.address);
            await morpho.repay(
              wstethUsdcMarketParams,
              0,
              position.borrowShares,
              setToken.address,
              EMPTY_BYTES,
            );
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

        // describe("when SetToken has 0 supply", async () => {
        // Note: This will fail when trying to redeem the whole set supply because of rounding error / inprescision in the asset / shares math
        // TODO: Check if this is acceptable or we need to fix this (for example by using shares instead  of asset units)
        // beforeEach(async () => {
        //   await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
        //   // This does not revert
        //   // await debtIssuanceModule.redeem(setToken.address, ether(0.99999999), owner.address, {gasLimit: 5_000_000});
        //   // This does revert
        //   await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address, {
        //     gasLimit: 5_000_000,
        //   });
        // });
        // it("should revert", async () => {
        //   await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
        // });
        // });
      });

      context("when current leverage ratio is above target (delever)", async () => {
        let sendQuantity: BigNumber;
        cacheBeforeEach(async () => {
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));
          // Reduce by 10% so need to delever
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(10).div(11);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          sendQuantity = BigNumber.from(100 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendQuantity);
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

          const exchangeSettings =
            await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

          const { collateralTotalBalance } = await getBorrowAndCollateralBalances();

          await subject();

          // wsteth position is decreased
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
            collateralTotalBalance,
            ether(1), // Total supply
          );

          const expectedFirstPositionUnit = initialPositions[0].unit.sub(
            expectedCollateralAssetsRedeemed,
          );

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(wsteth.address);
          expect(newFirstPosition.positionState).to.eq(1); // External
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // wsteth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
        });

        describe("when rebalance interval has not elapsed above max leverage ratio and lower than max trade size", async () => {
          let sendQuantity: BigNumber;
          cacheBeforeEach(async () => {
            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
            // ~2.4x leverage
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(85).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            sendQuantity = BigNumber.from(100 * 10 ** 6);
            await usdc.transfer(tradeAdapterMock.address, sendQuantity);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

            const { collateralTotalBalance } = await getBorrowAndCollateralBalances();

            await subject();

            // wsteth position is decreased
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
              collateralTotalBalance,
              await setToken.totalSupply(), // Total supply
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(
              expectedCollateralAssetsRedeemed,
            );

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });
        });

        describe("when rebalance interval has not elapsed above max leverage ratio and greater than max trade size", async () => {
          let newTWAPMaxTradeSize: BigNumber;
          let sendQuantity: BigNumber;

          cacheBeforeEach(async () => {
            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

            // ~2.4x leverage
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(85).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            // await chainlinkCollateralPriceMock.setPrice(initialCollateralPrice.mul(85).div(100));
            sendQuantity = BigNumber.from(100 * 10 ** 6);
            await usdc.transfer(tradeAdapterMock.address, sendQuantity);
          });

          it("should set the last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

            // wsteth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Max TWAP collateral units
            const expectedFirstPositionUnit = initialPositions[0].unit.sub(newTWAPMaxTradeSize);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });
        });

        context("when using two exchanges", async () => {
          let subjectExchangeToUse: string;
          let sendQuantity: BigNumber;

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

            // await chainlinkCollateralPriceMock.setPrice(initialCollateralPrice.mul(87).div(100));
            sendQuantity = BigNumber.from(100 * 10 ** 6);
            await usdc.transfer(tradeAdapterMock.address, sendQuantity);
            await usdc.transfer(tradeAdapterMock2.address, sendQuantity);
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

          describe("when leverage ratio is above max and rises further between rebalances", async () => {
            it("should set the global and exchange timestamps correctly", async () => {
              await subject();
              const timestamp1 = await getLastBlockTimestamp();

              subjectExchangeToUse = exchangeName2;
              const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
              const newCollateralPrice = initialCollateralPrice.mul(82).div(100);
              await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(65).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            ifEngaged = false;
            await intializeContracts();
          });

          after(async () => {
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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        if (ifEngaged) {
          // Engage to initial leverage
          await leverageStrategyExtension.engage(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100000));
          await wsteth.transfer(tradeAdapterMock.address, ether(0.5));
          await leverageStrategyExtension.iterateRebalance(subjectExchangeName);
        }
      };

      cacheBeforeEach(intializeContracts);

      context("when currently in the last chunk of a TWAP rebalance", async () => {
        cacheBeforeEach(async () => {
          await increaseTimeAsync(BigNumber.from(100000));
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(12).div(10);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
          await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

          await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

          await increaseTimeAsync(BigNumber.from(4000));
          await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
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

          const exchangeSettings =
            await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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
          // wsteth position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected aTokens minted
          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(wsteth.address);
          expect(newFirstPosition.positionState).to.eq(1); // External
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // wsteth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
        });
      });

      context(
        "when current leverage ratio is above target and middle of a TWAP rebalance",
        async () => {
          let preTwapLeverageRatio: BigNumber;

          cacheBeforeEach(async () => {
            await increaseTimeAsync(BigNumber.from(100000));
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(12).div(10);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
            preTwapLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            // Initialize TWAP
            await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
            await increaseTimeAsync(BigNumber.from(4000));
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
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

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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
            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aTokens minted
            const expectedFirstPositionUnit =
              initialPositions[0].unit.add(destinationTokenQuantity);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should emit RebalanceIterated event", async () => {
            await expect(subject()).to.emit(leverageStrategyExtension, "RebalanceIterated");
          });

          describe("when price has moved advantageously towards target leverage ratio", async () => {
            beforeEach(async () => {
              await usdcEthOrackeMock.setPrice(initialCollateralPriceInverted);
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should set the exchange's last trade timestamp", async () => {
              await subject();

              const exchangeSettings =
                await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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

              const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
              const newCollateralPrice = initialCollateralPrice.mul(65).div(100);
              await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
              await usdc.approve(morpho.address, 10_000 * 10 ** 6);
              const position = await morpho.position(marketId, setToken.address);
              await morpho.repay(
                wstethUsdcMarketParams,
                0,
                position.borrowShares,
                setToken.address,
                EMPTY_BYTES,
              );
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

          // TODO: See above regarding inability to redeem 100% of the supply
          // describe("when SetToken has 0 supply", async () => {
          //   beforeEach(async () => {
          //     await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          //     await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
          //   });

          //   it("should revert", async () => {
          //     await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
          //   });
          // });

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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(9).div(10);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
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
              await usdcEthOrackeMock.setPrice(initialCollateralPriceInverted);
            });

            it("should set the global last trade timestamp", async () => {
              await subject();

              const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

              expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
            });

            it("should set the exchange's last trade timestamp", async () => {
              await subject();

              const exchangeSettings =
                await leverageStrategyExtension.getExchangeSettings(subjectExchangeName);
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
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(12).div(10);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
          await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

          // Initialize TWAP
          await leverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(4000));
          await wsteth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
          await wsteth.transfer(tradeAdapterMock2.address, destinationTokenQuantity);
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
            // Set collateral asset to cusdc with 0 balance
            ifEngaged = false;
            await intializeContracts();
            subjectCaller = owner;
          });

          after(async () => {
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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        if (ifEngaged) {
          // Engage to initial leverage
          await leverageStrategyExtension.engage(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100000));
          await wsteth.transfer(tradeAdapterMock.address, ether(0.5));
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
        let sendQuantity: BigNumber;
        cacheBeforeEach(async () => {
          // Withdraw balance of usdc from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));

          // Set to above incentivized ratio
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(8).div(10);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          sendQuantity = BigNumber.from(2000 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendQuantity);

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

        describe("When borrowValue > collateralValue * liquidationThreshold * (1 - unutilizedLeveragPercentage)", () => {
          beforeEach(async () => {
            const { collateralTotalBalance, borrowAssets } = await getBorrowAndCollateralBalances();
            const collateralPrice = await morphoOracle.price();
            const executionSettings = await leverageStrategyExtension.getExecution();
            const unutilizedLeveragePercentage = executionSettings.unutilizedLeveragePercentage;
            const collateralValue = preciseMul(collateralPrice, collateralTotalBalance);
            const collateralFactor = preciseMul(
              wstethUsdcMarketParams.lltv,
              ether(1).sub(unutilizedLeveragePercentage),
            );
            const borrowBalanceThreshold = preciseMul(collateralValue, collateralFactor).div(
              ether(1),
            );

            const relativeIncrease = borrowBalanceThreshold.mul(1000).div(borrowAssets);
            const currentUsdcEthPrice = await usdcEthOrackeMock.latestAnswer();
            const currentWstethPrice = await morphoOracle.price();
            const implicitWstethEthPrice = currentWstethPrice
              .mul(currentUsdcEthPrice)
              .div(ether(1))
              .div(ether(1));
            const relativeIncreaseUsdcEthPrice = relativeIncrease
              .mul(10 ** 6)
              .div(implicitWstethEthPrice);
            const newUsdcEthPrice = currentUsdcEthPrice
              .mul(relativeIncreaseUsdcEthPrice.add(1))
              .div(1000);
            await usdcEthOrackeMock.setPrice(newUsdcEthPrice);
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings =
            await leverageStrategyExtension.getExchangeSettings(exchangeName);
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

          const { collateralTotalBalance } = await getBorrowAndCollateralBalances();
          const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

          await subject();

          // wsteth position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed,
          );

          // Get expected wsteth redeemed
          const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
            currentLeverageRatio,
            expectedNewLeverageRatio,
            collateralTotalBalance,
            ether(1), // Total supply
          );
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(
            expectedCollateralAssetsRedeemed,
          );

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(wsteth.address);
          expect(newFirstPosition.positionState).to.eq(1); // External
          expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
          expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
          expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // wsteth position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
        });

        it("should transfer incentive", async () => {
          const previousContractEthBalance = await getEthBalance(leverageStrategyExtension.address);
          const previousOwnerEthBalance = await getEthBalance(owner.address);

          const txHash = await subject();
          const txReceipt = await ethers.provider.getTransactionReceipt(txHash.hash);
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

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(exchangeName);
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Max TWAP collateral units
            const expectedFirstPositionUnit = initialPositions[0].unit.sub(
              newIncentivizedMaxTradeSize,
            );

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });

          describe("when incentivized cooldown period has not elapsed", async () => {
            beforeEach(async () => {
              await subject();
              const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
              const newCollateralPrice = initialCollateralPrice.mul(2).div(10);
              await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("TWAP cooldown must have elapsed");
            });
          });
        });

        describe("when greater than max borrow", async () => {
          beforeEach(async () => {
            // Set to above max borrow
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(65).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should set the global last trade timestamp", async () => {
            await subject();

            const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should set the exchange's last trade timestamp", async () => {
            await subject();

            const exchangeSettings =
              await leverageStrategyExtension.getExchangeSettings(exchangeName);
            const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

            expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            const {
              collateralTotalBalance: previousCollateralBalance,
              borrowAssets: previousBorrowBalance,
            } = await getBorrowAndCollateralBalances();
            await subject();

            // wsteth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            const collateralPrice = await morphoOracle.price();
            const maxRedeemCollateral = calculateMaxBorrowForDeleverV3(
              previousCollateralBalance,
              collateralPrice,
              previousBorrowBalance,
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCollateral);
            console.log("expectedFirstPositionUnit", expectedFirstPositionUnit.toString());

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });
        });

        describe("when below incentivized leverage ratio threshold", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(2);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be above incentivized leverage ratio");
          });
        });

        describe("when borrow balance is 0", async () => {
          beforeEach(async () => {
            await usdc.approve(morpho.address, 10_000 * 10 ** 6);
            const position = await morpho.position(marketId, setToken.address);
            await morpho.repay(
              wstethUsdcMarketParams,
              0,
              position.borrowShares,
              setToken.address,
              EMPTY_BYTES,
            );
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
          // TODO: Review (see above)
          // beforeEach(async () => {
          //   await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          //   await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
          // });
          // it("should revert", async () => {
          //   await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
          // });
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
          // Withdraw balance of usdc from exchange contract from engage
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

          let initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          let newCollateralPrice = initialCollateralPrice.mul(99).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

          const sendTokenQuantity = BigNumber.from(500 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendTokenQuantity);

          // Start TWAP rebalance
          await leverageStrategyExtension.rebalance(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100));
          await usdc.transfer(tradeAdapterMock.address, sendTokenQuantity);

          // Set to above incentivized ratio
          initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          newCollateralPrice = initialCollateralPrice.mul(50).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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

          const exchangeSettings =
            await leverageStrategyExtension.getExchangeSettings(exchangeName);
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
          // Withdraw balance of usdc from exchange contract from engage
          await tradeAdapterMock.withdraw(usdc.address);
          await increaseTimeAsync(BigNumber.from(100000));

          // Set to above incentivized ratio
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          const sendTokenQuantity = BigNumber.from(1000 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendTokenQuantity);
          await usdc.transfer(tradeAdapterMock2.address, sendTokenQuantity);

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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(60).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

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
            ifEngaged = false;
            await intializeContracts();
            initializeSubjectVariables();
          });
          after(async () => {
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
            await wsteth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

            if (ifEngaged) {
              // Add allowed trader
              await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
              // Engage to initial leverage
              await leverageStrategyExtension.engage(subjectExchangeName);
              await increaseTimeAsync(BigNumber.from(100000));
              await wsteth.transfer(tradeAdapterMock.address, ether(0.5));
              await leverageStrategyExtension.iterateRebalance(subjectExchangeName);

              // Withdraw balance of usdc from exchange contract from engage
              await tradeAdapterMock.withdraw(usdc.address);
              const sendQuantity = BigNumber.from(2000 * 10 ** 6);
              await usdc.transfer(tradeAdapterMock.address, sendQuantity);
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

              // wsteth position is decreased
              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];

              // Max TWAP collateral units
              const expectedFirstPositionUnit = initialPositions[0].unit.sub(
                exchangeSettings.twapMaxTradeSize,
              );

              expect(initialPositions.length).to.eq(2);
              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(wsteth.address);
              expect(newFirstPosition.positionState).to.eq(1); // External
              expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
              expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
              expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
            });

            it("should update the borrow position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // wsteth position is increased
              const currentPositions = await setToken.getPositions();
              const newSecondPosition = (await setToken.getPositions())[1];

              expect(initialPositions.length).to.eq(2);
              expect(currentPositions.length).to.eq(2);
              expect(newSecondPosition.component).to.eq(usdc.address);
              expect(newSecondPosition.positionState).to.eq(1); // External
              expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
            });

            describe("when borrow balance is 0", async () => {
              beforeEach(async () => {
                await usdc.approve(morpho.address, 10_000 * 10 ** 6);
                const position = await morpho.position(marketId, setToken.address);
                await morpho.repay(
                  wstethUsdcMarketParams,
                  0,
                  position.borrowShares,
                  setToken.address,
                  EMPTY_BYTES,
                );
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Borrow balance must exist");
              });
            });

            // TODO: Review (see above)
            // describe("when SetToken has 0 supply", async () => {
            //   beforeEach(async () => {
            //     await usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
            //     await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
            //   });

            //   it("should revert", async () => {
            //     await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
            //   });
            // });

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
                ifEngaged = false;

                await intializeContracts();
                initializeSubjectVariables();
              });

              after(async () => {
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
            await wsteth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

            // Engage to initial leverage
            await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);
            await leverageStrategyExtension.engage(subjectExchangeName);
            await increaseTimeAsync(BigNumber.from(4000));
            await wsteth.transfer(tradeAdapterMock.address, ether(0.5));
            await leverageStrategyExtension.iterateRebalance(subjectExchangeName);

            // Clear balance of usdc from exchange contract from engage
            await tradeAdapterMock.withdraw(usdc.address);
            const sendQuantity = BigNumber.from(2500 * 10 ** 6);
            await usdc.transfer(tradeAdapterMock.address, sendQuantity);

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
            await usdcEthOrackeMock.setPrice(initialCollateralPriceInverted);

            subjectCaller = owner;

            const oldExecution = await leverageStrategyExtension.getExecution();
            const newExecution: ExecutionSettings = {
              unutilizedLeveragePercentage: oldExecution.unutilizedLeveragePercentage,
              twapCooldownPeriod: oldExecution.twapCooldownPeriod,
              slippageTolerance: ether(0.05),
            };
            await leverageStrategyExtension.setExecutionSettings(newExecution);
          });

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.disengage(subjectExchangeName);
          }

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            const {
              collateralTotalBalance: previousCollateralBalance,
              borrowAssets: previousBorrowBalance,
            } = await getBorrowAndCollateralBalances();

            const collateralPrice = await morphoOracle.price();

            await subject();

            // wsteth position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            const maxRedeemCollateral = calculateMaxBorrowForDeleverV3(
              previousCollateralBalance,
              collateralPrice,
              previousBorrowBalance,
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCollateral);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // wsteth position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];
            const { borrowAssets } = await getBorrowAndCollateralBalances();
            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(borrowAssets.mul(-1));
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
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
            await wsteth.approve(debtIssuanceModule.address, ether(1000));

            // Issue 1 SetToken
            const issueQuantity = ether(1);
            await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

            await wsteth.transfer(tradeAdapterMock.address, ether(0.25));

            // Engage to initial leverage
            await leverageStrategyExtension.engage(subjectExchangeName);

            // Withdraw balance of usdc from exchange contract from engage
            await tradeAdapterMock.withdraw(usdc.address);

            const { borrowAssets } = await getBorrowAndCollateralBalances();
            // Transfer more than the borrow balance to the exchange
            await usdc.transfer(tradeAdapterMock.address, borrowAssets.add(1_000_000));
            subjectCaller = owner;
          });

          async function subject(): Promise<any> {
            leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
            return leverageStrategyExtension.disengage(subjectExchangeName);
          }

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();

            const { collateralTotalBalance } = await getBorrowAndCollateralBalances();

            await subject();

            // cEther position is decreased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected cTokens redeemed
            const expectedCollateralAssetsRedeemed = calculateMaxRedeemForDeleverToZero(
              currentLeverageRatio,
              ether(1), // 1x leverage
              collateralTotalBalance,
              ether(1), // Total supply
              execution.slippageTolerance,
            );

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(
              expectedCollateralAssetsRedeemed,
            );
            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("should wipe out the debt on morpho", async () => {
            await subject();

            const { borrowAssets } = await getBorrowAndCollateralBalances();

            expect(borrowAssets).to.eq(ZERO);
          });

          it("should remove any external positions on the borrow asset", async () => {
            await subject();

            const borrowAssetExternalModules = await setToken.getExternalPositionModules(
              usdc.address,
            );
            const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
              usdc.address,
              morphoLeverageModule.address,
            );
            const isPositionModule = await setToken.isExternalPositionModule(
              usdc.address,
              morphoLeverageModule.address,
            );

            expect(borrowAssetExternalModules.length).to.eq(0);
            expect(borrowExternalUnit).to.eq(ZERO);
            expect(isPositionModule).to.eq(false);
          });

          it("should update the borrow asset equity on the SetToken correctly", async () => {
            await subject();

            // The usdc position is positive and represents equity
            const newSecondPosition = (await setToken.getPositions())[1];
            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(0); // Default
            expect(BigNumber.from(newSecondPosition.unit)).to.gt(ZERO);
            expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
          });
        },
      );
    });
    describe("#setOverrideNoRebalanceInProgress", async () => {
      let subjectOverrideNoRebalanceInProgress: boolean;
      let subjectCaller: Account;

      const initializeSubjectVariables = () => {
        subjectOverrideNoRebalanceInProgress = true;
        subjectCaller = owner;
      };

      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<any> {
        leverageStrategyExtension = leverageStrategyExtension.connect(subjectCaller.wallet);
        return leverageStrategyExtension.setOverrideNoRebalanceInProgress(
          subjectOverrideNoRebalanceInProgress,
        );
      }

      it("should set the flag correctly", async () => {
        await subject();
        const isOverride = await leverageStrategyExtension.overrideNoRebalanceInProgress();
        expect(isOverride).to.eq(subjectOverrideNoRebalanceInProgress);
      });

      describe("when caller is not the operator", () => {
        beforeEach(() => {
          subjectCaller = nonOwner;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
      describe("when disabling override", () => {
        beforeEach(async () => {
          subjectOverrideNoRebalanceInProgress = false;
          await leverageStrategyExtension
            .connect(owner.wallet)
            .setOverrideNoRebalanceInProgress(true);
        });
        it("should set the flag correctly", async () => {
          await subject();
          const isOverride = await leverageStrategyExtension.overrideNoRebalanceInProgress();
          expect(isOverride).to.eq(subjectOverrideNoRebalanceInProgress);
        });
      });
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

        describe("when targetLeverageRatio < 1 ", () => {
          beforeEach(() => {
            subjectMethodologySettings.targetLeverageRatio = ether(0.99);
            subjectMethodologySettings.minLeverageRatio = ether(0.89);
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Target leverage ratio must be >= 1e18");
          });
        });
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
          await wsteth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });

        describe("when OverrideNoRebalanceInProgress is set to true", () => {
          beforeEach(async () => {
            await leverageStrategyExtension.setOverrideNoRebalanceInProgress(true);
          });
          it("should set the correct methodology parameters", async () => {
            await subject();
            const methodology = await leverageStrategyExtension.getMethodology();

            expect(methodology.targetLeverageRatio).to.eq(
              subjectMethodologySettings.targetLeverageRatio,
            );
            expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
            expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
            expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
            expect(methodology.rebalanceInterval).to.eq(
              subjectMethodologySettings.rebalanceInterval,
            );
          });
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
          await wsteth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });

        describe("when OverrideNoRebalanceInProgress is set to true", () => {
          beforeEach(async () => {
            await leverageStrategyExtension.setOverrideNoRebalanceInProgress(true);
          });
          it("should set the correct execution parameters", async () => {
            await subject();
            const execution = await leverageStrategyExtension.getExecution();

            expect(execution.unutilizedLeveragePercentage).to.eq(
              subjectExecutionSettings.unutilizedLeveragePercentage,
            );
            expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
            expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
          });
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
          await wsteth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

          // Engage to initial leverage
          await leverageStrategyExtension.engage(exchangeName);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
        });
        describe("when OverrideNoRebalanceInProgress is set to true", () => {
          beforeEach(async () => {
            await leverageStrategyExtension.setOverrideNoRebalanceInProgress(true);
          });
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
          const txReceipt = await ethers.provider.getTransactionReceipt(txHash.hash);
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
          await wsteth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

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
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(65).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
          await usdcEthOrackeMock.setPrice(initialCollateralPriceInverted);
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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        await leverageStrategyExtension.iterateRebalance(exchangeName);
      });

      async function subject(): Promise<[string[], number[]]> {
        return leverageStrategyExtension.shouldRebalance();
      }

      context("when in the midst of a TWAP rebalance", async () => {
        cacheBeforeEach(async () => {
          // Withdraw balance of usdc from exchange contract from engage
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
          const sendQuantity = BigNumber.from(5 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendQuantity);

          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));

          await increaseTimeAsync(BigNumber.from(100000));
          await leverageStrategyExtension.rebalance(exchangeName);
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(90).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(90).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(85).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(140).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

        // Add allowed trader
        await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

        // Engage to initial leverage
        await leverageStrategyExtension.engage(exchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

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
          // Withdraw balance of usdc from exchange contract from engage
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
          const sendQuantity = BigNumber.from(5 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendQuantity);
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          await increaseTimeAsync(BigNumber.from(100000));
          await leverageStrategyExtension.rebalance(exchangeName);
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(90).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(90).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(85).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(140).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ONE);
          });
        });

        describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should not rebalance", async () => {
            const [exchangeNamesArray, shouldRebalanceArray] = await subject();

            expect(exchangeNamesArray[0]).to.eq(exchangeName);
            expect(shouldRebalanceArray[0]).to.eq(ZERO);
          });
        });

        describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
        await wsteth.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

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
        await wsteth.transfer(tradeAdapterMock.address, ether(0.5));

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
          // Withdraw balance of usdc from exchange contract from engage
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
          const sendQuantity = BigNumber.from(5 * 10 ** 6);
          await usdc.transfer(tradeAdapterMock.address, sendQuantity);
          const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
          const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
          await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          await increaseTimeAsync(BigNumber.from(100000));
          await leverageStrategyExtension.rebalance(exchangeName);
        });

        describe("when above incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to above incentivized ratio
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const newLeverageRatio = methodology.maxLeverageRatio;
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedTotalRebalance = await calculateTotalRebalanceNotional(
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(ether(0.002));
            expect(chunkRebalances[1]).to.gte(expectedTotalRebalance.sub(1));
            expect(chunkRebalances[1]).to.lte(expectedTotalRebalance.add(1));
          });
        });

        describe("when below incentivized leverage ratio", async () => {
          beforeEach(async () => {
            // Set to below incentivized ratio
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(90).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const newLeverageRatio = await leverageStrategyExtension.twapLeverageRatio();
            const expectedTotalRebalance = await calculateTotalRebalanceNotional(
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.eq(ether(0.001));
            // TODO: Had to add this rounding error tolerance, understand why
            expect(chunkRebalances[1]).to.gte(expectedTotalRebalance.sub(1));
            expect(chunkRebalances[1]).to.lte(expectedTotalRebalance.add(1));
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(80).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
          });

          it("should return correct total rebalance size and isLever boolean", async () => {
            const [chunkRebalances, sellAsset, buyAsset] = await subject();

            const newLeverageRatio = methodology.maxLeverageRatio;
            const currentLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
            const expectedTotalRebalance = await calculateTotalRebalanceNotional(
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.lte(expectedTotalRebalance.add(1));
            expect(chunkRebalances[0]).to.gte(expectedTotalRebalance.sub(1));
            expect(chunkRebalances[1]).to.eq(ether(0.002));
          });
        });

        describe("when between max and min leverage ratio", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(99).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const expectedTotalRebalance = await calculateTotalRebalanceNotional(
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
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(85).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const expectedTotalRebalance = await calculateTotalRebalanceNotional(
              currentLeverageRatio,
              newLeverageRatio,
            );

            expect(sellAsset).to.eq(strategy.collateralAsset);
            expect(buyAsset).to.eq(strategy.borrowAsset);
            expect(chunkRebalances[0]).to.gte(expectedTotalRebalance.sub(1));
            expect(chunkRebalances[0]).to.lte(expectedTotalRebalance.add(1));
            expect(chunkRebalances[1]).to.eq(ether(0.001));
          });
        });

        describe("when below min leverage ratio", async () => {
          beforeEach(async () => {
            const initialCollateralPrice = ether(1).div(initialCollateralPriceInverted);
            const newCollateralPrice = initialCollateralPrice.mul(140).div(100);
            await usdcEthOrackeMock.setPrice(ether(1).div(newCollateralPrice));
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
            const totalCollateralRebalance = await calculateTotalRebalanceNotional(
              currentLeverageRatio,
              newLeverageRatio,
            );
            // Multiply collateral by conversion rate
            const currentCollateralPrice = (await morphoOracle.price()).div(ether(1));
            const expectedTotalRebalance = preciseMul(
              totalCollateralRebalance,
              currentCollateralPrice,
            );

            expect(sellAsset).to.eq(strategy.borrowAsset);
            expect(buyAsset).to.eq(strategy.collateralAsset);
            expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
            expect(chunkRebalances[1]).to.eq(preciseMul(ether(0.001), currentCollateralPrice));
          });
        });
      });
    });
  });
}
