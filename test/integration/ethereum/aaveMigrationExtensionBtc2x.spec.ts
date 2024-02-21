import "module-alias/register";
import { BigNumber, Signer } from "ethers";
import { JsonRpcSigner } from "@ethersproject/providers";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { bitcoin, ether, getAccounts, getWaffleExpect, preciseDiv, preciseMul } from "@utils/index";
import { ZERO } from "@utils/constants";
import { addSnapshotBeforeRestoreAfterEach, increaseTimeAsync, setBlockNumber } from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import {
  AaveMigrationExtension,
  BaseManagerV2__factory,
  BaseManagerV2,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  FlexibleLeverageStrategyExtension,
  FlexibleLeverageStrategyExtension__factory,
  IERC20,
  IERC20__factory,
  SetToken,
  SetToken__factory,
  TradeModule__factory,
  TradeModule,
  UniswapV3ExchangeAdapter,
  UniswapV3ExchangeAdapter__factory,
  WrapExtension,
} from "../../../typechain";

const expect = getWaffleExpect();

const contractAddresses = {
  addressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  debtIssuanceModuleV2: "0x04b59F9F09750C044D7CfbC177561E409085f0f3",
  flexibleLeverageStrategyExtension: "0xFD4eA597E8346a6723FA4A06a31E4b6F7F37e9Ad",
  tradeModule: "0x90F765F63E7DC5aE97d6c576BF693FB6AF41C129",
  uniswapV3ExchangeAdapter: "0xcC327D928925584AB00Fe83646719dEAE15E0424",
  uniswapV3NonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3Pool: "0xb1DD5eb0A64004E9Bbee68ca64AE0ccE8c7bB867",
  wrapModule: "0xbe4aEdE1694AFF7F1827229870f6cf3d9e7a999c",
};

const tokenAddresses = {
  aEthWbtc: "0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8",
  cwbtc: "0xccF4429DB6322D5C611ee964527D42E5d685DD6a",
  btc2x: "0xD2AC55cA3Bbd2Dd1e9936eC640dCb4b745fDe759",
  btc2xfli: "0x0B498ff89709d3838a063f1dFA463091F9801c2b",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};

const keeperAddresses = {
  btc2xfliKeeper: "0xCBEb906f46eA0b9D7e7e75379fAFbceACd1aAeff",
  btc2xDeployer: "0x37e6365d4f6aE378467b0e24c9065Ce5f06D70bF",
};

