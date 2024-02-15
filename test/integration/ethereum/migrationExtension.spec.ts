import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ether, getAccounts, getWaffleExpect } from "@utils/index";
import { addSnapshotBeforeRestoreAfterEach, increaseTimeAsync, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { MigrationExtension } from "@utils/contracts/index";
import {
  IWETH,
  SetToken,
  SetToken__factory,
  BaseManagerV2__factory,
  BaseManagerV2,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  TradeModule__factory,
  TradeModule,
  FlexibleLeverageStrategyExtension,
  FlexibleLeverageStrategyExtension__factory,
  IERC20__factory,
  IERC20,
  WrapExtension,
  UniswapV3ExchangeAdapter,
  UniswapV3ExchangeAdapter__factory,
} from "../../../typechain";
import { impersonateAccount } from "./utils";
import { ZERO } from "@utils/constants";
import { JsonRpcSigner } from "@ethersproject/providers";

const expect = getWaffleExpect();

const contractAddresses = {
  tradeModule: "0x90F765F63E7DC5aE97d6c576BF693FB6AF41C129",
  debtIssuanceModuleV2: "0x04b59F9F09750C044D7CfbC177561E409085f0f3",
  flexibleLeverageStrategyExtension: "0x9bA41A2C5175d502eA52Ff9A666f8a4fc00C00A1",
  uniswapV3Pool: "0xd57c7E2139a839Ad9d75c223a31C0C711b6E15F0",
  uniswapV3NonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  addressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  wrapModule: "0xbe4aEdE1694AFF7F1827229870f6cf3d9e7a999c",
  airdropExtension: "0x2Cf29FcA4273AA9706330626C9a2e1dCa9CBCAc1",
  uniswapV3ExchangeAdapter: "0xcC327D928925584AB00Fe83646719dEAE15E0424",
};

const tokenAddresses = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  eth2xfli: "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
  wrappedSetToken: "0xaC9Ef48865969dA2C7d190a6beDA58Ef46dd0679",
  ceth: "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const keeperAddresses = {
  eth2xfliKeeper: "0xEa80829C827f1633A46E7EA6026Ed693cA54eebD",
};

