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
  FLIRedemptionHelper,
  BaseManagerV2,
  IBasicIssuanceModule,
  IBasicIssuanceModule__factory,
  IERC20,
  IERC20__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  TradeModule__factory,
  TradeModule,
} from "../../../typechain";

const expect = getWaffleExpect();

const contractAddresses = {
  // addressProvider removed - using aavePool directly
  setForkDebtIssuanceModuleV2: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setForkController: "0xD2463675a099101E36D85278494268261a66603A",
  eth2xIssuanceModule: "0x04b59F9F09750C044D7CfbC177561E409085f0f3", // Used by both ETH2X and BTC2X
  originalSetController: "0xa4c8d221d8BB851f83aadd0223a8900A6921A349",
  originalSetTokenCreator: "0xeF72D3278dC3Eba6Dc2614965308d1435FFd748a",
  originalBasicIssuanceModule: "0xd8EF3cACe8b4907117a45B0b125c68560532F94D",
  originalStreamingFeeModule: "0x08f866c74205617B6F3903EF481798EcED10cDEC",
  tradeModule: "0x90F765F63E7DC5aE97d6c576BF693FB6AF41C129",
  uniswapV3NonfungiblePositionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  uniswapV3SwapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
};

const tokenAddresses = {
  aEthWeth: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  eth2x: "0x65c4C0517025Ec0843C9146aF266A2C5a2D148A2",
  eth2xfli: "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  aEthWbtc: "0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8",
  btc2x: "0xD2AC55cA3Bbd2Dd1e9936eC640dCb4b745fDe759",
  btc2xfli: "0x0B498ff89709d3838a063f1dFA463091F9801c2b",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

// At block 24219075, both ETH2xFLI and BTC2xFLI are managed by this Gnosis Safe
const gnosisSafeManager = "0x6904110f17feD2162a11B5FA66B188d801443Ea4";

// Token configuration for parameterized tests
interface MigrationTokenConfig {
  name: string;
  fliToken: string;
  nestedToken: string;
  underlyingToken: string;
  aToken: string;
  whale: string;  // Empty for WETH (can be deposited)
  fliWhale: string;  // FLI token holder for redemption tests
  fliIssuanceModule: string;  // BasicIssuanceModule for FLI
  seedAmount: BigNumber;
  tokenName: string;
  tokenSymbol: string;
  includeStreamingFeeTests: boolean;
}

const tokenConfigs: MigrationTokenConfig[] = [
  {
    name: "ETH2xFLI",
    fliToken: tokenAddresses.eth2xfli,
    nestedToken: tokenAddresses.eth2x,
    underlyingToken: tokenAddresses.weth,
    aToken: tokenAddresses.aEthWeth,
    whale: "",
    fliWhale: "0x65BdEf0e45b652E86973c3408c7cd24dDa9D844D",
    fliIssuanceModule: "0x69a592D2129415a4A1d1b1E309C17051B7F28d57", // DebtIssuanceModuleV2 (no hooks)
    seedAmount: ether(0.01),
    tokenName: "ETH2X Fee Wrapper",
    tokenSymbol: "ETH2XFW",
    includeStreamingFeeTests: true,
  },
  {
    name: "BTC2xFLI",
    fliToken: tokenAddresses.btc2xfli,
    nestedToken: tokenAddresses.btc2x,
    underlyingToken: tokenAddresses.wbtc,
    aToken: tokenAddresses.aEthWbtc,
    whale: "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46", // Curve tricrypto
    fliWhale: "0x4cb707b65d00eDeE22561e83c54923c5566640eb",
    fliIssuanceModule: "0x69a592D2129415a4A1d1b1E309C17051B7F28d57", // DebtIssuanceModuleV2 (no hooks)
    seedAmount: ether(0.001),
    tokenName: "BTC2X Fee Wrapper",
    tokenSymbol: "BTC2XFW",
    includeStreamingFeeTests: false,
  },
];

if (process.env.INTEGRATIONTEST) {
  tokenConfigs.forEach(config => {
    describe(`IntermediateMigrationExtension - ${config.name} Integration Test`, async () => {
      let owner: Account;
      let operator: Signer;
      let deployer: DeployHelper;

      let fliToken: SetToken;
      let nestedToken: SetToken;
      let baseManager: BaseManagerV2;
      let tradeModule: TradeModule;
      let basicIssuanceModule: IBasicIssuanceModule;

      let underlyingToken: IERC20;

      let intermediateMigrationExtension: IntermediateMigrationExtension;
      let intermediateToken: SetToken;
      let originalSetTokenCreator: SetTokenCreator;
      let fliRedemptionHelper: FLIRedemptionHelper;
      let fliIssuanceModule: IBasicIssuanceModule;

      let originalManager: Signer;
      let fliWhale: Signer;

      setBlockNumber(24310000);

      before(async () => {
        [owner] = await getAccounts();
        deployer = new DeployHelper(owner.wallet);

        // Setup tokens
        underlyingToken = IERC20__factory.connect(config.underlyingToken, owner.wallet);

        // Setup FLI contracts
        fliToken = SetToken__factory.connect(config.fliToken, owner.wallet);
        nestedToken = SetToken__factory.connect(config.nestedToken, owner.wallet);
        tradeModule = TradeModule__factory.connect(contractAddresses.tradeModule, owner.wallet);

        // Impersonate the Gnosis Safe manager
        originalManager = await impersonateAccount(gnosisSafeManager);
        await owner.wallet.sendTransaction({ to: gnosisSafeManager, value: ether(10) });

        // Deploy BaseManager with Safe as operator
        baseManager = await deployer.manager.deployBaseManagerV2(
          fliToken.address,
          gnosisSafeManager,
          gnosisSafeManager,
        );

        // Transfer manager from Safe to BaseManager
        await fliToken.connect(originalManager).setManager(baseManager.address);
        await baseManager.connect(originalManager).authorizeInitialization();

        operator = originalManager;
        baseManager = baseManager.connect(operator);

        // Setup original Set Protocol contracts
        originalSetTokenCreator = SetTokenCreator__factory.connect(
          contractAddresses.originalSetTokenCreator,
          owner.wallet,
        );
        basicIssuanceModule = IBasicIssuanceModule__factory.connect(
          contractAddresses.originalBasicIssuanceModule,
          owner.wallet,
        );

        // Setup FLI issuance module and whale for redemption tests
        fliIssuanceModule = IBasicIssuanceModule__factory.connect(
          config.fliIssuanceModule,
          owner.wallet,
        );
        fliWhale = await impersonateAccount(config.fliWhale);
        await owner.wallet.sendTransaction({ to: config.fliWhale, value: ether(1) });
      });

      addSnapshotBeforeRestoreAfterEach();

      it(`should have ${config.name.replace("FLI", "")} as the primary component`, async () => {
        const components = await fliToken.getComponents();
        expect(components).to.include(config.nestedToken);

        const nestedUnit = await fliToken.getDefaultPositionRealUnit(config.nestedToken);
        console.log(`${config.name.replace("FLI", "")} unit in ${config.name}:`, ethers.utils.formatEther(nestedUnit));
        expect(nestedUnit).to.be.gt(ZERO);
      });

      context("when IntermediateToken is deployed", () => {
        before(async () => {
          // Create IntermediateToken with owner as manager
          // (owner stays as manager so we can add StreamingFeeModule later)
          const tx = await originalSetTokenCreator.create(
            [config.nestedToken],
            [ether(1)],
            [contractAddresses.originalBasicIssuanceModule, contractAddresses.originalStreamingFeeModule],
            owner.address,
            config.tokenName,
            config.tokenSymbol,
          );
          const receipt = await tx.wait();
          const event = receipt.events?.find((e: any) => e.event === "SetTokenCreated");
          intermediateToken = SetToken__factory.connect(event?.args?._setToken, owner.wallet);

          // Initialize BasicIssuanceModule
          await basicIssuanceModule.initialize(intermediateToken.address, ethers.constants.AddressZero);
        });

        it("should have IntermediateToken deployed with nested token as component", async () => {
          const components = await intermediateToken.getComponents();
          expect(components).to.deep.equal([config.nestedToken]);
          const unit = await intermediateToken.getDefaultPositionRealUnit(config.nestedToken);
          expect(unit).to.eq(ether(1));
        });

        context("when IntermediateMigrationExtension is deployed", () => {
          before(async () => {
            intermediateMigrationExtension = await deployer.extensions.deployIntermediateMigrationExtension(
              baseManager.address,
              config.underlyingToken,
              config.aToken,
              tokenAddresses.usdc,
              intermediateToken.address,
              config.nestedToken,
              tradeModule.address,
              basicIssuanceModule.address,
              contractAddresses.eth2xIssuanceModule, // Both ETH2X and BTC2X use this module
              contractAddresses.uniswapV3NonfungiblePositionManager,
              contractAddresses.aavePool,
              contractAddresses.morpho,
              contractAddresses.uniswapV3SwapRouter,
              true,
            );
            intermediateMigrationExtension = intermediateMigrationExtension.connect(operator);
            await baseManager.addExtension(intermediateMigrationExtension.address);
          });

          it("should have IntermediateMigrationExtension as an extension", async () => {
            expect(await baseManager.isExtension(intermediateMigrationExtension.address)).to.be.true;
          });

          context("when testing FLIRedemptionHelper before migration", () => {
            before(async () => {
              // Deploy FLIRedemptionHelper
              fliRedemptionHelper = await deployer.extensions.deployFLIRedemptionHelper(
                fliToken.address,
                nestedToken.address,
                intermediateToken.address,
                fliIssuanceModule.address,
                basicIssuanceModule.address,
              );
            });

            it("should report not migrated", async () => {
              expect(await fliRedemptionHelper.isMigrated()).to.be.false;
            });

            it("should correctly calculate nested token received on redemption", async () => {
              const fliAmount = ether(1);
              const nestedUnit = await fliToken.getDefaultPositionRealUnit(config.nestedToken);
              const expectedNested = preciseMul(fliAmount, nestedUnit);
              const calculatedNested = await fliRedemptionHelper.getNestedTokenReceivedOnRedemption(fliAmount);
              expect(calculatedNested).to.eq(expectedNested);
            });

            it("should redeem FLI directly to nested token", async () => {
              const fliAmount = ether(1);
              const nestedUnit = await fliToken.getDefaultPositionRealUnit(config.nestedToken);
              const expectedNested = preciseMul(fliAmount, nestedUnit);

              const whaleBalanceBefore = await fliToken.balanceOf(config.fliWhale);
              const nestedBalanceBefore = await nestedToken.balanceOf(owner.address);

              // Whale approves and redeems
              await fliToken.connect(fliWhale).approve(fliRedemptionHelper.address, fliAmount);

              await fliRedemptionHelper.connect(fliWhale).redeem(fliAmount, owner.address);

              const whaleBalanceAfter = await fliToken.balanceOf(config.fliWhale);
              const nestedBalanceAfter = await nestedToken.balanceOf(owner.address);

              expect(whaleBalanceBefore.sub(whaleBalanceAfter)).to.eq(fliAmount);
              expect(nestedBalanceAfter.sub(nestedBalanceBefore)).to.eq(expectedNested);
            });
          });

          context("when migration is executed", () => {
            let nestedUnitBefore: BigNumber;

            before(async () => {
              // Calculate migration parameters
              const setTokenTotalSupply = await fliToken.totalSupply();
              const nestedUnit = await fliToken.getDefaultPositionRealUnit(config.nestedToken);
              nestedUnitBefore = nestedUnit;
              const totalNestedInFli = preciseMul(nestedUnit, setTokenTotalSupply);
              const wrappedPositionUnits = await nestedToken.getDefaultPositionRealUnit(config.aToken);

              console.log(`=== ${config.name} Atomic Migration Parameters ===`);
              console.log("Total nested token in FLI:", totalNestedInFli.toString());
              console.log("Wrapped position units (aToken per nested):", wrappedPositionUnits.toString());

              // Calculate pool parameters
              const poolLiquidityAmount = totalNestedInFli.mul(101).div(100);
              const totalNestedNeeded = poolLiquidityAmount.mul(2);
              const totalUnderlyingNeeded = preciseMul(totalNestedNeeded, wrappedPositionUnits);
              const underlyingLoanAmount = totalUnderlyingNeeded.mul(120).div(100);

              const isNestedToken0 = config.nestedToken.toLowerCase() < intermediateToken.address.toLowerCase();

              // Pool parameters
              const sqrtPriceX96 = BigNumber.from("79228162514264337593543950336"); // 1:1 price
              const poolFee = 500; // 0.05% fee tier (tick spacing = 10)
              const tickLower = -200;
              const tickUpper = 200;

              // Prepare migration parameters
              const underlyingTradeUnits = nestedUnit;
              const wrappedSetTokenTradeUnits = preciseMul(nestedUnit, ether(0.98)); // 2% tolerance

              const exchangeData = ethers.utils.solidityPack(
                ["address", "uint24", "address"],
                [config.nestedToken, poolFee, intermediateToken.address],
              );

              // Build atomic migration params (no tokenId needed, no external pool setup)
              const atomicParams = {
                supplyLiquidityAmount0Desired: poolLiquidityAmount,
                supplyLiquidityAmount1Desired: poolLiquidityAmount,
                supplyLiquidityAmount0Min: ZERO,
                supplyLiquidityAmount1Min: ZERO,
                exchangeName: "UniswapV3ExchangeAdapter",
                underlyingTradeUnits,
                wrappedSetTokenTradeUnits,
                exchangeData,
                redeemLiquidityAmount0Min: ZERO,
                redeemLiquidityAmount1Min: ZERO,
                isUnderlyingToken0: isNestedToken0,
                // Pool creation parameters
                tickLower,
                tickUpper,
                poolFee,
                sqrtPriceX96,
              };

              // Execute atomic migration using Morpho flash loan
              // No external pool creation or seed liquidity needed!
              const morphoBalance = await underlyingToken.balanceOf(contractAddresses.morpho);
              console.log("Morpho balance:", morphoBalance.toString());
              console.log("Flash loan amount needed:", underlyingLoanAmount.toString());
              console.log("Using atomic migration with Morpho flash loan...");

              // Execute atomic migration - creates pool, mints LP, trades, removes liquidity in one tx
              const tx = await intermediateMigrationExtension.migrateAtomicMorpho(
                atomicParams,
                underlyingLoanAmount,
                ZERO,
                { gasLimit: 15000000 },
              );
              await tx.wait();

              // Calculate profit returned to operator
              const underlyingReturned = await underlyingToken.balanceOf(gnosisSafeManager);

              console.log(`=== ${config.name} Atomic Migration Complete ===`);
              const isEth = config.name.includes("ETH");
              const formatAmount = (amount: BigNumber) => isEth
                ? ethers.utils.formatEther(amount)
                : ethers.utils.formatUnits(amount, 8);
              console.log(`Profit returned to operator: ${formatAmount(underlyingReturned)} ${isEth ? "ETH" : "WBTC"}`);
            });

            it("should have IntermediateToken as a component and nested token removed", async () => {
              const components = await fliToken.getComponents();
              expect(components).to.include(intermediateToken.address);
              expect(components).to.not.include(config.nestedToken);
            });

            it("should have positive IntermediateToken position", async () => {
              const unit = await fliToken.getDefaultPositionRealUnit(intermediateToken.address);
              expect(unit).to.be.gt(ZERO);
            });

            it("should preserve implied nested token exposure (within slippage tolerance)", async () => {
              const intermediateTokenUnit = await fliToken.getDefaultPositionRealUnit(intermediateToken.address);
              const nestedPerIntermediate = await intermediateToken.getDefaultPositionRealUnit(config.nestedToken);
              const impliedNestedUnit = preciseMul(intermediateTokenUnit, nestedPerIntermediate);

              const slippageTolerance = ether(0.02);
              const minExpected = preciseMul(nestedUnitBefore, ether(1).sub(slippageTolerance));

              console.log(`=== ${config.name.replace("FLI", "")} Exposure Comparison ===`);
              console.log("Nested unit before:", nestedUnitBefore.toString());
              console.log("Implied nested unit after:", impliedNestedUnit.toString());

              expect(impliedNestedUnit).to.be.gte(minExpected);
            });

            // Streaming fee tests (only for ETH2xFLI)
            if (config.includeStreamingFeeTests) {
              context("when testing streaming fees on IntermediateToken", () => {
                let streamingFeeModule: any;
                const ONE_YEAR_IN_SECONDS = 365.25 * 24 * 60 * 60;

                before(async () => {
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

                it("should have FLI fee settings", async () => {
                  const feeState = await streamingFeeModule.feeStates(fliToken.address);
                  expect(feeState.streamingFeePercentage).to.be.gt(ZERO);
                });

                it("should revert when trying to accrue fees on FLI (holds nested token which doesn't support it)", async () => {
                  const feeStateBefore = await streamingFeeModule.feeStates(fliToken.address);
                  expect(feeStateBefore.streamingFeePercentage).to.be.gt(ZERO);
                });

                context("when StreamingFeeModule is initialized on IntermediateToken", () => {
                  const feeRecipient = "0xe833C90F4d07650aC1d8a915C2c0fdDBEDC1ec3A";
                  const maxStreamingFee = ether(0.10);
                  const streamingFee = ether(0.0195);

                  before(async () => {
                    // StreamingFeeModule was already added in SetToken creation, just initialize it
                    await streamingFeeModule.initialize(
                      intermediateToken.address,
                      [feeRecipient, maxStreamingFee, streamingFee, 0],
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
                    const ONE_MONTH = BigNumber.from(30 * 24 * 60 * 60);

                    before(async () => {
                      await increaseTimeAsync(ONE_MONTH);
                    });

                    it("should have accrued fee pending", async () => {
                      const pendingFee = await streamingFeeModule.getFee(intermediateToken.address);
                      const ONE_YEAR = BigNumber.from(Math.floor(ONE_YEAR_IN_SECONDS));
                      const expectedFee = streamingFee.mul(ONE_MONTH).div(ONE_YEAR);
                      const tolerance = expectedFee.div(100);
                      expect(pendingFee).to.be.gte(expectedFee.sub(tolerance));
                      expect(pendingFee).to.be.lte(expectedFee.add(tolerance));
                    });

                    it("should accrue fees and mint to fee recipient", async () => {
                      const totalSupplyBefore = await intermediateToken.totalSupply();
                      const feeRecipientBalanceBefore = await intermediateToken.balanceOf(feeRecipient);

                      await streamingFeeModule.accrueFee(intermediateToken.address);

                      const totalSupplyAfter = await intermediateToken.totalSupply();
                      const mintedFees = totalSupplyAfter.sub(totalSupplyBefore);
                      const recipientReceived = (await intermediateToken.balanceOf(feeRecipient)).sub(feeRecipientBalanceBefore);

                      const ONE_MONTH = BigNumber.from(30 * 24 * 60 * 60);
                      const expectedFeePercent = ether(0.0195).mul(ONE_MONTH).div(BigNumber.from(Math.floor(ONE_YEAR_IN_SECONDS)));
                      const expectedMintedFees = totalSupplyBefore.mul(expectedFeePercent).div(ether(1));

                      expect(mintedFees).to.be.gt(ZERO);
                      expect(mintedFees).to.be.gte(expectedMintedFees.mul(95).div(100));
                      expect(mintedFees).to.be.lte(expectedMintedFees.mul(105).div(100));
                      expect(recipientReceived).to.be.gt(ZERO);
                    });
                  });
                });
              });
            }

            if (config.name === "ETH2xFLI") {
              it("IntermediateToken should still have nested token as its only component", async () => {
                const components = await intermediateToken.getComponents();
                expect(components).to.deep.equal([config.nestedToken]);
              });
            }

            context("when testing FLIRedemptionHelper after migration", () => {
              before(async () => {
                // Deploy FLIRedemptionHelper (or reuse if already deployed)
                if (!fliRedemptionHelper) {
                  fliRedemptionHelper = await deployer.extensions.deployFLIRedemptionHelper(
                    fliToken.address,
                    nestedToken.address,
                    intermediateToken.address,
                    fliIssuanceModule.address,
                    basicIssuanceModule.address,
                  );
                }
              });

              it("should report migrated", async () => {
                expect(await fliRedemptionHelper.isMigrated()).to.be.true;
              });

              it("should correctly calculate nested token received on redemption after migration", async () => {
                const fliAmount = ether(1);
                const intermediateUnit = await fliToken.getDefaultPositionRealUnit(intermediateToken.address);
                // IntermediateToken wraps nested token 1:1
                const expectedNested = preciseMul(fliAmount, intermediateUnit);
                const calculatedNested = await fliRedemptionHelper.getNestedTokenReceivedOnRedemption(fliAmount);
                expect(calculatedNested).to.eq(expectedNested);
              });

              it("should redeem FLI through IntermediateToken to nested token", async () => {
                const fliAmount = ether(0.1); // Smaller amount since whale may have less after other tests
                const intermediateUnit = await fliToken.getDefaultPositionRealUnit(intermediateToken.address);
                const expectedNested = preciseMul(fliAmount, intermediateUnit);

                const whaleBalanceBefore = await fliToken.balanceOf(config.fliWhale);
                const nestedBalanceBefore = await nestedToken.balanceOf(owner.address);

                // Whale approves and redeems
                await fliToken.connect(fliWhale).approve(fliRedemptionHelper.address, fliAmount);
                await fliRedemptionHelper.connect(fliWhale).redeem(fliAmount, owner.address);

                const whaleBalanceAfter = await fliToken.balanceOf(config.fliWhale);
                const nestedBalanceAfter = await nestedToken.balanceOf(owner.address);

                expect(whaleBalanceBefore.sub(whaleBalanceAfter)).to.eq(fliAmount);
                expect(nestedBalanceAfter.sub(nestedBalanceBefore)).to.eq(expectedNested);
              });
            });
          });
        });
      });
    });
  });
}
