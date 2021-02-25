import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import {
  Account,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings
} from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE, TWO, EMPTY_BYTES, MAX_UINT_256, PRECISE_UNIT, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, ICManagerV2, StandardTokenMock, WETH9 } from "@utils/contracts/index";
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

const expect = getWaffleExpect();

interface CheckpointSettings {
  collateralPrice: BigNumber;
  borrowPrice: BigNumber;
  elapsedTime: BigNumber;
}

interface FLISettings {
  collateralAsset: StandardTokenMock | WETH9;
  borrowAsset: StandardTokenMock | WETH9;
  collateralCToken: CEther | CERc20;
  borrowCToken: CEther | CERc20;
  uniswapPool: UniswapV2Pair;
  targetLeverageRatio: BigNumber;
  checkpoints: CheckpointSettings[];
}

// Across scenario constants
const minLeverageBuffer = ether(.1);
const maxLeverageBuffer = ether(.1);
const recenteringSpeed = ether(0.05);
const rebalanceInterval = BigNumber.from(86400);

const unutilizedLeveragePercentage = ether(0.01);
const twapMaxTradeSize = ether(10);
const twapCooldownPeriod = BigNumber.from(3000);
const slippageTolerance = ether(0.01);

const incentivizedTwapMaxTradeSize = ether(100);
const incentivizedTwapCooldownPeriod = BigNumber.from(60);
const incentivizedSlippageTolerance = ether(0.05);
const etherReward = ether(1);
const incentivizedLeverageRatio = ether(2.6);

