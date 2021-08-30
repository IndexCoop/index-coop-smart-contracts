import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { defaultAbiCoder } from "ethers/lib/utils";

import {
  Account,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings,
  AaveContractSettings
} from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE, TWO, EMPTY_BYTES, MAX_UINT_256, PRECISE_UNIT, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import { AaveLeverageStrategyExtension, BaseManager, StandardTokenMock, WETH9, ChainlinkAggregatorV3Mock } from "@utils/contracts/index";
import { AaveLeverageModule, SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bitcoin,
  ether,
  getAccounts,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
  getLastBlockTimestamp,
  increaseTimeAsync,
  preciseDiv,
  preciseMul,
  usdc,
  getAaveV2Fixture
} from "@utils/index";
import { AaveV2Fixture, SetFixture, UniswapFixture } from "@utils/fixtures";
import { UniswapV2Pair } from "@typechain/UniswapV2Pair";
import { UniswapV2Router02 } from "@typechain/UniswapV2Router02";
import { AaveV2AToken } from "@typechain/AaveV2AToken";
import { AaveV2VariableDebtToken } from "@typechain/AaveV2VariableDebtToken";

const expect = getWaffleExpect();

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
  collateralAToken: AaveV2AToken;
  borrowDebtToken: AaveV2VariableDebtToken;
  targetLeverageRatio: BigNumber;
  collateralPerSet: BigNumber;
  exchangeNames: string[];
  exchanges: ExchangeSettings[];
  checkpoints: CheckpointSettings[];
}

// Across scenario constants
const minLeverageBuffer = ether(.15);
const maxLeverageBuffer = ether(.15);
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

