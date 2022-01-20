import "module-alias/register";

import {
  Address,
  Account,
  ContractSettings,
  ExchangeSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
} from "@utils/types";
import {
  ADDRESS_ZERO,
  ZERO,
  EMPTY_BYTES,
  MAX_INT_256,
  MAX_UINT_96,
  MAX_UINT_256,
  PRECISE_UNIT,
  ONE_DAY_IN_SECONDS,
  ONE_HOUR_IN_SECONDS,
} from "@utils/constants";
import {
  ChainlinkAggregatorV3Mock,
  ExchangeIssuanceLeveraged,
  FlexibleLeverageStrategyExtension,
  BaseManagerV2,
  StandardTokenMock,
  WETH9,
} from "@utils/contracts/index";
import { UniswapV2Factory, UniswapV2Router02 } from "@utils/contracts/uniswap";
import { CompoundLeverageModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  cacheBeforeEach,
  ether,
  getAaveV2Fixture,
  getAccounts,
  getCompoundFixture,
  getLastBlockTimestamp,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
  preciseMul,
  usdc,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { AaveV2Fixture, CompoundFixture, SetFixture, UniswapFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { getAllowances } from "@utils/common/exchangeIssuanceUtils";
import { UniswapV2Pair } from "@typechain/UniswapV2Pair";

interface CheckpointSettings {
  issueAmount: BigNumber;
  redeemAmount: BigNumber;
  collateralPrice: BigNumber;
  borrowPrice: BigNumber;
  wethPrice: BigNumber;
  elapsedTime: BigNumber;
  exchangeName: string;
  exchangePools: UniswapV2Pair[];
  router: UniswapV2Router02;
}

interface FLISettings {
  name: string;
  collateralAsset: StandardTokenMock | WETH9;
  borrowAsset: StandardTokenMock | WETH9;
  chainlinkCollateral: ChainlinkAggregatorV3Mock;
  chainlinkBorrow: ChainlinkAggregatorV3Mock;
  collateralCToken: CEther | CERc20;
  borrowCToken: CEther | CERc20;
  targetLeverageRatio: BigNumber;
  collateralPerSet: BigNumber;
  exchangeNames: string[];
  exchanges: ExchangeSettings[];
  checkpoints: CheckpointSettings[];
}
const expect = getWaffleExpect();

// Across scenario constants
const minLeverageBuffer = ether(0.15);
const maxLeverageBuffer = ether(0.15);
const recenteringSpeed = ether(0.05);
const rebalanceInterval = BigNumber.from(86400);

const unutilizedLeveragePercentage = ether(0.01);
const twapCooldownPeriod = BigNumber.from(3000);
const slippageTolerance = ether(0.02);

const incentivizedTwapCooldownPeriod = BigNumber.from(60);
const incentivizedSlippageTolerance = ether(0.05);
const etherReward = ether(1);
const incentivizedLeverageRatio = ether(2.6);

// This integration test is sensitive to pool ratios and needs
// to skip some initialization done for other suites.
const minimumInit = true;

describe("ExchangeIssuanceLeveraged", async () => {
  let owner: Account;
  let user: Account;
  let externalPositionModule: Account;
  let methodologist: Account;

  let setV2Setup: SetFixture;
  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let fliToken: SetToken;
  let setTokenWithWeth: SetToken;

  let exchangeIssuance: ExchangeIssuanceLeveraged;

  let compoundSetup: CompoundFixture;
  let compoundLeverageModule: CompoundLeverageModule;
  let flexibleLeverageStrategyExtension: FlexibleLeverageStrategyExtension;
  let baseManager: BaseManagerV2;
  let cEther: CEther;
  let cUSDC: CERc20;
  let cWBTC: CERc20;

  let strategy: ContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;

  let wethUsdcPoolUni: UniswapV2Pair;
  let wethUsdcPoolSushi: UniswapV2Pair;

  let chainlinkETH: ChainlinkAggregatorV3Mock;
  let chainlinkUSDC: ChainlinkAggregatorV3Mock;

  let fliSettings: FLISettings;

  async function deployChainlinkMocks(): Promise<void> {
    chainlinkETH = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkETH.setPrice(BigNumber.from(1000).mul(10 ** 8));
    chainlinkUSDC = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkUSDC.setPrice(10 ** 8);
  }

  async function setupExchanges(): Promise<void> {
    console.log("Initialize Uniswap");
    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(
      owner,
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address,
      minimumInit,
    );

    console.log("Initialize Sushiswap");
    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(
      owner,
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address,
      minimumInit,
    );

    console.log("Create weth-usdc uniswap pair");
    wethUsdcPoolUni = await uniswapSetup.createNewPair(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
    );

    console.log("Create weth-usdc sushiswap pair");
    wethUsdcPoolSushi = await sushiswapSetup.createNewPair(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
    );

    console.log("Add Liquidity on uni");
    await setV2Setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(10000),
      usdc(10000000),
      ether(9999),
      usdc(9990000),
      owner.address,
      MAX_UINT_256,
    );

    console.log("Add Liquidity on sushi");
    await setV2Setup.weth
      .connect(owner.wallet)
      .approve(sushiswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc
      .connect(owner.wallet)
      .approve(sushiswapSetup.router.address, MAX_UINT_256);
    await sushiswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(4000),
      usdc(4000000),
      ether(399),
      usdc(499000),
      owner.address,
      MAX_UINT_256,
    );
  }
  async function setupCompound(): Promise<void> {
    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    cEther = await compoundSetup.createAndEnableCEther(
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000), // $1000
    );

    cUSDC = await compoundSetup.createAndEnableCToken(
      setV2Setup.usdc.address,
      200000000000000,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound USDC",
      "cUSDC",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000000000000), // IMPORTANT: Compound oracles account for decimals scaled by 10e18. For USDC, this is $1 * 10^18 * 10^18 / 10^6 = 10^30
    );

    cWBTC = await compoundSetup.createAndEnableCToken(
      setV2Setup.wbtc.address,
      ether(0.02),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound WBTC",
      "cWBTC",
      8,
      ether(0.75),
      ether(500000000000000), // $50,000
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address, cWBTC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
    await setV2Setup.wbtc.approve(cWBTC.address, ether(100000));
    await cUSDC.mint(ether(1));
    await cWBTC.mint(ether(1));
    await cEther.mint({ value: ether(1000) });

    // Deploy Compound leverage module and add to controller
    compoundLeverageModule = await deployer.setV2.deployCompoundLeverageModule(
      setV2Setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setV2Setup.weth.address,
    );
    await setV2Setup.controller.addModule(compoundLeverageModule.address);

    // Set integrations for CompoundLeverageModule
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "UniswapTradeAdapter",
      uniswapSetup.uniswapTradeAdapter.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "SushiswapTradeAdapter",
      sushiswapSetup.uniswapTradeAdapter.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      setV2Setup.debtIssuanceModule.address,
    );
  }

  async function deployFLISetup(): Promise<void> {
    console.log("Deploying FLI Strategy and SetToken...");

    const unit = preciseMul(bitcoin(50), fliSettings.collateralPerSet); // User bitcoin(50) because a full unit of underlying is 50*10^8
    console.log("Creating Set Token");
    fliToken = await setV2Setup.createSetToken(
      [fliSettings.collateralCToken.address],
      [unit],
      [
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        setV2Setup.debtIssuanceModule.address,
      ],
    );
    await compoundLeverageModule.updateAnySetAllowed(true);

    console.log("Initializing DI module");
    // Initialize modules
    await setV2Setup.debtIssuanceModule.initialize(
      fliToken.address,
      ether(1),
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO,
    );
    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(0.1);
    const streamingFeePercentage = ether(0.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    console.log("Initializing Streaming fee module");
    await setV2Setup.streamingFeeModule.initialize(fliToken.address, streamingFeeSettings);
    console.log(
      "Initializing Compound Leverage Module",
      compoundLeverageModule.address,
      fliToken.address,
    );
    await compoundLeverageModule.initialize(
      fliToken.address,
      [fliSettings.collateralAsset.address],
      [fliSettings.borrowAsset.address],
    );

    console.log("Deploy Base Manager");
    baseManager = await deployer.manager.deployBaseManagerV2(
      fliToken.address,
      owner.address,
      methodologist.address,
    );
    await baseManager.connect(methodologist.wallet).authorizeInitialization();

    console.log("Set base manager");
    // Transfer ownership to ic manager
    await fliToken.setManager(baseManager.address);

    console.log("Define strategy");
    strategy = {
      setToken: fliToken.address,
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      collateralPriceOracle: fliSettings.chainlinkCollateral.address,
      borrowPriceOracle: fliSettings.chainlinkBorrow.address,
      targetCollateralCToken: fliSettings.collateralCToken.address,
      targetBorrowCToken: fliSettings.borrowCToken.address,
      collateralAsset: fliSettings.collateralAsset.address,
      borrowAsset: fliSettings.borrowAsset.address,
      collateralDecimalAdjustment: BigNumber.from(
        28 - (await fliSettings.collateralAsset.decimals()),
      ),
      borrowDecimalAdjustment: BigNumber.from(28 - (await fliSettings.borrowAsset.decimals())),
    };

    console.log("Define methodology");
    methodology = {
      targetLeverageRatio: fliSettings.targetLeverageRatio,
      minLeverageRatio: preciseMul(
        fliSettings.targetLeverageRatio,
        PRECISE_UNIT.sub(minLeverageBuffer),
      ),
      maxLeverageRatio: preciseMul(
        fliSettings.targetLeverageRatio,
        PRECISE_UNIT.add(maxLeverageBuffer),
      ),
      recenteringSpeed: recenteringSpeed,
      rebalanceInterval: rebalanceInterval,
    };
    console.log("Define execution");
    execution = {
      unutilizedLeveragePercentage: unutilizedLeveragePercentage,
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
    };
    console.log("Define incentive");
    incentive = {
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };

    console.log("Deploy FLI extension");
    flexibleLeverageStrategyExtension = await deployer.extensions.deployFlexibleLeverageStrategyExtension(
      baseManager.address,
      strategy,
      methodology,
      execution,
      incentive,
      fliSettings.exchangeNames,
      fliSettings.exchanges,
    );
    await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    await fliSettings.collateralCToken.approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
    const amount = ether(1);
    console.log("Issue fli token");
    await setV2Setup.debtIssuanceModule.issue(fliToken.address, amount, owner.address);
    await baseManager.addExtension(flexibleLeverageStrategyExtension.address);
    console.log("Engage fli extension");
    await flexibleLeverageStrategyExtension.engage(fliSettings.exchangeNames[0]);
  }

  cacheBeforeEach(async () => {
    [owner, user, externalPositionModule, methodologist] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    const daiUnits = BigNumber.from("23252699054621733");
    const wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(0.1),
      ether(0),
      ether(0),
      owner.address,
      ADDRESS_ZERO,
    );

    const wethUnits = ether(0.5);
    setTokenWithWeth = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.weth.address],
      [daiUnits, wethUnits],
      [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.debtIssuanceModule.initialize(
      setTokenWithWeth.address,
      ether(0.1),
      ether(0),
      ether(0),
      owner.address,
      ADDRESS_ZERO,
    );

    await deployChainlinkMocks();
    await setupExchanges();
    await setupCompound();

    fliSettings = {
      name: "ETH/USDC 2x",
      collateralAsset: setV2Setup.weth,
      borrowAsset: setV2Setup.usdc,
      collateralCToken: cEther,
      borrowCToken: cUSDC,
      chainlinkCollateral: chainlinkETH,
      chainlinkBorrow: chainlinkUSDC,
      targetLeverageRatio: ether(2),
      collateralPerSet: ether(1),
      exchangeNames: ["UniswapTradeAdapter", "SushiswapTradeAdapter"],
      exchanges: [
        {
          exchangeLastTradeTimestamp: BigNumber.from(0),
          twapMaxTradeSize: ether(5),
          incentivizedTwapMaxTradeSize: ether(10),
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        },
        {
          exchangeLastTradeTimestamp: BigNumber.from(0),
          twapMaxTradeSize: ether(5),
          incentivizedTwapMaxTradeSize: ether(10),
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        },
      ],
      checkpoints: [
        {
          issueAmount: ZERO,
          redeemAmount: ZERO,
          collateralPrice: ether(1000),
          borrowPrice: ether(1),
          elapsedTime: ONE_DAY_IN_SECONDS,
          wethPrice: ether(1000),
          exchangeName: "UniswapTradeAdapter",
          exchangePools: [wethUsdcPoolUni],
          router: uniswapSetup.router,
        },
        {
          issueAmount: ZERO,
          redeemAmount: ZERO,
          collateralPrice: ether(1100),
          borrowPrice: ether(1),
          elapsedTime: ONE_DAY_IN_SECONDS,
          wethPrice: ether(1100),
          exchangeName: "SushiswapTradeAdapter",
          exchangePools: [wethUsdcPoolSushi],
          router: sushiswapSetup.router,
        },
        {
          issueAmount: ZERO,
          redeemAmount: ZERO,
          collateralPrice: ether(800),
          borrowPrice: ether(1),
          elapsedTime: ONE_HOUR_IN_SECONDS.mul(12),
          wethPrice: ether(800),
          exchangeName: "UniswapTradeAdapter",
          exchangePools: [wethUsdcPoolUni],
          router: uniswapSetup.router,
        },
      ],
    };
    await deployFLISetup();
  });

  describe("#constructor", async () => {
    let wethAddress: Address;
    let uniswapFactory: UniswapV2Factory;
    let uniswapRouter: UniswapV2Router02;
    let sushiswapFactory: UniswapV2Factory;
    let sushiswapRouter: UniswapV2Router02;
    let controllerAddress: Address;
    let debtIssuanceModuleAddress: Address;
    let addressProviderAddress: Address;

    cacheBeforeEach(async () => {
      let uniswapSetup: UniswapFixture;
      let sushiswapSetup: UniswapFixture;
      let aaveV2Setup: AaveV2Fixture;
      let wbtcAddress: Address;
      let daiAddress: Address;

      wethAddress = setV2Setup.weth.address;
      wbtcAddress = setV2Setup.wbtc.address;
      daiAddress = setV2Setup.dai.address;

      uniswapSetup = getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

      aaveV2Setup = getAaveV2Fixture(owner.address);
      await aaveV2Setup.initialize(wethAddress, daiAddress);

      sushiswapSetup = getUniswapFixture(owner.address);
      await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

      uniswapFactory = uniswapSetup.factory;
      uniswapRouter = uniswapSetup.router;
      sushiswapFactory = sushiswapSetup.factory;
      sushiswapRouter = sushiswapSetup.router;
      controllerAddress = setV2Setup.controller.address;
      debtIssuanceModuleAddress = setV2Setup.debtIssuanceModule.address;
      addressProviderAddress = aaveV2Setup.lendingPoolAddressesProvider.address;
    });

    async function subject(): Promise<ExchangeIssuanceLeveraged> {
      return await deployer.extensions.deployExchangeIssuanceLeveraged(
        wethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        addressProviderAddress,
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceLeveraged = await subject();

      const expectedWethAddress = await exchangeIssuanceContract.WETH();
      expect(expectedWethAddress).to.eq(wethAddress);

      const expectedUniRouterAddress = await exchangeIssuanceContract.uniRouter();
      expect(expectedUniRouterAddress).to.eq(uniswapRouter.address);

      const expectedUniFactoryAddress = await exchangeIssuanceContract.uniFactory();
      expect(expectedUniFactoryAddress).to.eq(uniswapFactory.address);

      const expectedSushiRouterAddress = await exchangeIssuanceContract.sushiRouter();
      expect(expectedSushiRouterAddress).to.eq(sushiswapRouter.address);

      const expectedSushiFactoryAddress = await exchangeIssuanceContract.sushiFactory();
      expect(expectedSushiFactoryAddress).to.eq(sushiswapFactory.address);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(controllerAddress);

      const expectedDebtIssuanceModuleAddress = await exchangeIssuanceContract.debtIssuanceModule();
      expect(expectedDebtIssuanceModuleAddress).to.eq(debtIssuanceModuleAddress);
    });

    it("approves WETH to the uniswap and sushiswap router", async () => {
      const exchangeIssuance: ExchangeIssuanceLeveraged = await subject();

      // validate the allowance of WETH between uniswap, sushiswap, and the deployed exchange issuance contract
      const uniswapWethAllowance = await setV2Setup.weth.allowance(
        exchangeIssuance.address,
        uniswapRouter.address,
      );
      expect(uniswapWethAllowance).to.eq(MAX_UINT_256);

      const sushiswapWethAllownace = await setV2Setup.weth.allowance(
        exchangeIssuance.address,
        sushiswapRouter.address,
      );
      expect(sushiswapWethAllownace).to.eq(MAX_UINT_256);
    });
  });

  context("when exchange issuance is deployed", async () => {
    let subjectWethAddress: Address;
    let uniswapFactory: UniswapV2Factory;
    let uniswapRouter: UniswapV2Router02;
    let sushiswapFactory: UniswapV2Factory;
    let sushiswapRouter: UniswapV2Router02;
    let controllerAddress: Address;
    let debtIssuanceModuleAddress: Address;
    let addressProviderAddress: Address;

    let weth: WETH9;
    let wbtc: StandardTokenMock;
    let dai: StandardTokenMock;
    let usdc: StandardTokenMock;
    let illiquidToken: StandardTokenMock;
    let setTokenIlliquid: SetToken;
    let setTokenExternal: SetToken;
    let aaveV2Setup: AaveV2Fixture;

    cacheBeforeEach(async () => {
      let uniswapSetup: UniswapFixture;
      let sushiswapSetup: UniswapFixture;

      weth = setV2Setup.weth;
      wbtc = setV2Setup.wbtc;
      dai = setV2Setup.dai;
      usdc = setV2Setup.usdc;
      illiquidToken = await deployer.setV2.deployTokenMock(
        owner.address,
        ether(1000000),
        18,
        "illiquid token",
        "RUGGED",
      );

      usdc.transfer(user.address, UnitsUtils.usdc(10000));
      weth.transfer(user.address, UnitsUtils.ether(1000));

      const daiUnits = ether(0.5);
      const illiquidTokenUnits = ether(0.5);
      setTokenIlliquid = await setV2Setup.createSetToken(
        [setV2Setup.dai.address, illiquidToken.address],
        [daiUnits, illiquidTokenUnits],
        [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.debtIssuanceModule.initialize(
        setTokenIlliquid.address,
        ether(0.1),
        ether(0),
        ether(0),
        owner.address,
        ADDRESS_ZERO,
      );

      setTokenExternal = await setV2Setup.createSetToken(
        [setV2Setup.dai.address],
        [ether(0.5)],
        [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.debtIssuanceModule.initialize(
        setTokenExternal.address,
        ether(0.1),
        ether(0),
        ether(0),
        owner.address,
        ADDRESS_ZERO,
      );

      const controller = setV2Setup.controller;
      await controller.addModule(externalPositionModule.address);
      await setTokenExternal.addModule(externalPositionModule.address);
      await setTokenExternal.connect(externalPositionModule.wallet).initializeModule();

      await setTokenExternal
        .connect(externalPositionModule.wallet)
        .addExternalPositionModule(dai.address, externalPositionModule.address);

      uniswapSetup = await getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, weth.address, wbtc.address, dai.address);
      sushiswapSetup = await getUniswapFixture(owner.address);
      await sushiswapSetup.initialize(owner, weth.address, wbtc.address, dai.address);

      aaveV2Setup = getAaveV2Fixture(owner.address);
      await aaveV2Setup.initialize(weth.address, dai.address);

      subjectWethAddress = weth.address;
      uniswapFactory = uniswapSetup.factory;
      uniswapRouter = uniswapSetup.router;
      sushiswapFactory = sushiswapSetup.factory;
      sushiswapRouter = sushiswapSetup.router;
      controllerAddress = setV2Setup.controller.address;
      debtIssuanceModuleAddress = setV2Setup.debtIssuanceModule.address;
      addressProviderAddress = aaveV2Setup.lendingPoolAddressesProvider.address;

      await sushiswapSetup.createNewPair(weth.address, wbtc.address);
      await uniswapSetup.createNewPair(weth.address, dai.address);
      await uniswapSetup.createNewPair(weth.address, usdc.address);

      // ETH-WBTC pools
      await wbtc.approve(uniswapRouter.address, MAX_UINT_256);
      await uniswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          wbtc.address,
          UnitsUtils.wbtc(100000),
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(100), gasLimit: 9000000 },
        );

      // cheaper wbtc compared to uniswap
      await wbtc.approve(sushiswapRouter.address, MAX_UINT_256);
      await sushiswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          wbtc.address,
          UnitsUtils.wbtc(200000),
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(100), gasLimit: 9000000 },
        );

      // ETH-DAI pools
      await dai.approve(uniswapRouter.address, MAX_INT_256);
      await uniswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          dai.address,
          ether(100000),
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(10), gasLimit: 9000000 },
        );

      // ETH-USDC pools
      await usdc.connect(owner.wallet).approve(uniswapRouter.address, MAX_INT_256);
      await uniswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          usdc.address,
          UnitsUtils.usdc(100000),
          MAX_UINT_256,
          MAX_UINT_256,
          user.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(100), gasLimit: 9000000 },
        );

      exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
        subjectWethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        addressProviderAddress,
      );
    });

    describe("#approveToken", async () => {
      let subjectTokenToApprove: StandardTokenMock;

      beforeEach(async () => {
        subjectTokenToApprove = setV2Setup.dai;
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approveToken(subjectTokenToApprove.address);
      }

      it("should update the approvals correctly", async () => {
        const spenders = [
          uniswapRouter.address,
          sushiswapRouter.address,
          debtIssuanceModuleAddress,
        ];
        const tokens = [subjectTokenToApprove];

        await subject();

        const finalAllowances = await getAllowances(tokens, exchangeIssuance.address, spenders);

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });
    });

    describe("#approveTokens", async () => {
      let subjectTokensToApprove: StandardTokenMock[];

      beforeEach(async () => {
        subjectTokensToApprove = [setV2Setup.dai, setV2Setup.wbtc];
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approveTokens(
          subjectTokensToApprove.map(token => token.address),
        );
      }

      it("should update the approvals correctly", async () => {
        const spenders = [
          uniswapRouter.address,
          sushiswapRouter.address,
          debtIssuanceModuleAddress,
        ];

        await subject();

        const finalAllowances = await getAllowances(
          subjectTokensToApprove,
          exchangeIssuance.address,
          spenders,
        );

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });
    });

    describe("#approveSetToken", async () => {
      let subjectSetToApprove: SetToken | StandardTokenMock;

      beforeEach(async () => {
        subjectSetToApprove = setToken;
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approveSetToken(subjectSetToApprove.address);
      }

      it("should update the approvals correctly", async () => {
        const tokens = [dai, wbtc];
        const spenders = [
          uniswapRouter.address,
          sushiswapRouter.address,
          debtIssuanceModuleAddress,
        ];

        await subject();

        const finalAllowances = await getAllowances(tokens, exchangeIssuance.address, spenders);

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });

      context("when the input token is not a set", async () => {
        beforeEach(async () => {
          subjectSetToApprove = usdc;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET");
        });
      });

      context("when the set contains an external position", async () => {
        beforeEach(async () => {
          subjectSetToApprove = setTokenExternal;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED",
          );
        });
      });
    });

    describe("#flashloan", async () => {
      let subjectAssets: Address[];
      let subjectAmounts: BigNumber[];
      let availableTokenBalance: BigNumber;
      beforeEach(async () => {
        await setV2Setup.dai.approve(aaveV2Setup.lendingPool.address, MAX_UINT_256);
        await aaveV2Setup.lendingPool.deposit(dai.address, ether(1000), owner.address, 0);
        console.log("Dai a token supply", await aaveV2Setup.daiReserveTokens.aToken.totalSupply());
        availableTokenBalance = UnitsUtils.ether(10);
        subjectAssets = [dai.address];
        subjectAmounts = [availableTokenBalance.div(2)];
      });
      async function subject() {
        return await exchangeIssuance.flashloan(subjectAssets, subjectAmounts);
      }
      context("when the ei module does not have enough token to pay fees", async () => {
        it("should emit", async () => {
          await expect(subject()).to.be.revertedWith("SafeERC20: low-level call failed");
        });
      });
      context("when the ei module has enough token to pay fees", async () => {
        beforeEach(async () => {
          await dai.transfer(exchangeIssuance.address, availableTokenBalance);
        });
        it("should emit Flashloan event", async () => {
          await expect(subject()).to.emit(aaveV2Setup.lendingPool, "FlashLoan");
        });
      });
    });

    describe("#getLeveragedTokenData", async () => {
      let subjectSetToken: Address;
      let subjectSetAmount: BigNumber;
      async function subject() {
        return await exchangeIssuance.getLeveragedTokenData(subjectSetToken, subjectSetAmount);
      }
      context("when passed the FLI token", async () => {
        before(() => {
          subjectSetToken = fliToken.address;
          subjectSetAmount = ether(1);
        });
        it("should return correct data", async () => {
          const rawData = await setV2Setup.debtIssuanceModule.getRequiredComponentIssuanceUnits(
            subjectSetToken,
            subjectSetAmount,
          );
          console.log("rawData", rawData);
          const { longToken, shortToken, longAmount, shortAmount } = await subject();
          expect(longToken).to.eq(fliSettings.collateralCToken.address);
          expect(shortToken).to.eq(fliSettings.borrowAsset.address);
          console.log("Long Amount", longAmount.toString());
          console.log("Short Amount", shortAmount.toString());
          expect(longAmount).to.be.gt(ZERO);
          expect(shortAmount).to.be.gt(ZERO);
        });
      });
    });

    describe("#issueExactSetForLongToken", async () => {
      let subjectSetToken: Address;
      let subjectSetAmount: BigNumber;
      async function subject() {
        return await exchangeIssuance.issueExactSetForLongToken(subjectSetToken, subjectSetAmount);
      }
      beforeEach(async () => {
        const usdcPriceInEth = ether(0.001);

        // set initial asset prices in ETH
        await aaveV2Setup.setAssetPriceInOracle(usdc.address, usdcPriceInEth);

        // As per Aave's interest rate model, if U < U_optimal, R_t = R_0 + (U_t/U_optimal) * R_slope1, when U_t = 0, R_t = R_0
        // R_0 is the interest rate when utilization is 0 (it's the intercept for the above linear equation)
        // And for higher precision it is expressed in Rays
        const oneRay = BigNumber.from(10).pow(27); // 1e27

        await aaveV2Setup.setMarketBorrowRate(usdc.address, oneRay.mul(39).div(1000));

        // Deploy and configure USDC reserve
        await aaveV2Setup.createAndEnableReserve(
          usdc.address,
          "USDC",
          BigNumber.from(18),
          BigNumber.from(7500), // base LTV: 75%
          BigNumber.from(8000), // liquidation threshold: 80%
          BigNumber.from(10500), // liquidation bonus: 105.00%
          BigNumber.from(1000), // reserve factor: 10%
          true, // enable borrowing on reserve
          true, // enable stable debts
        );

        const { shortAmount } = await exchangeIssuance.getLeveragedTokenData(
          subjectSetToken,
          subjectSetAmount,
        );

        await usdc.approve(aaveV2Setup.lendingPool.address, MAX_UINT_256);
        console.log("Depositing short token");
        await aaveV2Setup.lendingPool.deposit(usdc.address, shortAmount.mul(2), owner.address, 0);
        console.log("Deposited short token");
        await usdc.transfer(exchangeIssuance.address, shortAmount.div(2));
        console.log("Sent some usdc to ei contract");
      });
      context("when passed the FLI token", async () => {
        before(() => {
          subjectSetToken = fliToken.address;
          subjectSetAmount = ether(1);
        });
        it("should succeed", async () => {
          await subject();
        });
      });
    });
  });
});
