import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import {
  Address,
  Account,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings
} from "@utils/types";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256, PRECISE_UNIT, ONE_DAY_IN_SECONDS, ONE_HOUR_IN_SECONDS } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, ICManagerV2, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundLeverageModule, DebtIssuanceModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bitcoin,
  calculateNewLeverageRatio,
  calculateCollateralRebalanceUnits,
  calculateMaxBorrowForDelever,
  ether,
  getAccounts,
  getEthBalance,
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
const provider = ethers.provider;

interface CheckpointSettings {
  collateralPrice: BigNumber;
  borrowPrice: BigNumber;
  elapsedTime: BigNumber;
}

interface FLISettings {
  collateralAsset: Address;
  borrowAsset: Address;
  collateralCToken: Address;
  borrowCToken: Address;
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
const twapMaxTradeSize = ether(1);
const twapCooldownPeriod = BigNumber.from(3000);
const slippageTolerance = ether(0.01);

const incentivizedTwapMaxTradeSize = ether(2);
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

    await setV2Setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(1000));
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, usdc(1000000));
    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(1000),
      usdc(1000000),
      ether(999),
      usdc(999000),
      owner.address,
      MAX_UINT_256
    );

    await setV2Setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, bitcoin(100));
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, usdc(5000000));
    await uniswapSetup.router.addLiquidity(
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address,
      bitcoin(100),
      usdc(5000000),
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
        collateralAsset: setV2Setup.weth.address,
        borrowAsset: setV2Setup.usdc.address,
        collateralCToken: cEther.address,
        borrowCToken: cUSDC.address,
        uniswapPool: uniswapSetup.wethUsdcPool,
        targetLeverageRatio: ether(2),
        checkpoints: [
          { collateralPrice: ether(1000), borrowPrice: ether(1), elapsedTime: ONE_DAY_IN_SECONDS },
          { collateralPrice: ether(1100), borrowPrice: ether(1), elapsedTime: ONE_DAY_IN_SECONDS },
          { collateralPrice: ether(800), borrowPrice: ether(1), elapsedTime: ONE_HOUR_IN_SECONDS.mul(12) },
        ],
      } as FLISettings
    ];
  });

  addSnapshotBeforeRestoreAfterEach();

  describe.only("#scenario1", async () => {
    let subjectScenario: FLISettings;

    beforeEach(async () => {
      subjectScenario = scenarios[0];

      await deployFLISetup(subjectScenario);

      await issueFLITokens();

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
      [fliSettings.collateralCToken],
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
      [setV2Setup.weth.address],
      [setV2Setup.usdc.address]
    );

    icManagerV2 = await deployer.manager.deployICManagerV2(
      setToken.address,
      owner.address,
      methodologist.address,
      []
    );

    // Transfer ownership to ic manager
    await setToken.setManager(icManagerV2.address);

    strategy = {
      setToken: setToken.address,
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      priceOracle: compoundSetup.priceOracle.address,
      targetCollateralCToken: fliSettings.collateralCToken,
      targetBorrowCToken: fliSettings.borrowCToken,
      collateralAsset: fliSettings.collateralAsset,
      borrowAsset: fliSettings.borrowAsset,
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
    await icManagerV2.connect(methodologist.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
    await icManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
  }

  async function issueFLITokens(): Promise<void> {
    await cEther.approve(setV2Setup.debtIssuanceModule.address, ether(10000));

    // Issue 1 SetToken
    const issueQuantity = ether(1);
    await setV2Setup.debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  }

  async function engageFLI(): Promise<void> {
    await flexibleLeverageStrategyAdapter.engage();
    while ((await flexibleLeverageStrategyAdapter.twapLeverageRatio()) != ZERO) {
      await increaseTimeAsync(twapCooldownPeriod);
      await flexibleLeverageStrategyAdapter.iterateRebalance();
      console.log((await flexibleLeverageStrategyAdapter.twapLeverageRatio()).toString());
    }
  }

  async function runScenarios(fliSettings: FLISettings): Promise<void> {
    await increaseTimeAsync(rebalanceInterval);
    await flexibleLeverageStrategyAdapter.rebalance();

    for (let i = 0; i < fliSettings.checkpoints.length; i++) {
      const checkpoint = fliSettings.checkpoints[i];
      await setPricesAndUniswapPool(checkpoint, fliSettings.collateralCToken, fliSettings.borrowCToken);

      await increaseTimeAsync(checkpoint.elapsedTime);

      const shouldRebalance = await flexibleLeverageStrategyAdapter.shouldRebalance();

      if (shouldRebalance != 0) {
        await executeTrade(shouldRebalance);
      }

      console.log(shouldRebalance);
    }
  }

  async function setPricesAndUniswapPool(
    checkpoint: CheckpointSettings,
    collateralCToken: Address,
    borrowCToken: Address
  ): Promise<void> {
    const scaledCollateralPrice = preciseDiv(checkpoint.collateralPrice, ether(1));
    const scaledBorrowPrice = preciseDiv(checkpoint.borrowPrice, usdc(1));

    await compoundSetup.priceOracle.setUnderlyingPrice(collateralCToken, scaledCollateralPrice);
    await compoundSetup.priceOracle.setUnderlyingPrice(borrowCToken, scaledBorrowPrice);
  }

  async function executeTrade(shouldRebalance: number): Promise<void> {
    switch (shouldRebalance) {
      case 1:
        await flexibleLeverageStrategyAdapter.rebalance();
        case 2:
          await flexibleLeverageStrategyAdapter.iterateRebalance();
        case 3:
          await flexibleLeverageStrategyAdapter.ripcord();
    }
  }
})