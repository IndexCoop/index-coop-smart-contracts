import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import {
  Account,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings
} from "@utils/types";
import { ADDRESS_ZERO, ONE, TWO, THREE, FOUR, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, BaseManager, FLIRebalanceViewer } from "@utils/contracts/index";
import { CompoundLeverageModule, DebtIssuanceModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getCompoundFixture,
  getUniswapFixture,
  getWaffleExpect,
  increaseTimeAsync,
  setUniswapPoolToPrice,
  usdc,
} from "@utils/index";
import { SetFixture, CompoundFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("FLIRebalanceViewer", () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;
  let uniswapSetup: UniswapFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;

  let strategy: ContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let baseManagerV2: BaseManager;

  let rebalanceViewer: FLIRebalanceViewer;

  cacheBeforeEach(async () => {
    [
      owner,
      methodologist,
    ] = await getAccounts();

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
      setV2Setup.usdc.address,
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

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address]);

    // Add liquidity to Uniswap pool

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

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
    await cUSDC.mint(ether(1));
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

    debtIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    // Deploy mock trade adapter
    const uniswapTradeAdapter = await deployer.setV2.deployUniswapV2ExchangeAdapter(uniswapSetup.router.address);
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "UniswapTradeAdapter",
      uniswapTradeAdapter.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );
  });

  const initializeRootScopeContracts = async () => {
    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [BigNumber.from(5000000000)], // Equivalent to 1 ETH
      [
        setV2Setup.issuanceModule.address,
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        debtIssuanceModule.address,
      ]
    );
    await compoundLeverageModule.updateAnySetAllowed(true);

    // Initialize modules
    await debtIssuanceModule.initialize(setToken.address, ether(1), ZERO, ZERO, owner.address, ADDRESS_ZERO);
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
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
    const targetLeverageRatio = ether(2);
    const minLeverageRatio = ether(1.7);
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
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      priceOracle: compoundSetup.priceOracle.address,
      targetCollateralCToken: cEther.address,
      targetBorrowCToken: cUSDC.address,
      collateralAsset: setV2Setup.weth.address,
      borrowAsset: setV2Setup.usdc.address,
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
      twapMaxTradeSize: twapMaxTradeSize,
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
      exchangeName: "UniswapTradeAdapter",
      leverExchangeData: EMPTY_BYTES,
      deleverExchangeData: EMPTY_BYTES,
    };
    incentive = {
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };

    flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
      baseManagerV2.address,
      strategy,
      methodology,
      execution,
      incentive
    );

    // Add adapter
    await baseManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);

    rebalanceViewer = await deployer.viewers.deployFLIRebalanceViewer(
      uniswapSetup.router.address,
      flexibleLeverageStrategyAdapter.address,
      cEther.address
    );
  };

  describe("#shouldRebalanceWithBounds", async () => {
    let subjectMinLeverageRatio: BigNumber;
    let subjectMaxLeverageRatio: BigNumber;

    cacheBeforeEach(async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));

      await flexibleLeverageStrategyAdapter.iterateRebalance();
    });

    beforeEach(() => {
      subjectMinLeverageRatio = ether(1.6);
      subjectMaxLeverageRatio = ether(2.4);
    });

    async function subject(): Promise<any> {
      return rebalanceViewer.shouldRebalanceWithBounds(
        subjectMinLeverageRatio,
        subjectMaxLeverageRatio
      );
    }

    context("when in the midst of a TWAP rebalance", async () => {
      beforeEach(async () => {
        // > Max trade size
        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: ether(0.001),
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "UniswapTradeAdapter",
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);

        // Set up new rebalance TWAP
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
        await increaseTimeAsync(BigNumber.from(100000));
        await flexibleLeverageStrategyAdapter.rebalance();
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(THREE);
        });

        describe("but Uniswap slippage would exceed bounds", async () => {
          beforeEach(async () => {
            await setUniswapPoolToPrice(
              uniswapSetup.router,
              uniswapSetup.wethUsdcPool,
              setV2Setup.weth,
              setV2Setup.usdc,
              ether(750),
              owner.address
            );
          });

          it("should return update oracle", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(FOUR);
          });
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to below incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));
          await increaseTimeAsync(BigNumber.from(4000));
        });

        it("should return iterate rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(TWO);
        });

        describe("but Uniswap slippage would exceed bounds", async () => {
          beforeEach(async () => {
            await setUniswapPoolToPrice(
              uniswapSetup.router,
              uniswapSetup.wethUsdcPool,
              setV2Setup.weth,
              setV2Setup.usdc,
              ether(880),
              owner.address
            );
          });

          it("should return update oracle", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(FOUR);
          });
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
        });
      });
    });

    context("when not in a TWAP rebalance", async () => {
      describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(THREE);
        });

        describe("but Uniswap slippage would exceed bounds", async () => {
          beforeEach(async () => {
            await setUniswapPoolToPrice(
              uniswapSetup.router,
              uniswapSetup.wethUsdcPool,
              setV2Setup.weth,
              setV2Setup.usdc,
              ether(755),
              owner.address
            );
          });

          it("should return update oracle", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(FOUR);
          });
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
          await increaseTimeAsync(BigNumber.from(100000));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });

        describe("but Uniswap slippage would exceed bounds", async () => {
          beforeEach(async () => {
            await setUniswapPoolToPrice(
              uniswapSetup.router,
              uniswapSetup.wethUsdcPool,
              setV2Setup.weth,
              setV2Setup.usdc,
              ether(970),
              owner.address
            );
          });

          it("should return update oracle", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(FOUR);
          });
        });
      });

      describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(850));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });

        describe("but Uniswap slippage would exceed bounds", async () => {
          beforeEach(async () => {
            await setUniswapPoolToPrice(
              uniswapSetup.router,
              uniswapSetup.wethUsdcPool,
              setV2Setup.weth,
              setV2Setup.usdc,
              ether(830),
              owner.address
            );
          });

          it("should return update oracle", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(FOUR);
          });
        });
      });

      describe("when below min leverage ratio", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1400));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });

        describe("but Uniswap slippage would exceed bounds", async () => {
          beforeEach(async () => {
            await setUniswapPoolToPrice(
              uniswapSetup.router,
              uniswapSetup.wethUsdcPool,
              setV2Setup.weth,
              setV2Setup.usdc,
              ether(1430),
              owner.address
            );
          });

          it("should return update oracle", async () => {
            const shouldRebalance = await subject();

            expect(shouldRebalance).to.eq(FOUR);
          });
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
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
});