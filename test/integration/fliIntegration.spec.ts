import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { defaultAbiCoder } from "ethers/lib/utils";

import {
  Account,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings
} from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE, TWO, EMPTY_BYTES, MAX_UINT_256, PRECISE_UNIT, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import { FlexibleLeverageStrategyExtension, BaseManagerV2, StandardTokenMock, WETH9, ChainlinkAggregatorV3Mock } from "@utils/contracts/index";
import { CompoundLeverageModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bitcoin,
  ether,
  getAccounts,
  getSetFixture,
  getCompoundFixture,
  getUniswapFixture,
  getWaffleExpect,
  getLastBlockTimestamp,
  increaseTimeAsync,
  preciseDiv,
  preciseMul,
  usdc
} from "@utils/index";
import { CompoundFixture, SetFixture, UniswapFixture } from "@utils/fixtures";
import { UniswapV2Pair } from "@typechain/UniswapV2Pair";
import { CERc20__factory } from "../../typechain/factories/CERc20__factory";
import { CEther__factory } from "../../typechain/factories/CEther__factory";
import { UniswapV2Router02 } from "@typechain/UniswapV2Router02";

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
  collateralCToken: CEther | CERc20;
  borrowCToken: CEther | CERc20;
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

describe("FlexibleLeverageStrategyExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;
  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let cWBTC: CERc20;

  let strategy: ContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;

  let flexibleLeverageStrategyExtension: FlexibleLeverageStrategyExtension;
  let compoundLeverageModule: CompoundLeverageModule;
  let baseManager: BaseManagerV2;

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

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

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

    cEther = await compoundSetup.createAndEnableCEther(
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000)   // $1000
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
      ether(1000000000000) // IMPORTANT: Compound oracles account for decimals scaled by 10e18. For USDC, this is $1 * 10^18 * 10^18 / 10^6 = 10^30
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
      ether(500000000000000) // $50,000
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address, cWBTC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
    await setV2Setup.wbtc.approve(cWBTC.address, ether(100000));
    await cUSDC.mint(ether(1));
    await cWBTC.mint(ether(1));
    await cEther.mint({value: ether(1000)});

    // Deploy Compound leverage module and add to controller
    compoundLeverageModule = await deployer.setV2.deployCompoundLeverageModule(
      setV2Setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setV2Setup.weth.address
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
        collateralCToken: cEther,
        borrowCToken: cUSDC,
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
        collateralCToken: cUSDC,
        borrowCToken: cEther,
        chainlinkCollateral: chainlinkUSDC,
        chainlinkBorrow: chainlinkETH,
        targetLeverageRatio: ether(2),
        collateralPerSet: ether(100),
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
        collateralCToken: cWBTC,
        borrowCToken: cUSDC,
        chainlinkCollateral: chainlinkWBTC,
        chainlinkBorrow: chainlinkUSDC,
        targetLeverageRatio: ether(2),
        collateralPerSet: ether(.1),
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

      await issueFLITokens(subjectScenario.collateralCToken, ether(10));

      await engageFLI(subjectScenario.checkpoints[0].exchangeName);
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario, false);
    }

    it("validate state", async () => {
      const [preRebalanceLeverageRatios, postRebalanceLeverageRatios] = await subject();

      const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

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

      await issueFLITokens(subjectScenario.collateralCToken, ether(10));

      await engageFLI(subjectScenario.checkpoints[0].exchangeName);
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario, false);
    }

    it("validate state", async () => {
      const [preRebalanceLeverageRatios, postRebalanceLeverageRatios] = await subject();

      const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

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

      await issueFLITokens(subjectScenario.collateralCToken, ether(10));

      await engageFLI(subjectScenario.checkpoints[0].exchangeName);
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario, true);
    }

    it("validate state", async () => {
      const [preRebalanceLeverageRatios, postRebalanceLeverageRatios] = await subject();

      const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

      expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      expect(postRebalanceLeverageRatios[0]).to.gt(preRebalanceLeverageRatios[0]);
      expect(postRebalanceLeverageRatios[1]).to.gt(preRebalanceLeverageRatios[1]);
      expect(postRebalanceLeverageRatios[2]).to.lt(preRebalanceLeverageRatios[2]);
    });
  });

  async function deployFLISetup(fliSettings: FLISettings): Promise<void> {
    console.log("Deploying FLI Strategy and SetToken...");

    const unit = preciseMul(bitcoin(50), fliSettings.collateralPerSet); // User bitcoin(50) because a full unit of underlying is 50*10^8
    setToken = await setV2Setup.createSetToken(
      [fliSettings.collateralCToken.address],
      [unit],
      [
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        setV2Setup.debtIssuanceModule.address,
      ]
    );
    await compoundLeverageModule.updateAnySetAllowed(true);

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
    await compoundLeverageModule.initialize(
      setToken.address,
      [fliSettings.collateralAsset.address],
      [fliSettings.borrowAsset.address]
    );

    baseManager = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      owner.address,
      methodologist.address
    );
    await baseManager.connect(methodologist.wallet).authorizeInitialization();

    // Transfer ownership to ic manager
    await setToken.setManager(baseManager.address);

    strategy = {
      setToken: setToken.address,
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      collateralPriceOracle: fliSettings.chainlinkCollateral.address,
      borrowPriceOracle: fliSettings.chainlinkBorrow.address,
      targetCollateralCToken: fliSettings.collateralCToken.address,
      targetBorrowCToken: fliSettings.borrowCToken.address,
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

    flexibleLeverageStrategyExtension = await deployer.extensions.deployFlexibleLeverageStrategyExtension(
      baseManager.address,
      strategy,
      methodology,
      execution,
      incentive,
      fliSettings.exchangeNames,
      fliSettings.exchanges
    );
    await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

    // Add extension
    await baseManager.connect(owner.wallet).addExtension(flexibleLeverageStrategyExtension.address);
  }

  async function issueFLITokens(collateralCToken: CERc20 | CEther, amount: BigNumber): Promise<void> {
    console.log(`Issuing ${amount.toString()} SetTokens`);
    if (amount.gt(ZERO)) {
      await collateralCToken.approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
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
    await flexibleLeverageStrategyExtension.engage(exchangeName);
    await increaseTimeAsync(twapCooldownPeriod);
    await flexibleLeverageStrategyExtension.iterateRebalance(exchangeName);
  }

  async function runScenarios(fliSettings: FLISettings, isMultihop: boolean): Promise<[BigNumber[], BigNumber[]]> {
    console.log(`Running Scenarios ${fliSettings.name}`);
    await increaseTimeAsync(rebalanceInterval);

    await flexibleLeverageStrategyExtension.rebalance(fliSettings.checkpoints[0].exchangeName);

    const preRebalanceLeverageRatios = [];
    const postRebalanceLeverageRatios = [];
    for (let i = 0; i < fliSettings.checkpoints.length; i++) {
      console.log("----------------------");

      await setPricesAndUniswapPool(fliSettings, i, isMultihop);

      await liquidateIfLiquidatable(fliSettings);

      await issueFLITokens(fliSettings.collateralCToken, fliSettings.checkpoints[i].issueAmount);
      await redeemFLITokens(fliSettings.checkpoints[i].redeemAmount);

      await increaseTimeAsync(fliSettings.checkpoints[i].elapsedTime);

      const rebalanceInfo = await flexibleLeverageStrategyExtension.shouldRebalance();

      const preRebalanceLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
      preRebalanceLeverageRatios.push(preRebalanceLeverageRatio);
      console.log("Pre-Rebalance Leverage Ratio:", preRebalanceLeverageRatio.toString());

      const rebalanceInfoIndex = rebalanceInfo[0].indexOf(fliSettings.checkpoints[i].exchangeName);
      const rebalanceType = rebalanceInfo[1][rebalanceInfoIndex];
      if (rebalanceType != 0) {
        await executeTrade(rebalanceType, fliSettings.checkpoints[i].exchangeName);
      }
      console.log("RebalanceType:", rebalanceType);
      const postRebalanceLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
      postRebalanceLeverageRatios.push(postRebalanceLeverageRatio);
      console.log("Leverage Ratio:", postRebalanceLeverageRatio.toString());
      console.log(
        "Debt Position:",
        (await setToken.getExternalPositionRealUnit(
          fliSettings.borrowAsset.address,
          compoundLeverageModule.address
        )).toString()
      );
      console.log("Collateral Position:", (await setToken.getDefaultPositionRealUnit(fliSettings.collateralCToken.address)).toString());
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
    const collateralDecimals = BigNumber.from(10).pow((await fliSettings.collateralAsset.decimals()));
    const borrowDecimals = BigNumber.from(10).pow((await fliSettings.borrowAsset.decimals()));
    const scaledCollateralPrice = preciseDiv(fliSettings.checkpoints[checkpoint].collateralPrice, collateralDecimals);
    const scaledBorrowPrice = preciseDiv(fliSettings.checkpoints[checkpoint].borrowPrice, borrowDecimals);

    await compoundSetup.priceOracle.setUnderlyingPrice(fliSettings.collateralCToken.address, scaledCollateralPrice);
    await fliSettings.chainlinkCollateral.setPrice(fliSettings.checkpoints[checkpoint].collateralPrice.div(10 ** 10));
    await compoundSetup.priceOracle.setUnderlyingPrice(fliSettings.borrowCToken.address, scaledBorrowPrice);
    await fliSettings.chainlinkBorrow.setPrice(fliSettings.checkpoints[checkpoint].borrowPrice.div(10 ** 10));

    const collateralPrice = fliSettings.checkpoints[checkpoint].collateralPrice;
    const borrowPrice = fliSettings.checkpoints[checkpoint].borrowPrice;
    const wethPrice = fliSettings.checkpoints[checkpoint].wethPrice;
    if (isMultihop) {
      // Set collateral asset <> WETH pool
      await calculateAndSetUniswapPool(
        fliSettings,
        fliSettings.checkpoints[checkpoint].router,
        fliSettings.collateralAsset,
        setV2Setup.weth,
        collateralPrice,
        wethPrice,
        fliSettings.checkpoints[checkpoint].exchangePools[0],
      );

      // Set WETH <> borrow asset pool
      await calculateAndSetUniswapPool(
        fliSettings,
        fliSettings.checkpoints[checkpoint].router,
        setV2Setup.weth,
        fliSettings.borrowAsset,
        wethPrice,
        borrowPrice,
        fliSettings.checkpoints[checkpoint].exchangePools[1],
      );
    } else {
      await calculateAndSetUniswapPool(
        fliSettings,
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
        await flexibleLeverageStrategyExtension.rebalance(exchangeName);
        break;
      }
      case 2: {
        await flexibleLeverageStrategyExtension.iterateRebalance(exchangeName);
        break;
    }
      case 3: {
        await flexibleLeverageStrategyExtension.ripcord(exchangeName);
        break;
      }
    }
  }

  async function calculateAndSetUniswapPool(
    fliSettings: FLISettings,
    router: UniswapV2Router02,
    assetOne: StandardTokenMock | WETH9,
    assetTwo: StandardTokenMock | WETH9,
    assetOnePrice: BigNumber,
    assetTwoPrice: BigNumber,
    uniswapPool: UniswapV2Pair
  ): Promise<void> {
    const [ assetOneAmount, buyAssetOne ] = await calculateUniswapTradeAmount(
      fliSettings,
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
    fliSettings: FLISettings,
    assetOne: StandardTokenMock | WETH9,
    assetTwo: StandardTokenMock | WETH9,
    assetOnePrice: BigNumber,
    assetTwoPrice: BigNumber,
    uniswapPool: UniswapV2Pair
  ): Promise<[BigNumber, boolean]> {
    const assetOneDecimals = BigNumber.from(10).pow((await assetOne.decimals()));
    const assetTwoDecimals = BigNumber.from(10).pow((await assetTwo.decimals()));
    const [ assetOneReserve, assetTwoReserve ] = await getUniswapReserves(fliSettings, uniswapPool, assetOne);
    const expectedPrice = preciseDiv(assetOnePrice, assetTwoPrice);

    const currentK = assetOneReserve.mul(assetTwoReserve);
    const assetOneLeft = sqrt(currentK.div(expectedPrice.mul(assetTwoDecimals).div(assetOneDecimals))).mul(BigNumber.from(10).pow(9));

    return assetOneLeft.gt(assetOneReserve) ?
      [ assetOneLeft.sub(assetOneReserve), false ] :
      [ assetOneReserve.sub(assetOneLeft), true ];
  }

  async function getUniswapReserves(
    fliSettings: FLISettings,
    uniswapPool: UniswapV2Pair,
    assetOne: StandardTokenMock | WETH9
  ): Promise<[BigNumber, BigNumber]> {
    const [ reserveOne, reserveTwo ] = await uniswapPool.getReserves();
    const tokenOne = await uniswapPool.token0();
    return tokenOne == assetOne.address ? [reserveOne, reserveTwo] : [reserveTwo, reserveOne];
  }

  async function liquidateIfLiquidatable(fliSettings: FLISettings): Promise<void> {
    const [ , , shortfall] = await compoundSetup.comptroller.getAccountLiquidity(setToken.address);
    if (shortfall.gt(0)) {
      const debtUnits = await setToken.getExternalPositionRealUnit(fliSettings.borrowAsset.address, compoundLeverageModule.address);
      const payDownAmount = preciseMul(debtUnits, await setToken.totalSupply()).mul(-1).div(2);

      if (fliSettings.borrowAsset.address != setV2Setup.weth.address) {
        const cToken = await new CERc20__factory(owner.wallet).attach(fliSettings.borrowCToken.address);
        await cToken.liquidateBorrow(setToken.address, payDownAmount, fliSettings.collateralCToken.address);
      } else {
        const cToken: CEther = await new CEther__factory(owner.wallet).attach(fliSettings.borrowCToken.address);
        await cToken.liquidateBorrow(setToken.address, fliSettings.collateralCToken.address, { value: payDownAmount });
      }
    }
  }

  async function calculateSetValue(fliSettings: FLISettings, checkpoint: number): Promise<BigNumber> {
    const totalSupply = await setToken.totalSupply();
    const collateralCTokenUnit = (await setToken.getDefaultPositionRealUnit(fliSettings.collateralCToken.address));
    const borrowUnit = (await setToken.getExternalPositionRealUnit(fliSettings.borrowAsset.address, compoundLeverageModule.address));
    const borrowDecimals = BigNumber.from(10).pow(await fliSettings.borrowAsset.decimals());

    const collateralValue = preciseMul(collateralCTokenUnit, totalSupply).mul(fliSettings.checkpoints[checkpoint].collateralPrice).div(bitcoin(50));
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