describe("LeverageStrategyExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let aaveSetup: AaveV2Fixture;
  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let aWETH: AaveV2AToken;
  let aUSDC: AaveV2AToken;
  let aWBTC: AaveV2AToken;
  let wethVariableDebtToken: AaveV2VariableDebtToken;
  let usdcVariableDebtToken: AaveV2VariableDebtToken;

  let strategy: AaveContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;

  let leverageStrategyExtension: AaveLeverageStrategyExtension;
  let aaveLeverageModule: AaveLeverageModule;
  let baseManager: BaseManager;

  let chainlinkETH: ChainlinkAggregatorV3Mock;
  let chainlinkWBTC: ChainlinkAggregatorV3Mock;
  let chainlinkUSDC: ChainlinkAggregatorV3Mock;

  let wethUsdcPoolUni: UniswapV2Pair;
  let wethWbtcPoolUni: UniswapV2Pair;
  let wethUsdcPoolSushi: UniswapV2Pair;
  let wethWbtcPoolSushi: UniswapV2Pair;

  let scenarios: FLISettings[];

  before(async () => {
    [
      owner,
      methodologist,
    ] = await getAccounts();

    console.log("Deploying Base Protocols...");

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setV2Setup.weth.address, setV2Setup.dai.address);

    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(
      owner,
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address,
      minimumInit
    );

    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(
      owner,
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address,
      minimumInit
    );

    wethUsdcPoolUni = await uniswapSetup.createNewPair(setV2Setup.weth.address, setV2Setup.usdc.address);
    wethWbtcPoolUni = await uniswapSetup.createNewPair(setV2Setup.weth.address, setV2Setup.wbtc.address);

    wethUsdcPoolSushi = await sushiswapSetup.createNewPair(setV2Setup.weth.address, setV2Setup.usdc.address);
    wethWbtcPoolSushi = await sushiswapSetup.createNewPair(setV2Setup.weth.address, setV2Setup.wbtc.address);

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
      MAX_UINT_256
    );

    await setV2Setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.wbtc.address,
      setV2Setup.weth.address,
      bitcoin(100),
      ether(4000),
      bitcoin(99),
      ether(3900),
      owner.address,
      MAX_UINT_256
    );

    await setV2Setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc.connect(owner.wallet).approve(sushiswapSetup.router.address, MAX_UINT_256);
    await sushiswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(4000),
      usdc(4000000),
      ether(399),
      usdc(499000),
      owner.address,
      MAX_UINT_256
    );

    await setV2Setup.wbtc.connect(owner.wallet).approve(sushiswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, MAX_UINT_256);
    await sushiswapSetup.router.addLiquidity(
      setV2Setup.wbtc.address,
      setV2Setup.weth.address,
      bitcoin(50),
      ether(2000),
      bitcoin(49),
      ether(1900),
      owner.address,
      MAX_UINT_256
    );

    const usdcReserveTokens = await aaveSetup.createAndEnableReserve(
      setV2Setup.usdc.address,
      "USDC",
      6,
      BigNumber.from(7500),   // base LTV: 75%
      BigNumber.from(8000),   // liquidation threshold: 80%
      BigNumber.from(10500),  // liquidation bonus: 105.00%
      BigNumber.from(1000),   // reserve factor: 10%
      true,					          // enable borrowing on reserve
      true					          // enable stable debts
    );

    const wbtcReserveTokens = await aaveSetup.createAndEnableReserve(
      setV2Setup.wbtc.address,
      "wBTC",
      8,
      BigNumber.from(7500),   // base LTV: 75%
      BigNumber.from(8000),   // liquidation threshold: 80%
      BigNumber.from(10500),  // liquidation bonus: 105.00%
      BigNumber.from(1000),   // reserve factor: 10%
      true,					          // enable borrowing on reserve
      true					          // enable stable debts
    );


    aUSDC = usdcReserveTokens.aToken;
    aWBTC = wbtcReserveTokens.aToken;
    aWETH = aaveSetup.wethReserveTokens.aToken;

    usdcVariableDebtToken = usdcReserveTokens.variableDebtToken;
    wethVariableDebtToken = aaveSetup.wethReserveTokens.variableDebtToken;

    const oneRay = BigNumber.from(10).pow(27);	// 1e27
    await aaveSetup.setMarketBorrowRate(setV2Setup.usdc.address, oneRay.mul(39).div(1000));
    await aaveSetup.setAssetPriceInOracle(setV2Setup.usdc.address, ether(0.001));
    await aaveSetup.setMarketBorrowRate(setV2Setup.wbtc.address, oneRay.mul(39).div(1000));
    await aaveSetup.setAssetPriceInOracle(setV2Setup.wbtc.address, ether(50));

    // Mint aTokens
    await setV2Setup.weth.approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool.deposit(setV2Setup.weth.address, ether(10000), owner.address, 0);
    await setV2Setup.usdc.approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool.deposit(setV2Setup.usdc.address, usdc(200000000), owner.address, 0);
    await setV2Setup.wbtc.approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool.deposit(setV2Setup.wbtc.address, bitcoin(1000), owner.address, 0);

    // Deploy Aave leverage module and add to controller
    aaveLeverageModule = await deployer.setV2.deployAaveLeverageModule(
      setV2Setup.controller.address,
      aaveSetup.lendingPoolAddressesProvider.address,
      aaveSetup.protocolDataProvider.address
    );
    await setV2Setup.controller.addModule(aaveLeverageModule.address);

    // Set integrations for AaveLeverageModule
    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "UniswapTradeAdapter",
      uniswapSetup.uniswapTradeAdapter.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "SushiswapTradeAdapter",
      sushiswapSetup.uniswapTradeAdapter.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "DefaultIssuanceModule",
      setV2Setup.debtIssuanceModule.address,
    );

    // Deploy Chainlink mocks
    chainlinkETH = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkETH.setPrice(BigNumber.from(1000).mul(10 ** 8));
    chainlinkUSDC = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkUSDC.setPrice(10 ** 8);
    chainlinkWBTC = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkWBTC.setPrice(BigNumber.from(50000).mul(10 ** 8));
  });

  beforeEach(async () => {
    scenarios = [
      {
        name: "ETH/USDC 2x",
        collateralAsset: setV2Setup.weth,
        borrowAsset: setV2Setup.usdc,
        collateralAToken: aWETH,
        borrowDebtToken: usdcVariableDebtToken,
        chainlinkCollateral: chainlinkETH,
        chainlinkBorrow: chainlinkUSDC,
        targetLeverageRatio: ether(2),
        collateralPerSet: ether(1),
        exchangeNames: [ "UniswapTradeAdapter", "SushiswapTradeAdapter" ],
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
      } as FLISettings,
      {
        name: "ETH/USDC Inverse",
        collateralAsset: setV2Setup.usdc,
        borrowAsset: setV2Setup.weth,
        collateralAToken: aUSDC,
        borrowDebtToken: wethVariableDebtToken,
        chainlinkCollateral: chainlinkUSDC,
        chainlinkBorrow: chainlinkETH,
        targetLeverageRatio: ether(2),
        collateralPerSet: usdc(100),
        exchangeNames: [ "UniswapTradeAdapter" ],
        exchanges: [
          {
            exchangeLastTradeTimestamp: BigNumber.from(0),
            twapMaxTradeSize: ether(1000),
            incentivizedTwapMaxTradeSize: ether(100000),
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          },
        ],
        checkpoints: [
          {
            issueAmount: ether(500),
            redeemAmount: ZERO,
            collateralPrice: ether(1),
            borrowPrice: ether(1300),
            elapsedTime: ONE_DAY_IN_SECONDS,
            wethPrice: ether(1300),
            exchangeName: "UniswapTradeAdapter",
            exchangePools: [wethUsdcPoolUni],
            router: uniswapSetup.router,
          },
          {
            issueAmount: ether(10000),
            redeemAmount: ZERO,
            collateralPrice: ether(1),
            borrowPrice: ether(1300),
            elapsedTime: ONE_HOUR_IN_SECONDS,
            wethPrice: ether(1300),
            exchangeName: "UniswapTradeAdapter",
            exchangePools: [wethUsdcPoolUni],
            router: uniswapSetup.router,
          },
          {
            issueAmount: ZERO,
            redeemAmount: ZERO,
            collateralPrice: ether(1),
            borrowPrice: ether(1300),
            elapsedTime: ONE_HOUR_IN_SECONDS,
            wethPrice: ether(1300),
            exchangeName: "UniswapTradeAdapter",
            exchangePools: [wethUsdcPoolUni],
            router: uniswapSetup.router,
          },
          {
            issueAmount: ZERO,
            redeemAmount: ZERO,
            collateralPrice: ether(1),
            borrowPrice: ether(1700),
            elapsedTime: ONE_HOUR_IN_SECONDS,
            wethPrice: ether(1700),
            exchangeName: "UniswapTradeAdapter",
            exchangePools: [wethUsdcPoolUni],
            router: uniswapSetup.router,
          },
          {
            issueAmount: ZERO,
            redeemAmount: ZERO,
            collateralPrice: ether(1),
            borrowPrice: ether(1100),
            elapsedTime: ONE_DAY_IN_SECONDS,
            wethPrice: ether(1100),
            exchangeName: "UniswapTradeAdapter",
            exchangePools: [wethUsdcPoolUni],
            router: uniswapSetup.router,
          },
        ],
      } as FLISettings,
      {
        name: "BTC/USDC 2x",
        collateralAsset: setV2Setup.wbtc,
        borrowAsset: setV2Setup.usdc,
        collateralAToken: aWBTC,
        borrowDebtToken: usdcVariableDebtToken,
        chainlinkCollateral: chainlinkWBTC,
        chainlinkBorrow: chainlinkUSDC,
        targetLeverageRatio: ether(2),
        collateralPerSet: bitcoin(0.1),
        exchangeNames: [ "UniswapTradeAdapter", "SushiswapTradeAdapter" ],
        exchanges: [
          {
            exchangeLastTradeTimestamp: BigNumber.from(0),
            twapMaxTradeSize: bitcoin(3),
            incentivizedTwapMaxTradeSize: bitcoin(5),
            leverExchangeData: defaultAbiCoder.encode(["address[]"], [[setV2Setup.usdc.address, setV2Setup.weth.address, setV2Setup.wbtc.address]]),
            deleverExchangeData: defaultAbiCoder.encode(["address[]"], [[setV2Setup.wbtc.address, setV2Setup.weth.address, setV2Setup.usdc.address]]),
          },
          {
            exchangeLastTradeTimestamp: BigNumber.from(0),
            twapMaxTradeSize: bitcoin(3),
            incentivizedTwapMaxTradeSize: bitcoin(5),
            leverExchangeData: defaultAbiCoder.encode(["address[]"], [[setV2Setup.usdc.address, setV2Setup.weth.address, setV2Setup.wbtc.address]]),
            deleverExchangeData: defaultAbiCoder.encode(["address[]"], [[setV2Setup.wbtc.address, setV2Setup.weth.address, setV2Setup.usdc.address]]),
          },
        ],
        checkpoints: [
          {
            issueAmount: ether(.5),
            redeemAmount: ZERO,
            collateralPrice: ether(55000),
            borrowPrice: ether(1),
            elapsedTime: ONE_DAY_IN_SECONDS,
            wethPrice: ether(1375),
            exchangeName: "SushiswapTradeAdapter",
            exchangePools: [wethWbtcPoolSushi, wethUsdcPoolSushi],
            router: uniswapSetup.router,
          },
          {
            issueAmount: ether(2),
            redeemAmount: ZERO,
            collateralPrice: ether(49000),
            borrowPrice: ether(1),
            elapsedTime: ONE_DAY_IN_SECONDS,
            wethPrice: ether(1225),
            exchangeName: "SushiswapTradeAdapter",
            exchangePools: [wethWbtcPoolSushi, wethUsdcPoolSushi],
            router: uniswapSetup.router,
          },
          {
            issueAmount: ZERO,
            redeemAmount: ether(5),
            collateralPrice: ether(35000),
            borrowPrice: ether(1),
            elapsedTime: ONE_DAY_IN_SECONDS,
            wethPrice: ether(875),
            exchangeName: "UniswapTradeAdapter",
            exchangePools: [wethWbtcPoolUni, wethUsdcPoolUni],
            router: uniswapSetup.router,
          },
        ],
      } as FLISettings,
    ];
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#scenario1", async () => {
    let subjectScenario: FLISettings;

    beforeEach(async () => {
      subjectScenario = scenarios[0];

      await deployFLISetup(subjectScenario);

      await issueFLITokens(subjectScenario.collateralAToken, ether(10));

      await engageFLI(subjectScenario.checkpoints[0].exchangeName);
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario, false);
    }

    it("validate state", async () => {
      const [preRebalanceLeverageRatios, postRebalanceLeverageRatios] = await subject();

      const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

      expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      expect(postRebalanceLeverageRatios[0]).to.lt(preRebalanceLeverageRatios[0]);
      expect(postRebalanceLeverageRatios[1]).to.gt(preRebalanceLeverageRatios[1]);
      expect(postRebalanceLeverageRatios[2]).to.lt(preRebalanceLeverageRatios[2]);
    });
  });

  describe("#scenario2", async () => {
    let subjectScenario: FLISettings;

    beforeEach(async () => {
      subjectScenario = scenarios[1];

      await deployFLISetup(subjectScenario);

      await issueFLITokens(subjectScenario.collateralAToken, ether(10));

      await engageFLI(subjectScenario.checkpoints[0].exchangeName);
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario, false);
    }

    it("validate state", async () => {
      const [preRebalanceLeverageRatios, postRebalanceLeverageRatios] = await subject();

      const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

      expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      expect(postRebalanceLeverageRatios[0]).to.lt(preRebalanceLeverageRatios[0]);
      expect(postRebalanceLeverageRatios[1]).to.lt(preRebalanceLeverageRatios[1]);
      expect(postRebalanceLeverageRatios[2]).to.lt(preRebalanceLeverageRatios[2]);
      expect(postRebalanceLeverageRatios[3]).to.lt(preRebalanceLeverageRatios[3]);
      expect(postRebalanceLeverageRatios[4]).to.gt(preRebalanceLeverageRatios[4]);
    });
  });

  describe("#scenario3", async () => {
    let subjectScenario: FLISettings;

    beforeEach(async () => {
      subjectScenario = scenarios[2];

      await deployFLISetup(subjectScenario);

      await issueFLITokens(subjectScenario.collateralAToken, ether(10));

      await engageFLI(subjectScenario.checkpoints[0].exchangeName);
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario, true);
    }

    it("validate state", async () => {
      const [preRebalanceLeverageRatios, postRebalanceLeverageRatios] = await subject();

      const lastTradeTimestamp = await leverageStrategyExtension.globalLastTradeTimestamp();

      expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      expect(postRebalanceLeverageRatios[0]).to.gt(preRebalanceLeverageRatios[0]);
      expect(postRebalanceLeverageRatios[1]).to.gt(preRebalanceLeverageRatios[1]);
      expect(postRebalanceLeverageRatios[2]).to.lt(preRebalanceLeverageRatios[2]);
    });
  });

  async function deployFLISetup(fliSettings: FLISettings): Promise<void> {
    console.log("Deploying FLI Strategy and SetToken...");

    setToken = await setV2Setup.createSetToken(
      [fliSettings.collateralAToken.address],
      [fliSettings.collateralPerSet],
      [
        setV2Setup.streamingFeeModule.address,
        aaveLeverageModule.address,
        setV2Setup.debtIssuanceModule.address,
      ]
    );
    await aaveLeverageModule.updateAnySetAllowed(true);

    // Initialize modules
    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(1),
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO
    );
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
    await aaveLeverageModule.initialize(
      setToken.address,
      [fliSettings.collateralAsset.address],
      [fliSettings.borrowAsset.address]
    );

    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to ic manager
    await setToken.setManager(baseManager.address);

    strategy = {
      setToken: setToken.address,
      leverageModule: aaveLeverageModule.address,
      aaveProtocolDataProvider: aaveSetup.protocolDataProvider.address,
      collateralPriceOracle: fliSettings.chainlinkCollateral.address,
      borrowPriceOracle: fliSettings.chainlinkBorrow.address,
      targetCollateralAToken: fliSettings.collateralAToken.address,
      targetBorrowDebtToken: fliSettings.borrowDebtToken.address,
      collateralAsset: fliSettings.collateralAsset.address,
      borrowAsset: fliSettings.borrowAsset.address,
      collateralDecimalAdjustment: BigNumber.from(28 - await fliSettings.collateralAsset.decimals()),
      borrowDecimalAdjustment: BigNumber.from(28 - await fliSettings.borrowAsset.decimals()),
    };
    methodology = {
      targetLeverageRatio: fliSettings.targetLeverageRatio,
      minLeverageRatio: preciseMul(fliSettings.targetLeverageRatio, PRECISE_UNIT.sub(minLeverageBuffer)),
      maxLeverageRatio: preciseMul(fliSettings.targetLeverageRatio, PRECISE_UNIT.add(maxLeverageBuffer)),
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

    leverageStrategyExtension = await deployer.extensions.deployAaveLeverageStrategyExtension(
      baseManager.address,
      strategy,
      methodology,
      execution,
      incentive,
      fliSettings.exchangeNames,
      fliSettings.exchanges
    );
    await leverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    // Add adapter
    await baseManager.connect(owner.wallet).addAdapter(leverageStrategyExtension.address);
  }

  async function issueFLITokens(collateralAToken: AaveV2AToken, amount: BigNumber): Promise<void> {
    console.log(`Issuing ${amount.toString()} SetTokens`);
    if (amount.gt(ZERO)) {
      await collateralAToken.approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
      await setV2Setup.debtIssuanceModule.issue(setToken.address, amount, owner.address);
    }
  }

  async function redeemFLITokens(amount: BigNumber): Promise<void> {
    console.log(`Redeeming ${amount.toString()} SetTokens`);
    if (amount.gt(ZERO)) {
      await setV2Setup.debtIssuanceModule.issue(setToken.address, amount, owner.address);
    }
  }

  async function engageFLI(exchangeName: string): Promise<void> {
    console.log("Engaging FLI...");
    await leverageStrategyExtension.engage(exchangeName);
    await increaseTimeAsync(twapCooldownPeriod);
    await leverageStrategyExtension.iterateRebalance(exchangeName);
  }

  async function runScenarios(fliSettings: FLISettings, isMultihop: boolean): Promise<[BigNumber[], BigNumber[]]> {
    console.log(`Running Scenarios ${fliSettings.name}`);
    await increaseTimeAsync(rebalanceInterval);

    await leverageStrategyExtension.rebalance(fliSettings.checkpoints[0].exchangeName);

    const preRebalanceLeverageRatios = [];
    const postRebalanceLeverageRatios = [];
    for (let i = 0; i < fliSettings.checkpoints.length; i++) {
      console.log("----------------------");

      await setPricesAndUniswapPool(fliSettings, i, isMultihop);

      await liquidateIfLiquidatable(fliSettings);

      await issueFLITokens(fliSettings.collateralAToken, fliSettings.checkpoints[i].issueAmount);
      await redeemFLITokens(fliSettings.checkpoints[i].redeemAmount);

      await increaseTimeAsync(fliSettings.checkpoints[i].elapsedTime);

      const rebalanceInfo = await leverageStrategyExtension.shouldRebalance();

      const preRebalanceLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
      preRebalanceLeverageRatios.push(preRebalanceLeverageRatio);
      console.log("Pre-Rebalance Leverage Ratio:", preRebalanceLeverageRatio.toString());

      const rebalanceInfoIndex = rebalanceInfo[0].indexOf(fliSettings.checkpoints[i].exchangeName);
      const rebalanceType = rebalanceInfo[1][rebalanceInfoIndex];
      if (rebalanceType != 0) {
        await executeTrade(rebalanceType, fliSettings.checkpoints[i].exchangeName);
      }
      console.log("RebalanceType:", rebalanceType);
      const postRebalanceLeverageRatio = await leverageStrategyExtension.getCurrentLeverageRatio();
      postRebalanceLeverageRatios.push(postRebalanceLeverageRatio);
      console.log("Leverage Ratio:", postRebalanceLeverageRatio.toString());
      console.log(
        "Debt Position:",
        (await setToken.getExternalPositionRealUnit(
          fliSettings.borrowAsset.address,
          aaveLeverageModule.address
        )).toString()
      );
      console.log("Collateral Position:", (await setToken.getDefaultPositionRealUnit(fliSettings.collateralAToken.address)).toString());
      console.log("Borrow Asset Price:", fliSettings.checkpoints[i].borrowPrice.toString());
      console.log("Collateral Asset Price:", fliSettings.checkpoints[i].collateralPrice.toString());
      console.log("Set Value:", (await calculateSetValue(fliSettings, i)).toString());
    }

    return [preRebalanceLeverageRatios, postRebalanceLeverageRatios];
  }

  async function setPricesAndUniswapPool(
    fliSettings: FLISettings,
    checkpoint: number,
    isMultihop: boolean
  ): Promise<void> {

    await aaveSetup.setAssetPriceInOracle(fliSettings.collateralAsset.address,
      preciseDiv(
        fliSettings.checkpoints[checkpoint].collateralPrice,
        fliSettings.checkpoints[checkpoint].wethPrice
      )
    );
    await fliSettings.chainlinkCollateral.setPrice(fliSettings.checkpoints[checkpoint].collateralPrice.div(10 ** 10));

    await aaveSetup.setAssetPriceInOracle(fliSettings.borrowAsset.address,
      preciseDiv(
        fliSettings.checkpoints[checkpoint].borrowPrice,
        fliSettings.checkpoints[checkpoint].wethPrice
      )
    );
    await fliSettings.chainlinkBorrow.setPrice(fliSettings.checkpoints[checkpoint].borrowPrice.div(10 ** 10));

    const collateralPrice = fliSettings.checkpoints[checkpoint].collateralPrice;
    const borrowPrice = fliSettings.checkpoints[checkpoint].borrowPrice;
    const wethPrice = fliSettings.checkpoints[checkpoint].wethPrice;
    if (isMultihop) {
      // Set collateral asset <> WETH pool
      await calculateAndSetUniswapPool(
        fliSettings.checkpoints[checkpoint].router,
        fliSettings.collateralAsset,
        setV2Setup.weth,
        collateralPrice,
        wethPrice,
        fliSettings.checkpoints[checkpoint].exchangePools[0],
      );

      // Set WETH <> borrow asset pool
      await calculateAndSetUniswapPool(
        fliSettings.checkpoints[checkpoint].router,
        setV2Setup.weth,
        fliSettings.borrowAsset,
        wethPrice,
        borrowPrice,
        fliSettings.checkpoints[checkpoint].exchangePools[1],
      );
    } else {
      await calculateAndSetUniswapPool(
        fliSettings.checkpoints[checkpoint].router,
        fliSettings.collateralAsset,
        fliSettings.borrowAsset,
        collateralPrice,
        borrowPrice,
        fliSettings.checkpoints[checkpoint].exchangePools[0],
      );
    }
  }

  async function executeTrade(shouldRebalance: number, exchangeName: string): Promise<void> {
    switch (shouldRebalance) {
      case 1: {
        await leverageStrategyExtension.rebalance(exchangeName);
        break;
      }
      case 2: {
        await leverageStrategyExtension.iterateRebalance(exchangeName);
        break;
    }
      case 3: {
        await leverageStrategyExtension.ripcord(exchangeName);
        break;
      }
    }
  }

  async function calculateAndSetUniswapPool(
    router: UniswapV2Router02,
    assetOne: StandardTokenMock | WETH9,
    assetTwo: StandardTokenMock | WETH9,
    assetOnePrice: BigNumber,
    assetTwoPrice: BigNumber,
    uniswapPool: UniswapV2Pair
  ): Promise<void> {
    const [ assetOneAmount, buyAssetOne ] = await calculateUniswapTradeAmount(
      assetOne,
      assetTwo,
      assetOnePrice,
      assetTwoPrice,
      uniswapPool,
    );

    if (buyAssetOne) {
      await router.swapTokensForExactTokens(
        assetOneAmount,
        MAX_UINT_256,
        [assetTwo.address, assetOne.address],
        owner.address,
        MAX_UINT_256
      );
    } else {
      await router.swapExactTokensForTokens(
        assetOneAmount,
        ZERO,
        [assetOne.address, assetTwo.address],
        owner.address,
        MAX_UINT_256
      );
    }
  }

  async function calculateUniswapTradeAmount(
    assetOne: StandardTokenMock | WETH9,
    assetTwo: StandardTokenMock | WETH9,
    assetOnePrice: BigNumber,
    assetTwoPrice: BigNumber,
    uniswapPool: UniswapV2Pair
  ): Promise<[BigNumber, boolean]> {
    const assetOneDecimals = BigNumber.from(10).pow((await assetOne.decimals()));
    const assetTwoDecimals = BigNumber.from(10).pow((await assetTwo.decimals()));
    const [ assetOneReserve, assetTwoReserve ] = await getUniswapReserves(uniswapPool, assetOne);
    const expectedPrice = preciseDiv(assetOnePrice, assetTwoPrice);

    const currentK = assetOneReserve.mul(assetTwoReserve);
    const assetOneLeft = sqrt(currentK.div(expectedPrice.mul(assetTwoDecimals).div(assetOneDecimals))).mul(BigNumber.from(10).pow(9));

    return assetOneLeft.gt(assetOneReserve) ?
      [ assetOneLeft.sub(assetOneReserve), false ] :
      [ assetOneReserve.sub(assetOneLeft), true ];
  }

  async function getUniswapReserves(
    uniswapPool: UniswapV2Pair,
    assetOne: StandardTokenMock | WETH9
  ): Promise<[BigNumber, BigNumber]> {
    const [ reserveOne, reserveTwo ] = await uniswapPool.getReserves();
    const tokenOne = await uniswapPool.token0();
    return tokenOne == assetOne.address ? [reserveOne, reserveTwo] : [reserveTwo, reserveOne];
  }

  async function liquidateIfLiquidatable(fliSettings: FLISettings): Promise<void> {
    const accountData = await aaveSetup.lendingPool.getUserAccountData(setToken.address);

    if (accountData.healthFactor.lt(ether(1))) {
      await aaveSetup.lendingPool.liquidationCall(
        fliSettings.collateralAsset.address,
        fliSettings.borrowAsset.address,
        setToken.address,
        MAX_UINT_256,
        true
      );
    }
  }

  async function calculateSetValue(fliSettings: FLISettings, checkpoint: number): Promise<BigNumber> {
    const totalSupply = await setToken.totalSupply();
    const collateralATokenUnit = (await setToken.getDefaultPositionRealUnit(fliSettings.collateralAToken.address));
    const borrowUnit = (await setToken.getExternalPositionRealUnit(fliSettings.borrowAsset.address, aaveLeverageModule.address));
    const borrowDecimals = BigNumber.from(10).pow(await fliSettings.borrowAsset.decimals());

    const collateralValue = preciseMul(collateralATokenUnit, totalSupply).mul(fliSettings.checkpoints[checkpoint].collateralPrice).div(bitcoin(50));
    const borrowValue = preciseMul(borrowUnit, totalSupply).mul(fliSettings.checkpoints[checkpoint].borrowPrice).div(borrowDecimals);

    return collateralValue.add(borrowValue);
  }

  function sqrt(value: BigNumber) {
    let z = value.add(ONE).div(TWO);
    let y = value;
    while (z.sub(y).isNegative()) {
        y = z;
        z = value.div(z).add(z).div(TWO);
    }
    return y;
  }
});