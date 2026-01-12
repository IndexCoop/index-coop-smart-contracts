import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ether, getAccounts, getWaffleExpect, preciseDiv, preciseMul } from "@utils/index";
import { ZERO } from "@utils/constants";
import {
  addSnapshotBeforeRestoreAfterEach,
  increaseTimeAsync,
  setBlockNumber,
} from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import {
  MigrationExtension,
  IntermediateMigrationExtension,
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
  SetTokenCreator,
  SetTokenCreator__factory,
  TradeModule__factory,
  TradeModule,
  UniswapV3ExchangeAdapter,
  UniswapV3ExchangeAdapter__factory,
  WrapExtension,
} from "../../../typechain";

const expect = getWaffleExpect();

const contractAddresses = {
  addressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  // setFork uses a different DebtIssuanceModuleV2
  setForkDebtIssuanceModuleV2: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  eth2xIssuanceModule: "0x04b59F9F09750C044D7CfbC177561E409085f0f3",
  flexibleLeverageStrategyExtension: "0x9bA41A2C5175d502eA52Ff9A666f8a4fc00C00A1",
  tradeModule: "0x90F765F63E7DC5aE97d6c576BF693FB6AF41C129",
  uniswapV3ExchangeAdapter: "0xcC327D928925584AB00Fe83646719dEAE15E0424",
  uniswapV3NonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  wrapModule: "0xbe4aEdE1694AFF7F1827229870f6cf3d9e7a999c",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  setController: "0xD2463675a099101E36D85278494268261a66603A",
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
  describe("IntermediateMigrationExtension - ETH2xFLI Integration Test", async () => {
    let owner: Account;
    let operator: Signer;
    let keeper: Signer;
    let deployer: DeployHelper;

    let eth2xfli: SetToken;
    let baseManager: BaseManagerV2;
    let tradeModule: TradeModule;

    let eth2x: SetToken;
    let setForkDebtIssuanceModuleV2: DebtIssuanceModuleV2;
    let eth2xIssuanceModule: DebtIssuanceModuleV2;

    let weth: IWETH;
    let ceth: IERC20;
    let usdc: IERC20;
    let aEthWeth: IERC20;

    let migrationExtension: MigrationExtension;
    let intermediateMigrationExtension: IntermediateMigrationExtension;
    let intermediateToken: SetToken;
    let setTokenCreator: SetTokenCreator;

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
      // setFork controller uses a different DebtIssuanceModuleV2
      setForkDebtIssuanceModuleV2 = DebtIssuanceModuleV2__factory.connect(
        contractAddresses.setForkDebtIssuanceModuleV2,
        owner.wallet,
      );
      eth2xIssuanceModule = DebtIssuanceModuleV2__factory.connect(
        contractAddresses.eth2xIssuanceModule,
        owner.wallet,
      );

      // Setup SetTokenCreator for creating IntermediateToken
      setTokenCreator = SetTokenCreator__factory.connect(
        contractAddresses.setTokenCreator,
        owner.wallet,
      );

      // Deploy first Migration Extension (WETH → ETH2X)
      migrationExtension = await deployer.extensions.deployMigrationExtension(
        baseManager.address,
        weth.address,
        aEthWeth.address,
        eth2x.address,
        tradeModule.address,
        eth2xIssuanceModule.address,
        contractAddresses.uniswapV3NonfungiblePositionManager,
        contractAddresses.addressProvider,
        contractAddresses.morpho,
        contractAddresses.balancer,
      );
      migrationExtension = migrationExtension.connect(operator);
    });

    addSnapshotBeforeRestoreAfterEach();

    context("when the product is de-levered and has WETH as component", () => {
      let flexibleLeverageStrategyExtension: FlexibleLeverageStrategyExtension;
      let wrapExtension: WrapExtension;

      before(async () => {
        // De-leverage ETH2xFLI to 1x
        flexibleLeverageStrategyExtension = FlexibleLeverageStrategyExtension__factory.connect(
          contractAddresses.flexibleLeverageStrategyExtension,
          operator,
        );

        const oldExecution = await flexibleLeverageStrategyExtension.getExecution();
        const newExecution = {
          unutilizedLeveragePercentage: oldExecution.unutilizedLeveragePercentage,
          slippageTolerance: ether(0.15),
          twapCooldownPeriod: oldExecution.twapCooldownPeriod,
        };
        await flexibleLeverageStrategyExtension.setExecutionSettings(newExecution);

        const oldMethodology = await flexibleLeverageStrategyExtension.getMethodology();
        const newMethodology = {
          targetLeverageRatio: ether(1),
          minLeverageRatio: ether(0.9),
          maxLeverageRatio: ether(1),
          recenteringSpeed: oldMethodology.recenteringSpeed,
          rebalanceInterval: oldMethodology.rebalanceInterval,
        };
        await flexibleLeverageStrategyExtension.setMethodologySettings(newMethodology);

        // Rebalance to 1x leverage
        await flexibleLeverageStrategyExtension.connect(keeper).rebalance("UniswapV3ExchangeAdapter");
        await increaseTimeAsync(oldExecution.twapCooldownPeriod);
        await flexibleLeverageStrategyExtension.connect(keeper).iterateRebalance("UniswapV3ExchangeAdapter");
        await increaseTimeAsync(oldExecution.twapCooldownPeriod);
        await flexibleLeverageStrategyExtension.connect(keeper).iterateRebalance("UniswapV3ExchangeAdapter");
        await increaseTimeAsync(oldExecution.twapCooldownPeriod);
        await flexibleLeverageStrategyExtension.connect(operator).disengage("UniswapV3ExchangeAdapter");

        // Unwrap cETH to WETH
        wrapExtension = await deployer.extensions.deployWrapExtension(
          baseManager.address,
          contractAddresses.wrapModule,
        );
        await baseManager.addModule(contractAddresses.wrapModule);
        await baseManager.addExtension(wrapExtension.address);
        await wrapExtension.connect(operator).initialize();
        await wrapExtension
          .connect(operator)
          .unwrapWithEther(
            ceth.address,
            await eth2xfli.getTotalComponentRealUnits(ceth.address),
            "CompoundWrapAdapter",
          );

        // Add Migration Extension and Trade Module
        await baseManager.addExtension(migrationExtension.address);
        await baseManager.addModule(tradeModule.address);
        await migrationExtension.initialize();

        // Trade USDC for WETH
        const uniswapV3ExchangeAdapter = UniswapV3ExchangeAdapter__factory.connect(
          contractAddresses.uniswapV3ExchangeAdapter,
          operator,
        );
        const usdcUnit = await eth2xfli.getDefaultPositionRealUnit(usdc.address);
        const exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
          [tokenAddresses.usdc, tokenAddresses.weth],
          [BigNumber.from(500)],
        );
        await migrationExtension.trade(
          "UniswapV3ExchangeAdapter",
          usdc.address,
          usdcUnit,
          weth.address,
          0,
          exchangeData,
        );
      });

      it("should have only WETH as a component", async () => {
        const components = await eth2xfli.getComponents();
        expect(components).to.deep.equal([tokenAddresses.weth]);
      });

      context("when first migration (WETH → ETH2X) is completed", () => {
        let uniswapV3ExchangeAdapter: UniswapV3ExchangeAdapter;

        before(async () => {
          uniswapV3ExchangeAdapter = UniswapV3ExchangeAdapter__factory.connect(
            contractAddresses.uniswapV3ExchangeAdapter,
            operator,
          );

          // Seed the WETH/ETH2X pool with liquidity
          const tickLower = -34114;
          const tickUpper = -34113;
          const fee = 100;
          const underlyingAmount = 0;
          const wrappedSetTokenAmount = ether(0.01);
          const isUnderlyingToken0 = false;

          await eth2x
            .connect(await impersonateAccount(keeperAddresses.eth2xDeployer))
            .transfer(migrationExtension.address, wrappedSetTokenAmount);

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

          // Execute first migration (WETH → ETH2X)
          const setTokenTotalSupply = await eth2xfli.totalSupply();
          const wrappedPositionUnits = await eth2x.getDefaultPositionRealUnit(aEthWeth.address);
          const wrappedExchangeRate = preciseDiv(ether(1), wrappedPositionUnits);
          const maxSubsidy = ether(0.1);

          const underlyingTradeUnits = await eth2xfli.getDefaultPositionRealUnit(weth.address);
          const wrappedSetTokenTradeUnits = preciseMul(
            preciseMul(wrappedExchangeRate, ether(0.999)),
            underlyingTradeUnits,
          );

          const exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
            [tokenAddresses.weth, tokenAddresses.eth2x],
            [BigNumber.from(100)],
          );

          const underlyingLoanAmount = preciseMul(underlyingTradeUnits, setTokenTotalSupply);
          const supplyLiquidityAmount0Desired = preciseMul(
            preciseDiv(ether(1), wrappedPositionUnits),
            underlyingLoanAmount,
          );

          const tokenId = await migrationExtension.tokenIds(0);

          const wethWhale = await impersonateAccount("0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6");
          await weth.connect(wethWhale).transfer(await operator.getAddress(), maxSubsidy);
          await weth.connect(operator).approve(migrationExtension.address, maxSubsidy);

          const decodedParams = {
            supplyLiquidityAmount0Desired,
            supplyLiquidityAmount1Desired: ZERO,
            supplyLiquidityAmount0Min: preciseMul(supplyLiquidityAmount0Desired, ether(0.99)),
            supplyLiquidityAmount1Min: ZERO,
            tokenId,
            exchangeName: "UniswapV3ExchangeAdapter",
            underlyingTradeUnits,
            wrappedSetTokenTradeUnits,
            exchangeData,
            redeemLiquidityAmount0Min: ZERO,
            redeemLiquidityAmount1Min: ZERO,
            isUnderlyingToken0: false,
          };

          await migrationExtension.migrateBalancer(
            decodedParams,
            underlyingLoanAmount,
            maxSubsidy,
          );
        });

        it("should have ETH2X as the only component", async () => {
          const components = await eth2xfli.getComponents();
          expect(components).to.deep.equal([tokenAddresses.eth2x]);
        });

        context("when IntermediateToken is deployed", () => {
          before(async () => {
            // Get the controller owner to approve the owner
            const controllerAddress = contractAddresses.setController;
            const controller = await ethers.getContractAt("IController", controllerAddress);
            const controllerOwner = await controller.owner();
            const controllerOwnerSigner = await impersonateAccount(controllerOwner);

            // Fund the controller owner with ETH for gas
            await owner.wallet.sendTransaction({
              to: controllerOwner,
              value: ether(1),
            });

            // Add the owner as a factory to the controller so they can create SetTokens
            await controller.connect(controllerOwnerSigner).addFactory(owner.address);

            // Create IntermediateToken (SetToken with ETH2X as only component)
            // Note: Using setForkDebtIssuanceModuleV2 because the SetTokenCreator is from setFork controller
            const tx = await setTokenCreator.connect(owner.wallet).create(
              [tokenAddresses.eth2x],
              [ether(1)], // 1:1 ratio - 1 ETH2X per IntermediateToken
              [contractAddresses.setForkDebtIssuanceModuleV2],
              owner.address,
              "ETH2X Fee Wrapper",
              "ETH2XFW",
            );
            const receipt = await tx.wait();

            // Find the SetTokenCreated event to get the new token address
            const setTokenCreatedEvent = receipt.events?.find(
              (e: any) => e.event === "SetTokenCreated",
            );
            const intermediateTokenAddress = setTokenCreatedEvent?.args?._setToken;
            intermediateToken = SetToken__factory.connect(intermediateTokenAddress, owner.wallet);

            // Initialize DebtIssuanceModuleV2 on IntermediateToken
            await setForkDebtIssuanceModuleV2.initialize(
              intermediateToken.address,
              ether(0.01), // maxManagerFee
              ether(0), // managerIssueFee
              ether(0), // managerRedeemFee
              owner.address, // feeRecipient
              ethers.constants.AddressZero, // managerIssuanceHook
            );
          });

          it("should have IntermediateToken deployed with ETH2X as component", async () => {
            const components = await intermediateToken.getComponents();
            expect(components).to.deep.equal([tokenAddresses.eth2x]);
            const unit = await intermediateToken.getDefaultPositionRealUnit(tokenAddresses.eth2x);
            expect(unit).to.eq(ether(1));
          });

          context("when IntermediateMigrationExtension is deployed and initialized", () => {
            before(async () => {
              // Deploy IntermediateMigrationExtension
              // Note: The contract uses ETH2X/IntermediateToken pool (single-hop trade)
              // Parameters:
              // - wrappedSetToken = IntermediateToken (what we're migrating TO)
              // - nestedSetToken = ETH2X (inside IntermediateToken, also one side of the pool)
              // - issuanceModule = for IntermediateToken
              // - nestedSetTokenIssuanceModule = for ETH2X
              intermediateMigrationExtension = await deployer.extensions.deployIntermediateMigrationExtension(
                baseManager.address,              // manager
                weth.address,                     // underlyingToken (WETH)
                aEthWeth.address,                 // aaveToken (aWETH)
                usdc.address,                     // debtToken (USDC)
                intermediateToken.address,        // wrappedSetToken (IntermediateToken)
                eth2x.address,                    // nestedSetToken (ETH2X)
                tradeModule.address,              // tradeModule
                contractAddresses.setForkDebtIssuanceModuleV2,  // issuanceModule (for IntermediateToken)
                contractAddresses.eth2xIssuanceModule,          // nestedSetTokenIssuanceModule (for ETH2X)
                contractAddresses.uniswapV3NonfungiblePositionManager,
                contractAddresses.addressProvider,
                contractAddresses.morpho,
                contractAddresses.balancer,
                contractAddresses.uniswapV3SwapRouter,
              );
              intermediateMigrationExtension = intermediateMigrationExtension.connect(operator);

              // Add IntermediateMigrationExtension to BaseManager
              await baseManager.addExtension(intermediateMigrationExtension.address);

              // Note: We don't call initialize() here because the TradeModule was already
              // initialized during the first migration (via migrationExtension.initialize())
            });

            it("should have IntermediateMigrationExtension as an extension", async () => {
              expect(await baseManager.isExtension(intermediateMigrationExtension.address)).to.be.true;
            });

            context("when migration from ETH2X to IntermediateToken is executed", () => {
              let underlyingLoanAmount: BigNumber;
              let maxSubsidy: BigNumber;
              let eth2xUnitBefore: BigNumber;  // Store ETH2X position before migration

              before(async () => {
                // Calculate migration parameters
                const setTokenTotalSupply = await eth2xfli.totalSupply();
                const eth2xUnit = await eth2xfli.getDefaultPositionRealUnit(tokenAddresses.eth2x);
                eth2xUnitBefore = eth2xUnit;  // Save for comparison after migration
                const totalEth2xInFli = preciseMul(eth2xUnit, setTokenTotalSupply);

                // Get ETH2X composition to calculate WETH needed for issuing tokens
                const wrappedPositionUnits = await eth2x.getDefaultPositionRealUnit(aEthWeth.address);
                const wethNeeded = preciseMul(totalEth2xInFli, wrappedPositionUnits);
                underlyingLoanAmount = wethNeeded.mul(110).div(100); // 10% buffer

                maxSubsidy = ether(1);

                console.log("=== Migration Parameters ===");
                console.log("Total ETH2X in FLI:", totalEth2xInFli.toString());
                console.log("wrappedPositionUnits (aWETH per ETH2X):", wrappedPositionUnits.toString());
                console.log("Full wethNeeded:", wethNeeded.toString());
                console.log("underlyingLoanAmount:", underlyingLoanAmount.toString());

                // Fund operator with WETH for subsidy
                const wethWhale = await impersonateAccount("0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6");
                await weth.connect(wethWhale).transfer(await operator.getAddress(), maxSubsidy);
                await weth.connect(operator).approve(intermediateMigrationExtension.address, maxSubsidy);

                // Seed the ETH2X/IntermediateToken pool with initial liquidity (small amount for pool creation)
                const eth2xDeployer = await impersonateAccount(keeperAddresses.eth2xDeployer);
                const seedAmount = ether(0.01);

                console.log("ETH2X deployer balance:", (await eth2x.balanceOf(await eth2xDeployer.getAddress())).toString());

                // Send ETH2X to the extension for pool liquidity
                await eth2x.connect(eth2xDeployer).transfer(intermediateMigrationExtension.address, seedAmount);

                // Issue IntermediateTokens to the extension (requires ETH2X)
                await eth2x.connect(eth2xDeployer).approve(setForkDebtIssuanceModuleV2.address, seedAmount);
                await setForkDebtIssuanceModuleV2.connect(eth2xDeployer).issue(
                  intermediateToken.address,
                  seedAmount,
                  intermediateMigrationExtension.address,
                );

                // Trade parameters:
                // - underlyingTradeUnits: repurposed to mean ETH2X units to trade (single-hop now)
                // - wrappedSetTokenTradeUnits: IntermediateToken units expected
                const underlyingTradeUnits = eth2xUnit;  // ETH2X units to sell
                // With concentrated liquidity at 1:1 tick, expect minimal slippage (just pool fee ~0.3%)
                const wrappedSetTokenTradeUnits = preciseMul(eth2xUnit, ether(0.99)); // 1% slippage tolerance

                // Setup exchange data for UniswapV3 with SINGLE-HOP path:
                // ETH2X → IntermediateToken (direct)
                const exchangeData = await uniswapV3ExchangeAdapter.generateDataParam(
                  [tokenAddresses.eth2x, intermediateToken.address],
                  [BigNumber.from(3000)], // 0.3% fee tier for ETH2X/IntermediateToken pool
                );

                // Calculate liquidity amounts for ETH2X/IntermediateToken pool
                // The trade will swap totalEth2xInFli ETH2X for IntermediateToken.
                //
                // IMPORTANT: For Uniswap V3 at 1:1 price with full-range liquidity,
                // we must provide EQUAL amounts of both tokens. If amounts are unequal,
                // only the smaller amount is used from each side.
                //
                // We need enough IntermediateToken to absorb the trade (~totalEth2xInFli).
                // So we provide equal amounts: eth2xSupplyAmount = intermediateTokenSupplyAmount = totalEth2xInFli * 1.01
                //
                // Total ETH2X needed from loan = eth2xSupplyAmount + eth2xToIssueIntermediateToken
                //                              = totalEth2xInFli * 1.01 + totalEth2xInFli * 1.01
                //                              = totalEth2xInFli * 2.02
                const poolLiquidityAmount = totalEth2xInFli.mul(101).div(100);  // 1% buffer over trade size
                const eth2xSupplyAmount = poolLiquidityAmount;
                const intermediateTokenSupplyAmount = poolLiquidityAmount;

                // Recalculate the required flash loan amount
                // Need ETH2X for pool + ETH2X to issue IntermediateToken (which is also poolLiquidityAmount)
                const totalEth2xNeeded = eth2xSupplyAmount.add(intermediateTokenSupplyAmount);
                const totalWethNeeded = preciseMul(totalEth2xNeeded, wrappedPositionUnits);
                underlyingLoanAmount = totalWethNeeded.mul(110).div(100);  // 10% buffer for fees and slippage

                console.log("poolLiquidityAmount:", poolLiquidityAmount.toString());
                console.log("totalEth2xNeeded:", totalEth2xNeeded.toString());
                console.log("Updated underlyingLoanAmount:", underlyingLoanAmount.toString());

                // Determine token ordering for ETH2X/IntermediateToken pool
                // isNestedToken0 means "is ETH2X token0?"
                const isNestedToken0 =
                  tokenAddresses.eth2x.toLowerCase() < intermediateToken.address.toLowerCase();

                console.log("isNestedToken0 (ETH2X < IntermediateToken):", isNestedToken0);

                // Set FULL liquidity amounts for migration (will be issued during flash loan)
                const supplyLiquidityAmount0Desired = isNestedToken0 ? eth2xSupplyAmount : intermediateTokenSupplyAmount;
                const supplyLiquidityAmount1Desired = isNestedToken0 ? intermediateTokenSupplyAmount : eth2xSupplyAmount;

                // Set SEED amounts for initial pool creation (using tokens we already have)
                const seedAmount0 = isNestedToken0 ? seedAmount : seedAmount;
                const seedAmount1 = isNestedToken0 ? seedAmount : seedAmount;

                // CONCENTRATED liquidity at tick 0 (1:1 price)
                // With all liquidity at one tick, trade executes at that price with minimal slippage
                // Tick spacing for 0.3% fee tier is 60, so use tick 0 ± 60 for tightest range
                const tickLower = -60;
                const tickUpper = 60;

                // First, CREATE the ETH2X/IntermediateToken pool (it doesn't exist yet)
                const nonfungiblePositionManagerAbi = [
                  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)",
                ];
                const nonfungiblePositionManager = new ethers.Contract(
                  contractAddresses.uniswapV3NonfungiblePositionManager,
                  nonfungiblePositionManagerAbi,
                  owner.wallet,
                );

                // Calculate initial sqrtPriceX96 for 1:1 price ratio (1 ETH2X ≈ 1 IntermediateToken)
                // sqrtPriceX96 = sqrt(price) * 2^96 where price = token1/token0
                // For 1:1 ratio: sqrt(1) * 2^96 = 2^96
                const sqrtPriceX96 = BigNumber.from("79228162514264337593543950336"); // 2^96

                const token0 = isNestedToken0 ? tokenAddresses.eth2x : intermediateToken.address;
                const token1 = isNestedToken0 ? intermediateToken.address : tokenAddresses.eth2x;

                console.log("Creating ETH2X/IntermediateToken pool...");
                console.log("token0:", token0);
                console.log("token1:", token1);
                console.log("sqrtPriceX96:", sqrtPriceX96.toString());

                await nonfungiblePositionManager.createAndInitializePoolIfNecessary(
                  token0,
                  token1,
                  3000, // 0.3% fee tier
                  sqrtPriceX96,
                );

                // Mint initial liquidity position with SEED amounts (the tokens we already have)
                await intermediateMigrationExtension.mintLiquidityPosition(
                  seedAmount0,
                  seedAmount1,
                  ZERO,
                  ZERO,
                  tickLower,
                  tickUpper,
                  3000, // 0.3% fee tier
                  isNestedToken0,
                );

                const tokenId = await intermediateMigrationExtension.tokenIds(0);

                const decodedParams = {
                  supplyLiquidityAmount0Desired: supplyLiquidityAmount0Desired,
                  supplyLiquidityAmount1Desired: supplyLiquidityAmount1Desired,
                  supplyLiquidityAmount0Min: ZERO,
                  supplyLiquidityAmount1Min: ZERO,
                  tokenId: tokenId,
                  exchangeName: "UniswapV3ExchangeAdapter",
                  underlyingTradeUnits,          // ETH2X units to trade
                  wrappedSetTokenTradeUnits,     // IntermediateToken units expected
                  exchangeData,
                  redeemLiquidityAmount0Min: ZERO,
                  redeemLiquidityAmount1Min: ZERO,
                  isUnderlyingToken0: isNestedToken0,  // Repurposed: "is ETH2X token0?"
                };

                // Execute the migration using Balancer flash loan
                await intermediateMigrationExtension.migrateBalancer(
                  decodedParams,
                  underlyingLoanAmount,
                  maxSubsidy,
                );
              });

              it("should have IntermediateToken as the only component", async () => {
                const components = await eth2xfli.getComponents();
                expect(components).to.deep.equal([intermediateToken.address]);
              });

              it("should have positive IntermediateToken position", async () => {
                const unit = await eth2xfli.getDefaultPositionRealUnit(intermediateToken.address);
                expect(unit).to.be.gt(ZERO);
              });

              it("IntermediateToken should still have ETH2X as its only component", async () => {
                const components = await intermediateToken.getComponents();
                expect(components).to.deep.equal([tokenAddresses.eth2x]);
              });

              it("should preserve implied ETH2X exposure (within slippage tolerance)", async () => {
                // Get current IntermediateToken position in ETH2xFLI
                const intermediateTokenUnit = await eth2xfli.getDefaultPositionRealUnit(intermediateToken.address);

                // Get ETH2X per IntermediateToken (should be 1:1)
                const eth2xPerIntermediate = await intermediateToken.getDefaultPositionRealUnit(tokenAddresses.eth2x);

                // Calculate implied ETH2X position: IntermediateToken units * ETH2X per IntermediateToken
                const impliedEth2xUnit = preciseMul(intermediateTokenUnit, eth2xPerIntermediate);

                // Compare with position before migration
                // With concentrated liquidity at 1:1 tick, expect minimal slippage (~1% for fees + rounding)
                const slippageTolerance = ether(0.02); // 2% tolerance for fees and rounding
                const minExpected = preciseMul(eth2xUnitBefore, ether(1).sub(slippageTolerance));

                console.log("=== ETH2X Exposure Comparison ===");
                console.log("ETH2X unit before migration:", eth2xUnitBefore.toString());
                console.log("IntermediateToken unit after:", intermediateTokenUnit.toString());
                console.log("ETH2X per IntermediateToken:", eth2xPerIntermediate.toString());
                console.log("Implied ETH2X unit after:", impliedEth2xUnit.toString());
                console.log("Min expected (with slippage):", minExpected.toString());

                expect(impliedEth2xUnit).to.be.gte(minExpected);
              });
            });
          });
        });
      });
    });
  });
}
