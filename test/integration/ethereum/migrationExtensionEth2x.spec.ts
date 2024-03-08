import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { JsonRpcSigner } from "@ethersproject/providers";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ether, getAccounts, getWaffleExpect, preciseDiv, preciseMul } from "@utils/index";
import { ONE, ZERO } from "@utils/constants";
import {
  addSnapshotBeforeRestoreAfterEach,
  increaseTimeAsync,
  setBlockNumber,
} from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import {
  MigrationExtension,
  BaseManagerV2__factory,
  BaseManagerV2,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  FlexibleLeverageStrategyExtension,
  FlexibleLeverageStrategyExtension__factory,
  IERC20,
  IERC20__factory,
  IWETH,
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
  flexibleLeverageStrategyExtension: "0x9bA41A2C5175d502eA52Ff9A666f8a4fc00C00A1",
  tradeModule: "0x90F765F63E7DC5aE97d6c576BF693FB6AF41C129",
  uniswapV3ExchangeAdapter: "0xcC327D928925584AB00Fe83646719dEAE15E0424",
  uniswapV3NonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3Pool: "0xF44D4d68C2Ea473C93c1F3d2C81E900535d73843",
  wrapModule: "0xbe4aEdE1694AFF7F1827229870f6cf3d9e7a999c",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

const tokenAddresses = {
  aEthWeth: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  ceth: "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5",
  eth2x: "0x65c4C0517025Ec0843C9146aF266A2C5a2D148A2",
  eth2xfli: "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

const keeperAddresses = {
  eth2xfliKeeper: "0xEa80829C827f1633A46E7EA6026Ed693cA54eebD",
  eth2xDeployer: "0x37e6365d4f6aE378467b0e24c9065Ce5f06D70bF",
};

if (process.env.INTEGRATIONTEST) {
  describe("MigrationExtension - ETH2x-FLI Integration Test", async () => {
    let owner: Account;
    let operator: Signer;
    let keeper: Signer;
    let deployer: DeployHelper;

    let eth2xfli: SetToken;
    let baseManager: BaseManagerV2;
    let tradeModule: TradeModule;

    let eth2x: SetToken;
    let debtIssuanceModuleV2: DebtIssuanceModuleV2;

    let weth: IWETH;
    let ceth: IERC20;
    let usdc: IERC20;
    let aEthWeth: IERC20;

    let migrationExtension: MigrationExtension;

    setBlockNumber(19271340);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      // Setup collateral tokens
      weth = (await ethers.getContractAt("IWETH", tokenAddresses.weth)) as IWETH;
      ceth = IERC20__factory.connect(tokenAddresses.ceth, owner.wallet);
      usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
      aEthWeth = IERC20__factory.connect(tokenAddresses.aEthWeth, owner.wallet);

      // Setup ETH2x-FLI contracts
      eth2xfli = SetToken__factory.connect(tokenAddresses.eth2xfli, owner.wallet);
      baseManager = BaseManagerV2__factory.connect(await eth2xfli.manager(), owner.wallet);
      operator = await impersonateAccount(await baseManager.operator());
      baseManager = baseManager.connect(operator);
      tradeModule = TradeModule__factory.connect(contractAddresses.tradeModule, owner.wallet);
      keeper = await impersonateAccount(keeperAddresses.eth2xfliKeeper);

      // Setup ETH2x contracts
      eth2x = SetToken__factory.connect(tokenAddresses.eth2x, owner.wallet);
      debtIssuanceModuleV2 = DebtIssuanceModuleV2__factory.connect(
        contractAddresses.debtIssuanceModuleV2,
        owner.wallet,
      );

      // Deploy Migration Extension
      migrationExtension = await deployer.extensions.deployMigrationExtension(
        baseManager.address,
        weth.address,
        aEthWeth.address,
        eth2x.address,
        tradeModule.address,
        debtIssuanceModuleV2.address,
        contractAddresses.uniswapV3NonfungiblePositionManager,
        contractAddresses.addressProvider,
        contractAddresses.morpho,
        contractAddresses.balancer,
      );
      migrationExtension = migrationExtension.connect(operator);
    });

    addSnapshotBeforeRestoreAfterEach();

    context("when the product is de-levered", () => {
      let flexibleLeverageStrategyExtension: FlexibleLeverageStrategyExtension;

      before(async () => {
        flexibleLeverageStrategyExtension = FlexibleLeverageStrategyExtension__factory.connect(
          contractAddresses.flexibleLeverageStrategyExtension,
          operator,
        );

        // Adjust slippage tolerance for the test environment
        const oldExecution = await flexibleLeverageStrategyExtension.getExecution();
        const newExecution = {
          unutilizedLeveragePercentage: oldExecution.unutilizedLeveragePercentage,
          slippageTolerance: ether(0.15), // Increased slippage tolerance
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
        await flexibleLeverageStrategyExtension
          .connect(keeper)
          .rebalance("UniswapV3ExchangeAdapter");
        const firstRebalanceLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(firstRebalanceLeverage.lt(startingLeverage));
        increaseTimeAsync(oldExecution.twapCooldownPeriod);

        // Iterate rebalance, should lower leverage ratio
        await flexibleLeverageStrategyExtension
          .connect(keeper)
          .iterateRebalance("UniswapV3ExchangeAdapter");
        const secondRebalanceLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(secondRebalanceLeverage.lt(firstRebalanceLeverage));
        increaseTimeAsync(oldExecution.twapCooldownPeriod);

        // Iterate rebalance, should lower leverage ratio
        await flexibleLeverageStrategyExtension
          .connect(keeper)
          .iterateRebalance("UniswapV3ExchangeAdapter");
        const thirdRebalanceLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(thirdRebalanceLeverage.lt(secondRebalanceLeverage));
        increaseTimeAsync(oldExecution.twapCooldownPeriod);

        // Disengage from the strategy, should have 1 leverage ratio
        await flexibleLeverageStrategyExtension
          .connect(operator)
          .disengage("UniswapV3ExchangeAdapter");
      });

      it("should have leverage ratio of 1", async () => {
        const endingLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(endingLeverage.eq(ether(1)));
      });

      it("should have cETH and USDC as equity components", async () => {
        const components = await eth2xfli.getComponents();
        expect(components).to.deep.equal([tokenAddresses.ceth, tokenAddresses.usdc]);
      });

      context("when the cETH is unwrapped", () => {
        let wrapExtension: WrapExtension;

        before(async () => {
          // Deploy Wrap Extension
          wrapExtension = await deployer.extensions.deployWrapExtension(
            baseManager.address,
            contractAddresses.wrapModule,
          );

          // Add Wrap Module
          await baseManager.addModule(contractAddresses.wrapModule);

          // Add Wrap Extension
          await baseManager.addExtension(wrapExtension.address);

          // Initialize Wrap Extension
          await wrapExtension.connect(operator).initialize();

          // Unwrap cETH
          await wrapExtension
            .connect(operator)
            .unwrapWithEther(
              ceth.address,
              await eth2xfli.getTotalComponentRealUnits(ceth.address),
              "CompoundWrapAdapter",
            );
        });

        it("should have WETH as a component instead of cETH", async () => {
          const components = await eth2xfli.getComponents();
          await expect(components).to.deep.equal([tokenAddresses.weth, tokenAddresses.usdc]);
        });

        context("when migration extension is added as extension", () => {
          before(async () => {
            // Add Migration Extension
            await baseManager.addExtension(migrationExtension.address);
          });

          it("should have the MigrationExtension added as an extension", async () => {
            expect(await baseManager.isExtension(migrationExtension.address)).to.be.true;
          });

          context("when the trade module is added and initialized", () => {
            before(async () => {
              // Add Trade Module
              await baseManager.addModule(tradeModule.address);

              // Initialize Trade Module via Migration Extension
              await migrationExtension.initialize();
            });

            it("should have the TradeModule added as a module", async () => {
              expect(await eth2xfli.moduleStates(tradeModule.address)).to.equal(2);
            });

            context("when the USDC equity is traded away", () => {
              let uniswapV3ExchangeAdapter: UniswapV3ExchangeAdapter;

              before(async () => {
                uniswapV3ExchangeAdapter = UniswapV3ExchangeAdapter__factory.connect(
                  contractAddresses.uniswapV3ExchangeAdapter,
                  operator,
                );

                const exchangeName = "UniswapV3ExchangeAdapter";
                const usdcUnit = await eth2xfli.getDefaultPositionRealUnit(usdc.address);
                const exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                  [tokenAddresses.usdc, tokenAddresses.weth],
                  [BigNumber.from(500)],
                );

                // Trade USDC for WETH via Migration Extension
                await migrationExtension.trade(
                  exchangeName,
                  usdc.address,
                  usdcUnit,
                  weth.address,
                  0,
                  exchangeData,
                );
              });

              it("should remove USDC as a component", async () => {
                const components = await eth2xfli.getComponents();
                await expect(components).to.deep.equal([tokenAddresses.weth]);
              });

              context("when the Uniswap V3 liquidity position is minted", () => {
                before(async () => {
                  const tickLower = -34114;
                  const tickUpper = -34113;
                  const fee = 100;

                  const underlyingAmount = 0;
                  const wrappedSetTokenAmount = ether(0.01);

                  const isUnderlyingToken0 = false;

                  await eth2x
                    .connect(await impersonateAccount(keeperAddresses.eth2xDeployer))
                    .transfer(migrationExtension.address, wrappedSetTokenAmount);

                  // Mint liquidity position via Migration Extension
                  await migrationExtension.mintLiquidityPosition(
                    wrappedSetTokenAmount,
                    underlyingAmount,
                    ZERO,
                    ZERO,
                    tickLower,
                    tickUpper,
                    fee,
                    isUnderlyingToken0,
                  );
                });

                it("should seed the liquidity position", async () => {
                  const tokenId = await migrationExtension.tokenIds(0);
                  expect(tokenId).to.be.gt(0);
                });

                context("when the migration is ready", () => {
                  let underlyingLoanAmount: BigNumber;
                  let supplyLiquidityAmount0Desired: BigNumber;
                  let supplyLiquidityAmount1Desired: BigNumber;
                  let supplyLiquidityAmount0Min: BigNumber;
                  let supplyLiquidityAmount1Min: BigNumber;
                  let tokenId: BigNumber;
                  let exchangeName: string;
                  let underlyingTradeUnits: BigNumber;
                  let wrappedSetTokenTradeUnits: BigNumber;
                  let exchangeData: string;
                  let maxSubsidy: BigNumber;
                  let redeemLiquidityAmount0Min: BigNumber;
                  let redeemLiquidityAmount1Min: BigNumber;
                  let isUnderlyingToken0: boolean;

                  let wethWhale: JsonRpcSigner;

                  before(async () => {
                    const setTokenTotalSupply = await eth2xfli.totalSupply();
                    const wrappedPositionUnits = await eth2x.getDefaultPositionRealUnit(
                      aEthWeth.address,
                    );
                    const wrappedExchangeRate = preciseDiv(ether(1), wrappedPositionUnits);
                    maxSubsidy = ether(0.1);

                    // ETH2x-FLI trade parameters
                    underlyingTradeUnits = await eth2xfli.getDefaultPositionRealUnit(weth.address);
                    wrappedSetTokenTradeUnits = preciseMul(
                      preciseMul(wrappedExchangeRate, ether(0.999)),
                      underlyingTradeUnits,
                    );
                    exchangeName = "UniswapV3ExchangeAdapter";
                    exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                      [tokenAddresses.weth, tokenAddresses.eth2x],
                      [BigNumber.from(100)],
                    );

                    // Flash loan parameters
                    underlyingLoanAmount = preciseMul(underlyingTradeUnits, setTokenTotalSupply);

                    // Uniswap V3 liquidity parameters
                    supplyLiquidityAmount1Desired = ZERO;
                    supplyLiquidityAmount1Min = ZERO;
                    supplyLiquidityAmount0Desired = preciseMul(
                      preciseDiv(ether(1), wrappedPositionUnits),
                      underlyingLoanAmount,
                    );
                    supplyLiquidityAmount0Min = preciseMul(
                      supplyLiquidityAmount0Desired,
                      ether(0.99),
                    );
                    tokenId = await migrationExtension.tokenIds(0);
                    redeemLiquidityAmount0Min = ZERO;
                    redeemLiquidityAmount1Min = ZERO;
                    isUnderlyingToken0 = false;

                    // Subsidize 3.205 WETH to the migration extension
                    wethWhale = await impersonateAccount(
                      "0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6",
                    );
                    await weth.connect(wethWhale).transfer(await operator.getAddress(), maxSubsidy);
                    await weth.connect(operator).approve(migrationExtension.address, maxSubsidy);
                  });

                  it("should be able to migrate atomically", async () => {
                    const operatorAddress = await operator.getAddress();
                    const operatorWethBalanceBefore = await weth.balanceOf(operatorAddress);

                    // Verify starting components and units
                    const startingComponents = await eth2xfli.getComponents();
                    const startingUnit = await eth2xfli.getDefaultPositionRealUnit(
                      tokenAddresses.weth,
                    );
                    expect(startingComponents).to.deep.equal([tokenAddresses.weth]);
                    expect(startingUnit).to.eq(underlyingTradeUnits);

                    // Get the expected subsidy
                    const decodedParams = {
                      supplyLiquidityAmount0Desired,
                      supplyLiquidityAmount1Desired,
                      supplyLiquidityAmount0Min,
                      supplyLiquidityAmount1Min,
                      tokenId,
                      exchangeName,
                      underlyingTradeUnits,
                      wrappedSetTokenTradeUnits,
                      exchangeData,
                      redeemLiquidityAmount0Min,
                      redeemLiquidityAmount1Min,
                      isUnderlyingToken0,
                    };
                    const expectedOutput = await migrationExtension.callStatic.migrateBalancer(
                      decodedParams,
                      underlyingLoanAmount,
                      maxSubsidy,
                    );

                    // Migrate atomically via Migration Extension
                    await migrationExtension.migrateBalancer(
                      decodedParams,
                      underlyingLoanAmount,
                      maxSubsidy,
                    );

                    // Verify operator WETH balance change
                    const operatorWethBalanceAfter = await weth.balanceOf(operatorAddress);
                    expect(operatorWethBalanceBefore.sub(operatorWethBalanceAfter)).to.be.gte(
                      maxSubsidy.sub(expectedOutput).sub(ONE),
                    );

                    // Verify ending components and units
                    const endingComponents = await eth2xfli.getComponents();
                    const endingUnit = await eth2xfli.getDefaultPositionRealUnit(
                      tokenAddresses.eth2x,
                    );
                    expect(endingComponents).to.deep.equal([tokenAddresses.eth2x]);
                    expect(endingUnit).to.be.gt(wrappedSetTokenTradeUnits);
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