describe.only("FlexibleLeverageStrategyAdapter", () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;
  let uniswapSetup: UniswapFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let cWBTC: CERc20;

  let strategy: ContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let icManagerV2: ICManagerV2;

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
      owner.address,
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address
    );

    await setV2Setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(10000),
      usdc(10000000),
      ether(999),
      usdc(999000),
      owner.address,
      MAX_UINT_256
    );

    await setV2Setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address,
      bitcoin(500),
      usdc(25000000),
      bitcoin(99),
      usdc(4950000),
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
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
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
      "DefaultIssuanceModule",
      setV2Setup.debtIssuanceModule.address,
    );
  });

  beforeEach(async () => {
    scenarios = [
      {
        collateralAsset: setV2Setup.weth,
        borrowAsset: setV2Setup.usdc,
        collateralCToken: cEther,
        borrowCToken: cUSDC,
        uniswapPool: uniswapSetup.wethUsdcPool,
        targetLeverageRatio: ether(2),
        checkpoints: [
          { collateralPrice: ether(1000), borrowPrice: ether(1), elapsedTime: ONE_DAY_IN_SECONDS },
          { collateralPrice: ether(1100), borrowPrice: ether(1), elapsedTime: ONE_DAY_IN_SECONDS },
          { collateralPrice: ether(800), borrowPrice: ether(1), elapsedTime: ONE_HOUR_IN_SECONDS.mul(12) },
        ],
      } as FLISettings,
      {
        collateralAsset: setV2Setup.usdc,
        borrowAsset: setV2Setup.weth,
        collateralCToken: cUSDC,
        borrowCToken: cEther,
        uniswapPool: uniswapSetup.wethUsdcPool,
        targetLeverageRatio: ether(2),
        checkpoints: [
          { collateralPrice: ether(1000), borrowPrice: ether(1), elapsedTime: ONE_DAY_IN_SECONDS },
          { collateralPrice: ether(1100), borrowPrice: ether(1), elapsedTime: ONE_DAY_IN_SECONDS },
          { collateralPrice: ether(800), borrowPrice: ether(1), elapsedTime: ONE_HOUR_IN_SECONDS.mul(12) },
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

      await issueFLITokens(subjectScenario.collateralCToken);

      await engageFLI();
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario);
    }

    it("validate state", async () => {
      await subject();

      const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

      expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    });
  });

  describe.only("#scenario2", async () => {
    let subjectScenario: FLISettings;

    beforeEach(async () => {
      subjectScenario = scenarios[1];

      await deployFLISetup(subjectScenario);

      await issueFLITokens(subjectScenario.collateralCToken);

      await engageFLI();
    });

    async function subject(): Promise<any> {
      return runScenarios(subjectScenario);
    }

    it("validate state", async () => {
      await subject();

      const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

      expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
    });
  });

  async function deployFLISetup(fliSettings: FLISettings): Promise<void> {
    setToken = await setV2Setup.createSetToken(
      [fliSettings.collateralCToken.address],
      [BigNumber.from(5000000000)], // Equivalent to 1 ETH
      [
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        setV2Setup.debtIssuanceModule.address,
      ]
    );
    await compoundLeverageModule.updateAnySetInitializable(true);

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

    icManagerV2 = await deployer.manager.deployICManagerV2(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to ic manager
    await setToken.setManager(icManagerV2.address);

    strategy = {
      setToken: setToken.address,
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      priceOracle: compoundSetup.priceOracle.address,
      targetCollateralCToken: fliSettings.collateralCToken.address,
      targetBorrowCToken: fliSettings.borrowCToken.address,
      collateralAsset: fliSettings.collateralAsset.address,
      borrowAsset: fliSettings.borrowAsset.address,
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
      twapMaxTradeSize: twapMaxTradeSize,
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
      exchangeName: "UniswapTradeAdapter",
      exchangeData: EMPTY_BYTES,
    };
    incentive = {
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };

    flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
      icManagerV2.address,
      strategy,
      methodology,
      execution,
      incentive
    );
    await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

    // Add adapter
    await icManagerV2.connect(owner.wallet).initializeAdapters([flexibleLeverageStrategyAdapter.address]);
  }

  async function issueFLITokens(collateralCToken: CERc20 | CEther): Promise<void> {
    await collateralCToken.approve(setV2Setup.debtIssuanceModule.address, ether(10000));

    // Issue 1 SetToken
    const issueQuantity = ether(10);
    await setV2Setup.debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  }

  async function engageFLI(): Promise<void> {
    await flexibleLeverageStrategyAdapter.engage();

    await increaseTimeAsync(twapCooldownPeriod);
    await flexibleLeverageStrategyAdapter.iterateRebalance();
  }

  async function runScenarios(fliSettings: FLISettings): Promise<void> {
    await increaseTimeAsync(rebalanceInterval);

    await flexibleLeverageStrategyAdapter.rebalance();

    for (let i = 0; i < fliSettings.checkpoints.length; i++) {
      await setPricesAndUniswapPool(fliSettings, i);

      await increaseTimeAsync(fliSettings.checkpoints[i].elapsedTime);

      const rebalanceType = await flexibleLeverageStrategyAdapter.shouldRebalance();

      if (rebalanceType != 0) {
        await executeTrade(rebalanceType);
      }
      console.log("RebalanceType:", rebalanceType);
      console.log("Leverage Ratio:", (await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio()).toString());
    }
  }

  async function setPricesAndUniswapPool(
    fliSettings: FLISettings,
    checkpoint: number
  ): Promise<void> {
    const collateralDecimals = BigNumber.from(10).pow((await fliSettings.collateralAsset.decimals()));
    const borrowDecimals = BigNumber.from(10).pow((await fliSettings.borrowAsset.decimals()));
    const scaledCollateralPrice = preciseDiv(fliSettings.checkpoints[checkpoint].collateralPrice, collateralDecimals);
    const scaledBorrowPrice = preciseDiv(fliSettings.checkpoints[checkpoint].borrowPrice, borrowDecimals);

    await compoundSetup.priceOracle.setUnderlyingPrice(fliSettings.collateralCToken.address, scaledCollateralPrice);
    await compoundSetup.priceOracle.setUnderlyingPrice(fliSettings.borrowCToken.address, scaledBorrowPrice);

    const [ amount, buyCollateral ] = await calculateUniswapTradeAmount(fliSettings, checkpoint);
    if (buyCollateral) {
      await uniswapSetup.router.swapTokensForExactTokens(
        amount,
        MAX_UINT_256,
        [fliSettings.borrowAsset.address, fliSettings.collateralAsset.address],
        owner.address,
        MAX_UINT_256
      );
    } else {
      await uniswapSetup.router.swapExactTokensForTokens(
        amount,
        ZERO,
        [fliSettings.collateralAsset.address, fliSettings.borrowAsset.address],
        owner.address,
        MAX_UINT_256
      );
    }
  }

  async function executeTrade(shouldRebalance: number): Promise<void> {
    switch (shouldRebalance) {
      case 1: {
        await flexibleLeverageStrategyAdapter.rebalance();
        break;
      }
      case 2: {
        await flexibleLeverageStrategyAdapter.iterateRebalance();
        break;
    }
      case 3: {
        await flexibleLeverageStrategyAdapter.ripcord();
        break;
      }
    }
  }

  async function calculateUniswapTradeAmount(fliSettings: FLISettings, checkpoint: number): Promise<[BigNumber, boolean]> {
    const collateralDecimals = BigNumber.from(10).pow((await fliSettings.collateralAsset.decimals()));
    const borrowDecimals = BigNumber.from(10).pow((await fliSettings.borrowAsset.decimals()));
    const [ collateralReserve, borrowReserve ] = await getUniswapReserves(fliSettings);
    const expectedPrice = preciseDiv(fliSettings.checkpoints[checkpoint].collateralPrice, fliSettings.checkpoints[checkpoint].borrowPrice);

    const currentK = collateralReserve.mul(borrowReserve);
    const collateralLeft = sqrt(currentK.div(expectedPrice.mul(borrowDecimals).div(collateralDecimals))).mul(BigNumber.from(10).pow(9));
    console.log(collateralLeft.toString(), expectedPrice.mul(borrowDecimals).div(collateralDecimals).toString());
    return collateralLeft.gt(collateralReserve) ?
      [ collateralLeft.sub(collateralReserve), false ] :
      [ collateralReserve.sub(collateralLeft), true ];
  }

  async function getUniswapReserves(fliSettings: FLISettings): Promise<[BigNumber, BigNumber]> {
    const [ reserveOne, reserveTwo ] = await fliSettings.uniswapPool.getReserves();
    const tokenOne = await fliSettings.uniswapPool.token0();
    return tokenOne == fliSettings.collateralAsset.address ? [reserveOne, reserveTwo] : [reserveTwo, reserveOne];
  }

  // async function calculateUniswapSpotPrice(fliSettings: FLISettings): Promise<BigNumber> {
  //   const collateralDecimals = BigNumber.from(10).pow(await fliSettings.collateralAsset.decimals());
  //   const borrowDecimals = BigNumber.from(10).pow(await fliSettings.borrowAsset.decimals());
  //   const [ collateralReserve, borrowReserve ] = await getUniswapReserves(fliSettings);

  //   return preciseDiv(borrowReserve.div(borrowDecimals), collateralReserve.div(collateralDecimals));
  // }

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