if (process.env.INTEGRATIONTEST) {
  describe.only("MigrationExtension - Integration Test", async () => {
    let owner: Account;
    let operator: Signer;
    let keeper: Signer;
    let deployer: DeployHelper;

    let setToken: SetToken;
    let baseManager: BaseManagerV2;
    let tradeModule: TradeModule;

    let wrappedSetToken: SetToken;
    let debtIssuanceModuleV2: DebtIssuanceModuleV2;

    let underlyingToken: IWETH;
    let ceth: IERC20;
    let usdc: IERC20;

    let migrationExtension: MigrationExtension;

    setBlockNumber(19214010);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      // Underlying Token setup (WETH)
      underlyingToken = (await ethers.getContractAt("IWETH", tokenAddresses.weth)) as IWETH;
      ceth = IERC20__factory.connect(tokenAddresses.ceth, owner.wallet);
      usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);

      // SetToken setup
      setToken = SetToken__factory.connect(tokenAddresses.eth2xfli, owner.wallet);
      baseManager = BaseManagerV2__factory.connect(await setToken.manager(), owner.wallet);
      operator = await impersonateAccount(await baseManager.operator());
      baseManager = baseManager.connect(operator);
      tradeModule = TradeModule__factory.connect(contractAddresses.tradeModule, owner.wallet);
      keeper = await impersonateAccount(keeperAddresses.eth2xfliKeeper);

      // Wrapped SetToken setup
      wrappedSetToken = SetToken__factory.connect(tokenAddresses.wrappedSetToken, owner.wallet);
      debtIssuanceModuleV2 = DebtIssuanceModuleV2__factory.connect(contractAddresses.debtIssuanceModuleV2, owner.wallet);

      // Deploy Migration Extension
      migrationExtension = await deployer.extensions.deployMigrationExtension(
        baseManager.address,
        underlyingToken.address,
        wrappedSetToken.address,
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

        // Increase slippage tolerance for testing
        const oldExecution = await flexibleLeverageStrategyExtension.getExecution();
        const newExecution = {
          unutilizedLeveragePercentage: oldExecution.unutilizedLeveragePercentage,
          slippageTolerance: ether(0.15),
          twapCooldownPeriod: oldExecution.twapCooldownPeriod,
        };
        flexibleLeverageStrategyExtension.setExecutionSettings(newExecution);

        // Set methodology settings to 1x leverage
        const oldMethodology = await flexibleLeverageStrategyExtension.getMethodology();
        const newMethodology = {
          targetLeverageRatio: ether(1),
          minLeverageRatio: ether(0.9),
          maxLeverageRatio: ether(1),
          recenteringSpeed: oldMethodology.recenteringSpeed,
          rebalanceInterval: oldMethodology.rebalanceInterval,
        };
        flexibleLeverageStrategyExtension.setMethodologySettings(newMethodology);

        // Initial Leverage Ratio (1.75, 2.25)
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

        // Iterate rebalance, should lower leverage ratio
        await flexibleLeverageStrategyExtension.connect(keeper).iterateRebalance("UniswapV3ExchangeAdapter");
        const thirdRebalanceLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(thirdRebalanceLeverage.lt(secondRebalanceLeverage));
        increaseTimeAsync(oldExecution.twapCooldownPeriod);

        // Disengage from the strategy, should have 1 leverage ratio
        await flexibleLeverageStrategyExtension.connect(operator).disengage("UniswapV3ExchangeAdapter");
      });

      it("should have leverage ratio of 1", async () => {
        const endingLeverage = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        expect(endingLeverage.eq(ether(1)));
      });

      it("should have cETH and USDC as equity components", async () => {
        const components = await setToken.getComponents();
        expect(components).to.deep.equal([tokenAddresses.ceth, tokenAddresses.usdc]);
      });

      context("when the cETH is unwrapped", () => {
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

          // Unwrap cETH
          await wrapExtension.connect(operator).unwrapWithEther(
            ceth.address,
            await setToken.getTotalComponentRealUnits(ceth.address),
            "CompoundWrapAdapter"
          );
        });

        it("should have WETH as a component instead of cETH", async () => {
          const components = await setToken.getComponents();
          await expect(components).to.deep.equal([tokenAddresses.weth, tokenAddresses.usdc]);
        });

        context("when migration extension is added as extension", () => {
          before(async () => {
            await baseManager.addExtension(migrationExtension.address);
          });

          it("should have the MigrationExtension added as an extension", async () => {
            expect(
              await baseManager.isExtension(migrationExtension.address)
            ).to.be.true;
          });

          context("when the trade module is added and initialized", () => {
            before(async () => {
              await baseManager.addModule(tradeModule.address);
              await migrationExtension.initialize();
            });

            it("should have the TradeModule added as a module", async () => {
              expect(
                await setToken.moduleStates(tradeModule.address)
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
                const usdcUnit = await setToken.getDefaultPositionRealUnit(usdc.address);
                const exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                  [tokenAddresses.usdc, tokenAddresses.weth],
                  [BigNumber.from(500)],
                );

                await migrationExtension.trade(
                  exchangeName,
                  usdc.address,
                  usdcUnit,
                  underlyingToken.address,
                  0,
                  exchangeData
                );
              });

              it("should remove USDC as a component", async () => {
                const components = await setToken.getComponents();
                await expect(components).to.deep.equal([tokenAddresses.weth]);
              });

              context("when the Uniswap V3 liquidity position is minted", () => {
                before(async () => {
                  const tickLower = -55215;
                  const tickUpper = -55214;
                  const fee = 100;

                  const underlyingAmount = 0;
                  const wrappedSetTokenAmount = ether(0.01);

                  await wrappedSetToken.connect(
                    await impersonateAccount("0x37e6365d4f6aE378467b0e24c9065Ce5f06D70bF")
                  ).transfer(migrationExtension.address, wrappedSetTokenAmount);

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

                  let setTokenTotalSupply: BigNumber;
                  let wethWhale: JsonRpcSigner;

                  before(async () => {
                    underlyingLoanAmount = ether(1);

                    underlyingSupplyLiquidityAmount = ZERO;
                    wrappedSetTokenSupplyLiquidityAmount = ether(250);

                    tokenId = await migrationExtension.tokenIds(0);

                    exchangeName = "UniswapV3ExchangeAdapter";

                    setTokenTotalSupply = await setToken.totalSupply();
                    underlyingTradeUnits = ether(1).mul(ether(1)).div(setTokenTotalSupply);
                    wrappedSetTokenTradeUnits = ether(249.9).mul(ether(1)).div(setTokenTotalSupply);

                    exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                      [tokenAddresses.weth, tokenAddresses.wrappedSetToken],
                      [BigNumber.from(100)],
                    );

                    underlyingRedeemLiquidityMinAmount = ether(0.95);
                    wrappedSetTokenRedeemLiquidityMinAmount = ZERO;

                    wethWhale = await impersonateAccount("0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6");
                  });

                  it("should be able to migrate non-atomically", async () => {
                    // Issue wrapped SetToken units to the extension
                    expect(await wrappedSetToken.balanceOf(migrationExtension.address)).to.be.eq(0);
                    const wethWhale = await impersonateAccount("0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6");
                    await underlyingToken.connect(wethWhale).approve(
                      debtIssuanceModuleV2.address,
                      ether(1)
                    );
                    await debtIssuanceModuleV2.connect(wethWhale).issue(
                      wrappedSetToken.address,
                      wrappedSetTokenSupplyLiquidityAmount,
                      migrationExtension.address
                    );
                    expect(await wrappedSetToken.balanceOf(migrationExtension.address)).to.be.eq(ether(250));

                    // Increase liquidity in Uniswap V3 pool
                    const wrappedSetTokenPoolBalanceBefore = await wrappedSetToken.balanceOf(contractAddresses.uniswapV3Pool);
                    expect(wrappedSetTokenPoolBalanceBefore).to.be.eq(ether(0.01).add(1));
                    await migrationExtension.increaseLiquidityPosition(
                      underlyingSupplyLiquidityAmount,
                      wrappedSetTokenSupplyLiquidityAmount,
                      tokenId
                    );
                    const wrappedSetTokenPoolBalanceAfter = await wrappedSetToken.balanceOf(contractAddresses.uniswapV3Pool);
                    expect(wrappedSetTokenPoolBalanceAfter).to.be.eq(ether(250).add(wrappedSetTokenPoolBalanceBefore));

                    // Trade underlying for wrapped SetToken
                    const setTokenUnderlyingBalanceBefore = await underlyingToken.balanceOf(setToken.address);
                    const wrappedSetTokenUnderlyingBalanceBefore = await wrappedSetToken.balanceOf(setToken.address);
                    await migrationExtension.trade(
                      exchangeName,
                      underlyingToken.address,
                      underlyingTradeUnits,
                      wrappedSetToken.address,
                      wrappedSetTokenTradeUnits,
                      exchangeData
                    );
                    const setTokenUnderlyingBalanceAfter = await underlyingToken.balanceOf(setToken.address);
                    const wrappedSetTokenUnderlyingBalanceAfter = await wrappedSetToken.balanceOf(setToken.address);
                    expect(setTokenUnderlyingBalanceAfter).to.be.eq(
                      setTokenUnderlyingBalanceBefore.sub(underlyingTradeUnits.mul(setTokenTotalSupply).div(ether(1)))
                    );
                    expect(wrappedSetTokenUnderlyingBalanceAfter).to.be.gt(
                      wrappedSetTokenUnderlyingBalanceBefore.add(wrappedSetTokenTradeUnits.mul(setTokenTotalSupply).div(ether(1)))
                    );

                    // Decrease liquidity in Uniswap V3 pool
                    const extensionUnderlyingBalanceBefore = await underlyingToken.balanceOf(migrationExtension.address);
                    const extensionWrappedBalanceBefore = await wrappedSetToken.balanceOf(migrationExtension.address);
                    expect(extensionUnderlyingBalanceBefore).to.be.eq(0);
                    expect(extensionWrappedBalanceBefore).to.be.eq(0);
                    const liquidity = await migrationExtension.tokenIdToLiquidity(tokenId);
                    await migrationExtension.decreaseLiquidityPosition(
                      tokenId,
                      liquidity,
                      underlyingRedeemLiquidityMinAmount,
                      wrappedSetTokenRedeemLiquidityMinAmount
                    );
                    const extensionUnderlyingBalanceAfter = await underlyingToken.balanceOf(migrationExtension.address);
                    const extensionWrappedBalanceAfter = await wrappedSetToken.balanceOf(migrationExtension.address);
                    expect(extensionUnderlyingBalanceAfter).to.be.gt(underlyingRedeemLiquidityMinAmount);
                    expect(extensionWrappedBalanceAfter).to.be.eq(0);
                  });

                  it.skip("should be able to migrate atomically", async () => {
                    await underlyingToken.connect(wethWhale).transfer(migrationExtension.address, ether(1.1));

                    const setTokenUnderlyingBalanceBefore = await underlyingToken.balanceOf(setToken.address);
                    const wrappedSetTokenUnderlyingBalanceBefore = await underlyingToken.balanceOf(wrappedSetToken.address);
                    const extensionUnderlyingBalanceBefore = await underlyingToken.balanceOf(migrationExtension.address);

                    const setTokenWrappedBalanceBefore = await wrappedSetToken.balanceOf(setToken.address);
                    const wrappedSetTokenTotalSupplyBefore = await wrappedSetToken.totalSupply();

                    console.log("Input Parameters");
                    console.log({
                      underlyingLoanAmount,
                      underlyingSupplyLiquidityAmount,
                      wrappedSetTokenSupplyLiquidityAmount,
                      tokenId,
                      exchangeName,
                      underlyingTradeUnits,
                      wrappedSetTokenTradeUnits,
                      exchangeData,
                      underlyingRedeemLiquidityMinAmount,
                      wrappedSetTokenRedeemLiquidityMinAmount,
                    });
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

                    const setTokenUnderlyingBalanceAfter = await underlyingToken.balanceOf(setToken.address);
                    const wrappedSetTokenUnderlyingBalanceAfter = await underlyingToken.balanceOf(wrappedSetToken.address);
                    const extensionUnderlyingBalanceAfter = await underlyingToken.balanceOf(migrationExtension.address);

                    const setTokenWrappedBalanceAfter = await wrappedSetToken.balanceOf(setToken.address);
                    const wrappedSetTokenTotalSupplyAfter = await wrappedSetToken.totalSupply();
                    const extensionWrappedBalanceAfter = await wrappedSetToken.balanceOf(migrationExtension.address);

                    expect(setTokenUnderlyingBalanceBefore.sub(setTokenUnderlyingBalanceAfter) == underlyingTradeUnits.mul(setTokenTotalSupply));
                    expect(wrappedSetTokenUnderlyingBalanceAfter.sub(wrappedSetTokenUnderlyingBalanceBefore) == wrappedSetTokenSupplyLiquidityAmount);
                    expect(extensionUnderlyingBalanceAfter).to.be.lt(extensionUnderlyingBalanceBefore);

                    expect(setTokenWrappedBalanceAfter.sub(setTokenWrappedBalanceBefore) == wrappedSetTokenTradeUnits.mul(setTokenTotalSupply));
                    expect(wrappedSetTokenTotalSupplyAfter == wrappedSetTokenTotalSupplyBefore.add(wrappedSetTokenSupplyLiquidityAmount));
                    expect(extensionWrappedBalanceAfter == ZERO);
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
