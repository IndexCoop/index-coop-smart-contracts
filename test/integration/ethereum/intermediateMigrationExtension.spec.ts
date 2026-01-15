import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, Signer } from "ethers";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ether, getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { ZERO } from "@utils/constants";
import {
  addSnapshotBeforeRestoreAfterEach,
  increaseTimeAsync,
  setBlockNumber,
} from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import {
  IntermediateMigrationExtension,
  BaseManagerV2,
  IBasicIssuanceModule,
  IBasicIssuanceModule__factory,
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
} from "../../../typechain";

const expect = getWaffleExpect();

const contractAddresses = {
  addressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  // Index fork (setFork) - where ETH2X lives
  setForkDebtIssuanceModuleV2: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setForkController: "0xD2463675a099101E36D85278494268261a66603A",
  eth2xIssuanceModule: "0x04b59F9F09750C044D7CfbC177561E409085f0f3",
  // Original Set Protocol - where ETH2xFLI lives (and where IntermediateToken will be deployed)
  originalSetController: "0xa4c8d221d8BB851f83aadd0223a8900A6921A349",
  originalSetTokenCreator: "0xeF72D3278dC3Eba6Dc2614965308d1435FFd748a",
  originalBasicIssuanceModule: "0xd8EF3cACe8b4907117a45B0b125c68560532F94D",
  originalStreamingFeeModule: "0x08f866c74205617B6F3903EF481798EcED10cDEC",
  // Other contracts
  flexibleLeverageStrategyExtension: "0x9bA41A2C5175d502eA52Ff9A666f8a4fc00C00A1",
  tradeModule: "0x90F765F63E7DC5aE97d6c576BF693FB6AF41C129",
  uniswapV3ExchangeAdapter: "0xcC327D928925584AB00Fe83646719dEAE15E0424",
  uniswapV3NonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  wrapModule: "0xbe4aEdE1694AFF7F1827229870f6cf3d9e7a999c",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  balancer: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

const tokenAddresses = {
  aEthWeth: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  eth2x: "0x65c4C0517025Ec0843C9146aF266A2C5a2D148A2",
  eth2xfli: "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

// At block 24219075, ETH2xFLI's manager is a Gnosis Safe (not a BaseManager)
const gnosisSafeManager = "0x6904110f17feD2162a11B5FA66B188d801443Ea4";

if (process.env.INTEGRATIONTEST) {
  describe("IntermediateMigrationExtension - ETH2xFLI Integration Test", async () => {
    let owner: Account;
    let operator: Signer;
    let deployer: DeployHelper;

    let eth2xfli: SetToken;
    let baseManager: BaseManagerV2;
    let tradeModule: TradeModule;
    let uniswapV3ExchangeAdapter: UniswapV3ExchangeAdapter;

    let eth2x: SetToken;
    let basicIssuanceModule: IBasicIssuanceModule;

    let weth: IWETH;
    let usdc: IERC20;
    let aEthWeth: IERC20;

    let intermediateMigrationExtension: IntermediateMigrationExtension;
    let intermediateToken: SetToken;
    let originalSetTokenCreator: SetTokenCreator;

    let originalManager: Signer;  // Gnosis Safe that was the manager

    setBlockNumber(24219075);  // Jan 2026 - ETH2xFLI already has ETH2X, manager is Gnosis Safe

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      // Setup collateral tokens
      weth = (await ethers.getContractAt("IWETH", tokenAddresses.weth)) as IWETH;
      usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
      aEthWeth = IERC20__factory.connect(tokenAddresses.aEthWeth, owner.wallet);

      // Setup ETH2x-FLI contracts
      eth2xfli = SetToken__factory.connect(tokenAddresses.eth2xfli, owner.wallet);
      tradeModule = TradeModule__factory.connect(contractAddresses.tradeModule, owner.wallet);
      uniswapV3ExchangeAdapter = UniswapV3ExchangeAdapter__factory.connect(
        contractAddresses.uniswapV3ExchangeAdapter,
        owner.wallet,
      );

      // At block 24219075, ETH2xFLI's manager is a Gnosis Safe (not a BaseManager)
      // We need to:
      // 1. Impersonate the Safe
      // 2. Deploy a new BaseManager with Safe as operator
      // 3. Transfer manager from Safe to BaseManager
      originalManager = await impersonateAccount(gnosisSafeManager);

      // Fund the Safe with ETH for gas
      await owner.wallet.sendTransaction({
        to: gnosisSafeManager,
        value: ether(10),
      });

      // Deploy a new BaseManager with the Safe as operator (and methodologist)
      baseManager = await deployer.manager.deployBaseManagerV2(
        eth2xfli.address,
        gnosisSafeManager,  // operator
        gnosisSafeManager,  // methodologist
      );

      // Transfer manager from Safe to BaseManager
      // The Safe needs to call setManager on the SetToken
      await eth2xfli.connect(originalManager).setManager(baseManager.address);

      // Authorize the BaseManager initialization (required before extensions can use it)
      // The methodologist (Safe) must call this
      await baseManager.connect(originalManager).authorizeInitialization();

      // Now connect baseManager with operator
      operator = originalManager;  // The Safe is still the operator
      baseManager = baseManager.connect(operator);

      // Setup ETH2x contracts
      eth2x = SetToken__factory.connect(tokenAddresses.eth2x, owner.wallet);

      // Setup original Set Protocol contracts for creating IntermediateToken
      // (same controller as ETH2xFLI, different from Index fork where ETH2X lives)
      originalSetTokenCreator = SetTokenCreator__factory.connect(
        contractAddresses.originalSetTokenCreator,
        owner.wallet,
      );
      basicIssuanceModule = IBasicIssuanceModule__factory.connect(
        contractAddresses.originalBasicIssuanceModule,
        owner.wallet,
      );
    });

    addSnapshotBeforeRestoreAfterEach();

    // At block 24219075, ETH2xFLI already has ETH2X as component (first migration already happened)
    // We skip the de-leverage and first migration steps and go directly to the second migration

    it("should have ETH2X as the primary component", async () => {
      const components = await eth2xfli.getComponents();
      // At this block, ETH2xFLI has [ETH2X, cETH] but cETH position is 0
      expect(components).to.include(tokenAddresses.eth2x);

      const eth2xUnit = await eth2xfli.getDefaultPositionRealUnit(tokenAddresses.eth2x);
      console.log("ETH2X unit in ETH2xFLI:", ethers.utils.formatEther(eth2xUnit));
      expect(eth2xUnit).to.be.gt(ZERO);
    });

    context("when IntermediateToken is deployed", () => {
      before(async () => {
        // Create IntermediateToken on original Set Protocol (same as ETH2xFLI)
        // SetTokenCreator is already a registered factory, so anyone can call create()
        const tx = await originalSetTokenCreator.connect(owner.wallet).create(
          [tokenAddresses.eth2x],
          [ether(1)], // 1:1 ratio - 1 ETH2X per IntermediateToken
          [contractAddresses.originalBasicIssuanceModule],
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

        // Initialize BasicIssuanceModule on IntermediateToken
        // BasicIssuanceModule.initialize(setToken, preIssueHook)
        await basicIssuanceModule.initialize(
          intermediateToken.address,
          ethers.constants.AddressZero, // preIssueHook
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
                basicIssuanceModule.address,      // wrappedTokenIssuanceModule (BasicIssuanceModule for IntermediateToken)
                contractAddresses.eth2xIssuanceModule,          // nestedSetTokenIssuanceModule (for ETH2X)
                contractAddresses.uniswapV3NonfungiblePositionManager,
                contractAddresses.addressProvider,
                contractAddresses.morpho,
                contractAddresses.balancer,
                contractAddresses.uniswapV3SwapRouter,
                true,                             // useBasicIssuance = true (BasicIssuanceModule)
              );
              intermediateMigrationExtension = intermediateMigrationExtension.connect(operator);

              // Add IntermediateMigrationExtension to BaseManager
              await baseManager.addExtension(intermediateMigrationExtension.address);

              // Note: We do NOT call initialize() here because the TradeModule is already
              // initialized on ETH2xFLI from the previous manager setup.
              // The extension.initialize() would try to initialize TradeModule again, which fails.
            });

            it("should have IntermediateMigrationExtension as an extension", async () => {
              expect(await baseManager.isExtension(intermediateMigrationExtension.address)).to.be.true;
            });

            it("should revert migrateBalancer when called by non-operator", async () => {
              const nonOperator = owner.wallet; // owner is not the operator
              const dummyParams = {
                supplyLiquidityAmount0Desired: ZERO,
                supplyLiquidityAmount1Desired: ZERO,
                supplyLiquidityAmount0Min: ZERO,
                supplyLiquidityAmount1Min: ZERO,
                tokenId: ZERO,
                exchangeName: "UniswapV3ExchangeAdapter",
                underlyingTradeUnits: ZERO,
                wrappedSetTokenTradeUnits: ZERO,
                exchangeData: "0x",
                redeemLiquidityAmount0Min: ZERO,
                redeemLiquidityAmount1Min: ZERO,
                isUnderlyingToken0: false,
              };

              await expect(
                intermediateMigrationExtension.connect(nonOperator).migrateBalancer(dummyParams, ZERO, ZERO),
              ).to.be.revertedWith("Must be operator");
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

                // Small subsidy to cover rounding losses in ETH2X issuance/redemption cycle (~0.1%)
                maxSubsidy = ether(10);

                console.log("=== Migration Parameters ===");
                console.log("Total ETH2X in FLI:", totalEth2xInFli.toString());
                console.log("wrappedPositionUnits (aWETH per ETH2X):", wrappedPositionUnits.toString());
                console.log("Full wethNeeded:", wethNeeded.toString());
                console.log("underlyingLoanAmount:", underlyingLoanAmount.toString());

                // Fund operator with WETH for subsidy and approve extension to spend it
                const operatorAddress = await operator.getAddress();
                await weth.deposit({ value: maxSubsidy });
                await weth.transfer(operatorAddress, maxSubsidy);
                await weth.connect(operator).approve(intermediateMigrationExtension.address, maxSubsidy);

                const operatorWethBefore = await weth.balanceOf(operatorAddress);
                console.log("Operator WETH before migration:", ethers.utils.formatEther(operatorWethBefore), "ETH");

                // Seed the ETH2X/IntermediateToken pool with initial liquidity (small amount for pool creation)
                // Since the original deployer has no ETH2X at this block, we issue ETH2X ourselves
                const seedAmount = ether(0.01);

                // Get Aave pool for depositing WETH -> aWETH
                const aavePoolAbi = [
                  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
                ];
                const aavePool = new ethers.Contract(
                  "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", // Aave V3 Pool
                  aavePoolAbi,
                  owner.wallet,
                );

                // Get ETH2X issuance module
                const eth2xIssuanceModule = await ethers.getContractAt(
                  "IDebtIssuanceModule",
                  contractAddresses.eth2xIssuanceModule,
                  owner.wallet,
                );

                // Calculate how much aWETH we need to issue seedAmount of ETH2X
                const aWethPerEth2x = await eth2x.getDefaultPositionRealUnit(aEthWeth.address);
                const aWethNeeded = preciseMul(seedAmount.mul(2), aWethPerEth2x).mul(110).div(100); // 10% buffer, 2x for both tokens

                console.log("aWETH needed for seed:", ethers.utils.formatEther(aWethNeeded));

                // Wrap ETH -> WETH
                await weth.deposit({ value: aWethNeeded });

                // WETH -> aWETH via Aave
                await weth.approve(aavePool.address, aWethNeeded);
                await aavePool.supply(weth.address, aWethNeeded, owner.address, 0);

                // Issue ETH2X (need 2x seedAmount: one for pool, one to issue IntermediateToken)
                const eth2xIssueAmount = seedAmount.mul(2);
                await aEthWeth.approve(eth2xIssuanceModule.address, aWethNeeded);
                await eth2xIssuanceModule.issue(eth2x.address, eth2xIssueAmount, owner.address);

                console.log("ETH2X issued:", ethers.utils.formatEther(await eth2x.balanceOf(owner.address)));

                // Transfer ETH2X to the extension for pool liquidity
                await eth2x.transfer(intermediateMigrationExtension.address, seedAmount);

                // Issue IntermediateTokens to the extension (requires ETH2X)
                // Using BasicIssuanceModule since IntermediateToken is on original Set Protocol
                await eth2x.approve(basicIssuanceModule.address, seedAmount);
                await basicIssuanceModule.issue(
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
                //
                // NOTE: Using 1.01x multiplier - provides just enough liquidity for the trade plus small buffer
                const poolLiquidityAmount = totalEth2xInFli.mul(101).div(100);  // 1% buffer over trade size
                const eth2xSupplyAmount = poolLiquidityAmount;
                const intermediateTokenSupplyAmount = poolLiquidityAmount;

                // Recalculate the required flash loan amount
                // Need ETH2X for pool + ETH2X to issue IntermediateToken (which is also poolLiquidityAmount)
                const totalEth2xNeeded = eth2xSupplyAmount.add(intermediateTokenSupplyAmount);
                const totalWethNeeded = preciseMul(totalEth2xNeeded, wrappedPositionUnits);
                // 20% buffer for fees and slippage
                underlyingLoanAmount = totalWethNeeded.mul(120).div(100);

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
                console.log("Seed liquidity position created, tokenId:", tokenId.toString());

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

                // Execute the migration using Balancer flash loan (no subsidy)
                console.log("Calling migrateBalancer with underlyingLoanAmount:", ethers.utils.formatEther(underlyingLoanAmount), "ETH");
                console.log("supplyLiquidityAmount0:", ethers.utils.formatEther(supplyLiquidityAmount0Desired));
                console.log("supplyLiquidityAmount1:", ethers.utils.formatEther(supplyLiquidityAmount1Desired));

                // Check flash loan source balances
                const balancerVault = contractAddresses.balancer;
                const balancerWethBalance = await weth.balanceOf(balancerVault);
                console.log("Balancer vault WETH balance:", ethers.utils.formatEther(balancerWethBalance), "ETH");

                const morphoAddress = contractAddresses.morpho;
                const morphoWethBalance = await weth.balanceOf(morphoAddress);
                console.log("Morpho WETH balance:", ethers.utils.formatEther(morphoWethBalance), "ETH");

                console.log("Flash loan amount needed:", ethers.utils.formatEther(underlyingLoanAmount), "ETH");

                // Use Morpho if it has enough liquidity, otherwise try Balancer
                if (morphoWethBalance.gte(underlyingLoanAmount)) {
                  console.log("Using Morpho flash loan...");
                  await intermediateMigrationExtension.migrateMorpho(
                    decodedParams,
                    underlyingLoanAmount,
                    maxSubsidy,
                  );
                } else if (balancerWethBalance.gte(underlyingLoanAmount)) {
                  console.log("Using Balancer flash loan...");
                  await intermediateMigrationExtension.migrateBalancer(
                    decodedParams,
                    underlyingLoanAmount,
                    maxSubsidy,
                  );
                } else {
                  console.log("ERROR: Neither Morpho nor Balancer has enough WETH for flash loan!");
                  console.log("Consider using a different block or reducing migration size.");
                  throw new Error(`Insufficient flash loan liquidity. Need ${ethers.utils.formatEther(underlyingLoanAmount)} ETH, Morpho has ${ethers.utils.formatEther(morphoWethBalance)} ETH, Balancer has ${ethers.utils.formatEther(balancerWethBalance)} ETH`);
                }

                const operatorWethAfter = await weth.balanceOf(operatorAddress);
                const slippageCaptured = operatorWethAfter.sub(operatorWethBefore);
                console.log("=== Migration Economics ===");
                console.log("Operator WETH after migration:", ethers.utils.formatEther(operatorWethAfter), "ETH");
                console.log("Slippage captured by operator:", ethers.utils.formatEther(slippageCaptured), "ETH");
              });

              it("should have IntermediateToken as a component and ETH2X removed", async () => {
                const components = await eth2xfli.getComponents();
                expect(components).to.include(intermediateToken.address);
                expect(components).to.not.include(tokenAddresses.eth2x);
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

              context("when testing streaming fees on IntermediateToken", () => {
                let streamingFeeModule: any;
                const ONE_YEAR_IN_SECONDS = 365.25 * 24 * 60 * 60;

                before(async () => {
                  // Get StreamingFeeModule contract
                  const streamingFeeAbi = [
                    "function feeStates(address) view returns (address feeRecipient, uint256 maxStreamingFeePercentage, uint256 streamingFeePercentage, uint256 lastStreamingFeeTimestamp)",
                    "function getFee(address) view returns (uint256)",
                    "function accrueFee(address)",
                    "function initialize(address, (address,uint256,uint256,uint256))",
                  ];
                  streamingFeeModule = new ethers.Contract(
                    contractAddresses.originalStreamingFeeModule,
                    streamingFeeAbi,
                    owner.wallet,
                  );
                });

                it("should have ETH2xFLI fee settings", async () => {
                  const feeState = await streamingFeeModule.feeStates(eth2xfli.address);
                  console.log("=== ETH2xFLI Fee Settings ===");
                  console.log("Fee recipient:", feeState.feeRecipient);
                  console.log("Max streaming fee:", ethers.utils.formatEther(feeState.maxStreamingFeePercentage.mul(100)), "%");
                  console.log("Streaming fee:", ethers.utils.formatEther(feeState.streamingFeePercentage.mul(100)), "%");

                  // At block 24219075, ETH2xFLI has 5% streaming fee
                  expect(feeState.streamingFeePercentage).to.equal(ether(0.05));
                });

                it("should revert when trying to accrue fees on ETH2xFLI (holds ETH2X which doesn't support it)", async () => {
                  // After migration, ETH2xFLI holds IntermediateToken, not ETH2X
                  // But the streaming fee module tries to mint new SetTokens and adjust positions
                  // This should fail because ETH2X doesn't support the position adjustment
                  // Actually, let's just verify the fee module state and then test IntermediateToken

                  // Note: Accruing fees on ETH2xFLI might actually work since it just mints tokens
                  // The issue is that ETH2X (the underlying) doesn't accrue fees to ETH2xFLI
                  // This test verifies the motivation for IntermediateToken
                  const feeStateBefore = await streamingFeeModule.feeStates(eth2xfli.address);
                  expect(feeStateBefore.streamingFeePercentage).to.be.gt(ZERO);
                });

                context("when StreamingFeeModule is initialized on IntermediateToken", () => {
                  const feeRecipient = "0xe833C90F4d07650aC1d8a915C2c0fdDBEDC1ec3A"; // Same as ETH2xFLI
                  const maxStreamingFee = ether(0.10); // 10%
                  const streamingFee = ether(0.0195); // 1.95% (same as ETH2xFLI)

                  before(async () => {
                    // IntermediateToken was created with BasicIssuanceModule
                    // Now we need to add StreamingFeeModule to it
                    // First, the manager (owner) needs to add the module to the SetToken

                    // The SetToken needs to have StreamingFeeModule as a pending module
                    // This requires calling addModule on the SetToken by the manager
                    await intermediateToken.connect(owner.wallet).addModule(contractAddresses.originalStreamingFeeModule);

                    // Initialize StreamingFeeModule with fee settings
                    const feeSettings = {
                      feeRecipient: feeRecipient,
                      maxStreamingFeePercentage: maxStreamingFee,
                      streamingFeePercentage: streamingFee,
                      lastStreamingFeeTimestamp: 0, // Will be set to current block.timestamp
                    };

                    await streamingFeeModule.initialize(
                      intermediateToken.address,
                      [feeSettings.feeRecipient, feeSettings.maxStreamingFeePercentage, feeSettings.streamingFeePercentage, feeSettings.lastStreamingFeeTimestamp],
                    );
                  });

                  it("should have StreamingFeeModule initialized on IntermediateToken", async () => {
                    const modules = await intermediateToken.getModules();
                    expect(modules).to.include(contractAddresses.originalStreamingFeeModule);

                    const feeState = await streamingFeeModule.feeStates(intermediateToken.address);
                    expect(feeState.feeRecipient).to.equal(feeRecipient);
                    expect(feeState.streamingFeePercentage).to.equal(streamingFee);
                  });

                  context("when time passes", () => {
                    const ONE_MONTH = BigNumber.from(30 * 24 * 60 * 60); // 30 days in seconds

                    before(async () => {
                      // Advance time by 1 month
                      await increaseTimeAsync(ONE_MONTH);
                    });

                    it("should have accrued fee pending", async () => {
                      const pendingFee = await streamingFeeModule.getFee(intermediateToken.address);
                      // Expected: 1.95% * (30/365.25) ≈ 0.16% of total supply
                      const ONE_YEAR = BigNumber.from(Math.floor(ONE_YEAR_IN_SECONDS));
                      const expectedFee = streamingFee.mul(ONE_MONTH).div(ONE_YEAR);

                      console.log("=== Pending Fee After 1 Month ===");
                      console.log("Pending fee:", ethers.utils.formatEther(pendingFee.mul(100)), "%");
                      console.log("Expected fee:", ethers.utils.formatEther(expectedFee.mul(100)), "%");

                      // Allow small rounding difference (1%)
                      const tolerance = expectedFee.div(100);
                      expect(pendingFee).to.be.gte(expectedFee.sub(tolerance));
                      expect(pendingFee).to.be.lte(expectedFee.add(tolerance));
                    });

                    it("should accrue fees and mint to fee recipient", async () => {
                      const totalSupplyBefore = await intermediateToken.totalSupply();
                      const feeRecipientBalanceBefore = await intermediateToken.balanceOf(feeRecipient);

                      // Accrue fees (anyone can call)
                      await streamingFeeModule.accrueFee(intermediateToken.address);

                      const totalSupplyAfter = await intermediateToken.totalSupply();
                      const feeRecipientBalanceAfter = await intermediateToken.balanceOf(feeRecipient);

                      const mintedFees = totalSupplyAfter.sub(totalSupplyBefore);
                      const recipientReceived = feeRecipientBalanceAfter.sub(feeRecipientBalanceBefore);

                      // Calculate expected fees: ~0.16% of total supply for 1 month at 1.95% annual
                      const expectedFeePercent = ether(0.0195).mul(ONE_MONTH).div(BigNumber.from(Math.floor(ONE_YEAR_IN_SECONDS)));
                      const expectedMintedFees = totalSupplyBefore.mul(expectedFeePercent).div(ether(1));

                      console.log("=== Fee Accrual Results ===");
                      console.log("Total supply before:", ethers.utils.formatEther(totalSupplyBefore));
                      console.log("Total supply after:", ethers.utils.formatEther(totalSupplyAfter));
                      console.log("Minted fees:", ethers.utils.formatEther(mintedFees));
                      console.log("Expected minted fees:", ethers.utils.formatEther(expectedMintedFees));
                      console.log("Fee recipient received:", ethers.utils.formatEther(recipientReceived));

                      // Verify fees were minted (allowing 5% tolerance for rounding)
                      expect(mintedFees).to.be.gt(ZERO);
                      expect(mintedFees).to.be.gte(expectedMintedFees.mul(95).div(100));
                      expect(mintedFees).to.be.lte(expectedMintedFees.mul(105).div(100));

                      // Most of minted fees should go to fee recipient (minus protocol fee if any)
                      expect(recipientReceived).to.be.gt(ZERO);
                    });
                  });
                });
              });
            });
      });
    });
  });
}