if (process.env.INTEGRATIONTEST) {
  describe.only("AaveMigrationExtension - BTC2x-FLI Integration Test", async () => {
    let owner: Account;
    let operator: Signer;
    let keeper: Signer;
    let deployer: DeployHelper;

    let btc2xfli: SetToken;
    let baseManager: BaseManagerV2;
    let tradeModule: TradeModule;

    let btc2x: SetToken;
    let debtIssuanceModuleV2: DebtIssuanceModuleV2;

    let wbtc: IERC20;
    let cwbtc: IERC20;
    let usdc: IERC20;
    let aEthWbtc: IERC20;

    let migrationExtension: AaveMigrationExtension;

    setBlockNumber(19276457);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      // Setup collateral tokens
      wbtc = IERC20__factory.connect(tokenAddresses.wbtc, owner.wallet);
      cwbtc = IERC20__factory.connect(tokenAddresses.cwbtc, owner.wallet);
      usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
      aEthWbtc = IERC20__factory.connect(tokenAddresses.aEthWbtc, owner.wallet);

      // Setup BTC2x-FLI contracts
      btc2xfli = SetToken__factory.connect(tokenAddresses.btc2xfli, owner.wallet);
      baseManager = BaseManagerV2__factory.connect(await btc2xfli.manager(), owner.wallet);
      operator = await impersonateAccount(await baseManager.operator());
      baseManager = baseManager.connect(operator);
      tradeModule = TradeModule__factory.connect(contractAddresses.tradeModule, owner.wallet);
      keeper = await impersonateAccount(keeperAddresses.btc2xfliKeeper);

      // Setup BTC2x contracts
      btc2x = SetToken__factory.connect(tokenAddresses.btc2x, owner.wallet);
      debtIssuanceModuleV2 = DebtIssuanceModuleV2__factory.connect(contractAddresses.debtIssuanceModuleV2, owner.wallet);

      // Deploy Migration Extension
      migrationExtension = await deployer.extensions.deployAaveMigrationExtension(
        baseManager.address,
        wbtc.address,
        aEthWbtc.address,
        btc2x.address,
        tradeModule.address,
        debtIssuanceModuleV2.address,
        contractAddresses.uniswapV3NonfungiblePositionManager,
        contractAddresses.addressProvider,
      );
      migrationExtension = migrationExtension.connect(operator);
    });

    addSnapshotBeforeRestoreAfterEach();

    context("when the product is de-levered", () => {
      let flexibleLeverageStrategyExtension: FlexibleLeverageStrategyExtension;

      before(async () => {
        flexibleLeverageStrategyExtension = FlexibleLeverageStrategyExtension__factory.connect(
          contractAddresses.flexibleLeverageStrategyExtension,
          operator
        );

        // Adjust slippage tolerance for the test environment
        const oldExecution = await flexibleLeverageStrategyExtension.getExecution();
        const newExecution = {
          unutilizedLeveragePercentage: oldExecution.unutilizedLeveragePercentage,
          slippageTolerance: ether(0.5), // Increased slippage tolerance
          twapCooldownPeriod: oldExecution.twapCooldownPeriod,
        };
        flexibleLeverageStrategyExtension.setExecutionSettings(newExecution);

        // Configure leverage strategy for 1x leverage
        const oldMethodology = await flexibleLeverageStrategyExtension.getMethodology();
        const newMethodology = {
          targetLeverageRatio: ether(1),
          minLeverageRatio: ether(0.9),
          maxLeverageRatio: ether(1),
          recenteringSpeed: oldMethodology.recenteringSpeed,
          rebalanceInterval: oldMethodology.rebalanceInterval,
        };
        flexibleLeverageStrategyExtension.setMethodologySettings(newMethodology);

        // Verify initial leverage ratio is within expected range (1.75 to 2.25)
        const startingLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(startingLeverage.gt(ether(1.75)) && startingLeverage.lt(ether(2.25)));

        // Perform first rebalance, should lower leverage ratio
        await flexibleLeverageStrategyExtension.connect(keeper).rebalance("UniswapV3ExchangeAdapter");
        const firstRebalanceLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(firstRebalanceLeverage.lt(startingLeverage));
        increaseTimeAsync(oldExecution.twapCooldownPeriod);

        // Iterate rebalance, should lower leverage ratio
        await flexibleLeverageStrategyExtension.connect(keeper).iterateRebalance("UniswapV3ExchangeAdapter");
        const secondRebalanceLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(secondRebalanceLeverage.lt(firstRebalanceLeverage));
        increaseTimeAsync(oldExecution.twapCooldownPeriod);

        // Disengage from the strategy, should have 1 leverage ratio
        await flexibleLeverageStrategyExtension.connect(operator).disengage("UniswapV3ExchangeAdapter");
      });

      it("should have leverage ratio of 1", async () => {
        const endingLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(endingLeverage.eq(ether(1)));
      });

      it("should have cWBTC and USDC as equity components", async () => {
        const components = await btc2xfli.getComponents();
        expect(components).to.deep.equal([tokenAddresses.cwbtc, tokenAddresses.usdc]);
      });

      context("when the cWBTC is unwrapped", () => {
        let wrapExtension: WrapExtension;

        before(async () => {
          // Deploy Wrap Extension
          wrapExtension = await deployer.extensions.deployWrapExtension(
            baseManager.address,
            contractAddresses.wrapModule
          );

          // Add Wrap Module
          await baseManager.addModule(contractAddresses.wrapModule);

          // Add Wrap Extension
          await baseManager.addExtension(wrapExtension.address);

          // Initialize Wrap Extension
          await wrapExtension.connect(operator).initialize();

          // Unwrap cWBTC
          await wrapExtension.connect(operator).unwrap(
            wbtc.address,
            cwbtc.address,
            await btc2xfli.getTotalComponentRealUnits(cwbtc.address),
            "CompoundWrapAdapter"
          );
        });

        it("should have wBTC as a component instead of cWBTC", async () => {
          const components = await btc2xfli.getComponents();
          await expect(components).to.deep.equal([tokenAddresses.wbtc, tokenAddresses.usdc]);
        });

        context("when migration extension is added as extension", () => {
          before(async () => {
            // Add Migration Extension
            await baseManager.addExtension(migrationExtension.address);
          });

          it("should have the MigrationExtension added as an extension", async () => {
            expect(
              await baseManager.isExtension(migrationExtension.address)
            ).to.be.true;
          });

          context("when the trade module is added and initialized", () => {
            before(async () => {
              // Add Trade Module
              await baseManager.addModule(tradeModule.address);

              // Initialize Trade Module via Migration Extension
              await migrationExtension.initialize();
            });

            it("should have the TradeModule added as a module", async () => {
              expect(
                await btc2xfli.moduleStates(tradeModule.address)
              ).to.equal(2);
            });

            context("when the USDC equity is traded away", () => {
              let uniswapV3ExchangeAdapter: UniswapV3ExchangeAdapter;

              before(async () => {
                uniswapV3ExchangeAdapter = UniswapV3ExchangeAdapter__factory.connect(
                  contractAddresses.uniswapV3ExchangeAdapter,
                  operator
                );

                const exchangeName = "UniswapV3ExchangeAdapter";
                const usdcUnit = await btc2xfli.getDefaultPositionRealUnit(usdc.address);
                const exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                  [tokenAddresses.usdc, tokenAddresses.wbtc],
                  [BigNumber.from(500)],
                );

                // Trade USDC for WETH via Migration Extension
                await migrationExtension.trade(
                  exchangeName,
                  usdc.address,
                  usdcUnit,
                  wbtc.address,
                  0,
                  exchangeData
                );
              });

              it("should remove USDC as a component", async () => {
                const components = await btc2xfli.getComponents();
                await expect(components).to.deep.equal([tokenAddresses.wbtc]);
              });

              context("when the Uniswap V3 liquidity position is minted", () => {
                before(async () => {
                  const tickLower = 292660;
                  const tickUpper = 292670;
                  const fee = 500;

                  const underlyingAmount = 0;
                  const wrappedSetTokenAmount = ether(0.01);

                  await btc2x.connect(
                    await impersonateAccount(keeperAddresses.btc2xDeployer)
                  ).transfer(migrationExtension.address, wrappedSetTokenAmount);

                  // Mint liquidity position via Migration Extension
                  await migrationExtension.mintLiquidityPosition(
                    underlyingAmount,
                    wrappedSetTokenAmount,
                    tickLower,
                    tickUpper,
                    fee
                  );
                });

                it("should seed the liquidity position", async () => {
                  const tokenId = await migrationExtension.tokenIds(0);
                  expect(tokenId).to.be.gt(0);
                });

                context("when the migration is ready", () => {
                  let underlyingLoanAmount: BigNumber;
                  let underlyingSupplyLiquidityAmount: BigNumber;
                  let wrappedSetTokenSupplyLiquidityAmount: BigNumber;
                  let tokenId: BigNumber;
                  let exchangeName: string;
                  let underlyingTradeUnits: BigNumber;
                  let wrappedSetTokenTradeUnits: BigNumber;
                  let exchangeData: string;
                  let underlyingRedeemLiquidityMinAmount: BigNumber;
                  let wrappedSetTokenRedeemLiquidityMinAmount: BigNumber;

                  let wbtcWhale: JsonRpcSigner;

                  before(async () => {
                    const setTokenTotalSupply = await btc2xfli.totalSupply();
                    const wrappedPositionUnits = await btc2x.getDefaultPositionRealUnit(aEthWbtc.address);
                    const wrappedExchangeRate = preciseDiv(ether(1), wrappedPositionUnits);

                    // BTC2x-FLI trade parameters
                    underlyingTradeUnits = await btc2xfli.getDefaultPositionRealUnit(wbtc.address);
                    wrappedSetTokenTradeUnits = preciseMul(
                      preciseMul(wrappedExchangeRate, ether(0.995)),
                      underlyingTradeUnits
                    );
                    exchangeName = "UniswapV3ExchangeAdapter";
                    exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                      [tokenAddresses.wbtc, tokenAddresses.btc2x],
                      [BigNumber.from(500)],
                    );

                    // Flash loan parameters
                    underlyingLoanAmount = preciseMul(
                      underlyingTradeUnits,
                      setTokenTotalSupply
                    );

                    // Uniswap V3 liquidity parameters
                    underlyingSupplyLiquidityAmount = ZERO;
                    wrappedSetTokenSupplyLiquidityAmount = preciseMul(
                      preciseDiv(ether(1), wrappedPositionUnits),
                      underlyingLoanAmount
                    );
                    tokenId = await migrationExtension.tokenIds(0);
                    underlyingRedeemLiquidityMinAmount = ZERO;
                    wrappedSetTokenRedeemLiquidityMinAmount = ZERO;

                    // Subsidize 0.05 WBTC to the migration extension
                    wbtcWhale = await impersonateAccount("0xe74b28c2eAe8679e3cCc3a94d5d0dE83CCB84705");
                    await wbtc.connect(wbtcWhale).transfer(migrationExtension.address, bitcoin(0.05));
                  });

                  it("should be able to migrate atomically", async () => {
                    // Verify starting components and units
                    const startingComponents = await btc2xfli.getComponents();
                    const startingUnit = await btc2xfli.getDefaultPositionRealUnit(tokenAddresses.wbtc);
                    expect(startingComponents).to.deep.equal([tokenAddresses.wbtc]);
                    expect(startingUnit).to.eq(underlyingTradeUnits);

                    // Migrate atomically via Migration Extension
                    await migrationExtension.migrate(
                      underlyingLoanAmount,
                      underlyingSupplyLiquidityAmount,
                      wrappedSetTokenSupplyLiquidityAmount,
                      tokenId,
                      exchangeName,
                      underlyingTradeUnits,
                      wrappedSetTokenTradeUnits,
                      exchangeData,
                      underlyingRedeemLiquidityMinAmount,
                      wrappedSetTokenRedeemLiquidityMinAmount
                    );

                    // Verify ending components and units
                    const endingComponents = await btc2xfli.getComponents();
                    const endingUnit = await btc2xfli.getDefaultPositionRealUnit(tokenAddresses.btc2x);
                    expect(endingComponents).to.deep.equal([tokenAddresses.btc2x]);
                    expect(endingUnit).to.be.gt(wrappedSetTokenTradeUnits);
                  });

                  context("when the migration is completed", () => {
                    it("can sweep any remaining tokens", async () => {
                      const operatorAddress = await baseManager.operator();

                      // Store initial units for the operator
                      const initialWbtc = await wbtc.balanceOf(operatorAddress);
                      const initialAethWbtc = await aEthWbtc.balanceOf(operatorAddress);
                      const initialBtc2x = await btc2x.balanceOf(operatorAddress);

                      // Verify remaining units on the migration extension
                      const remainingWbtc = await wbtc.balanceOf(migrationExtension.address);
                      const remainingAethWbtc = await aEthWbtc.balanceOf(migrationExtension.address);
                      const remainingBtc2x = await btc2x.balanceOf(migrationExtension.address);
                      expect(remainingWbtc).to.gt(ZERO);
                      expect(remainingAethWbtc).to.eq(ZERO);
                      expect(remainingBtc2x).to.eq(ZERO);

                      // Sweep remaining tokens to the operator
                      await migrationExtension.sweepTokens();

                      // Verify ending units for the operator
                      const endingWbtc = await wbtc.balanceOf(operatorAddress);
                      const endingAethWbtc = await aEthWbtc.balanceOf(operatorAddress);
                      const endingBtc2x = await btc2x.balanceOf(operatorAddress);
                      expect(endingWbtc).to.eq(initialWbtc.add(remainingWbtc));
                      expect(endingAethWbtc).to.eq(initialAethWbtc.add(remainingAethWbtc));
                      expect(endingBtc2x).to.eq(initialBtc2x.add(remainingBtc2x));

                      // Verify tokens are zeroed out on the migration extension
                      const finalWbtc = await wbtc.balanceOf(migrationExtension.address);
                      const finalAethWbtc = await aEthWbtc.balanceOf(migrationExtension.address);
                      const finalBtc2x = await btc2x.balanceOf(migrationExtension.address);
                      expect(finalWbtc).to.eq(ZERO);
                      expect(finalAethWbtc).to.eq(ZERO);
                      expect(finalBtc2x).to.eq(ZERO);
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}
