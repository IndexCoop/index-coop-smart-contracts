import "module-alias/register";

import {
  Address,
  Account,
  AaveContractSettings,
  Bytes,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings,
} from "@utils/types";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_INT_256, MAX_UINT_256 } from "@utils/constants";
import {
  BaseManager,
  TradeAdapterMock,
  ChainlinkAggregatorV3Mock,
  AaveLeverageStrategyExtension,
  ExchangeIssuanceLeveraged,
  StandardTokenMock,
  WETH9,
} from "@utils/contracts/index";
import { UniswapV2Router02 } from "@utils/contracts/uniswap";
import { AaveLeverageModule, DebtIssuanceModule, SetToken } from "@utils/contracts/setV2";
import { AaveV2AToken } from "@typechain/AaveV2AToken";
import { AaveV2VariableDebtToken } from "@typechain/AaveV2VariableDebtToken";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAaveV2Fixture,
  getAccounts,
  getLastBlockTimestamp,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
  usdc,
  getUniswapV3Fixture,
  preciseMul,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { AaveV2Fixture, SetFixture, UniswapFixture, UniswapV3Fixture } from "@utils/fixtures";
import { BigNumber, utils, ContractTransaction } from "ethers";
import { getTxFee } from "@utils/test";

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

const expect = getWaffleExpect();

describe("ExchangeIssuanceLeveraged", async () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let aaveSetup: AaveV2Fixture;

  let exchangeIssuance: ExchangeIssuanceLeveraged;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let collateralToken: StandardTokenMock | WETH9;
  let collateralLiquidity: BigNumber;
  let collateralLiquidityEther: BigNumber;
  let collateralAToken: AaveV2AToken;
  let usdcVariableDebtToken: AaveV2VariableDebtToken;
  let tradeAdapterMock: TradeAdapterMock;
  let tradeAdapterMock2: TradeAdapterMock;

  let strategy: AaveContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;
  let exchangeName: string;
  let exchangeSettings: ExchangeSettings;

  let leverageStrategyExtension: AaveLeverageStrategyExtension;
  let aaveLeverageModule: AaveLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let baseManagerV2: BaseManager;

  let chainlinkCollateralPriceMock: ChainlinkAggregatorV3Mock;
  let chainlinkBorrowPriceMock: ChainlinkAggregatorV3Mock;

  let wethAddress: Address;
  let wbtcAddress: Address;
  let daiAddress: Address;
  let quickswapRouter: UniswapV2Router02;
  let sushiswapRouter: UniswapV2Router02;
  let uniswapV3RouterAddress: Address;
  let controllerAddress: Address;
  let debtIssuanceModuleAddress: Address;
  let aaveAddressProviderAddress: Address;
  let curveCalculatorAddress: Address;
  let curveAddressProviderAddress: Address;

  let quickswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let uniswapV3Setup: UniswapV3Fixture;
  let setTokenInitialBalance: BigNumber;

  cacheBeforeEach(async () => {
    [owner, methodologist] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    collateralToken = setV2Setup.weth;
    collateralLiquidity = UnitsUtils.ether(1000);
    collateralLiquidityEther = UnitsUtils.ether(1000);

    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(collateralToken.address, setV2Setup.dai.address);

    const usdcReserveTokens = await aaveSetup.createAndEnableReserve(
      setV2Setup.usdc.address,
      "USDC",
      6,
      BigNumber.from(7500), // base LTV: 75%
      BigNumber.from(8000), // liquidation threshold: 80%
      BigNumber.from(10500), // liquidation bonus: 105.00%
      BigNumber.from(1000), // reserve factor: 10%
      true, // enable borrowing on reserve
      true, // enable stable debts
    );

    usdcVariableDebtToken = usdcReserveTokens.variableDebtToken;

    collateralAToken = aaveSetup.wethReserveTokens.aToken;

    const oneRay = BigNumber.from(10).pow(27); // 1e27
    await aaveSetup.setMarketBorrowRate(setV2Setup.usdc.address, oneRay.mul(39).div(1000));
    await aaveSetup.setAssetPriceInOracle(setV2Setup.usdc.address, ether(0.001));

    // Mint aTokens
    await collateralToken.approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool.deposit(collateralToken.address, ether(1000), owner.address, 0);
    await setV2Setup.usdc.approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool.deposit(setV2Setup.usdc.address, usdc(2000000), owner.address, 0);

    // Deploy Aave leverage module and add to controller
    aaveLeverageModule = await deployer.setV2.deployAaveLeverageModule(
      setV2Setup.controller.address,
      aaveSetup.lendingPoolAddressesProvider.address,
      aaveSetup.protocolDataProvider.address,
    );
    await setV2Setup.controller.addModule(aaveLeverageModule.address);

    debtIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(
      setV2Setup.controller.address,
    );
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    // Deploy mock trade adapter
    tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );

    // Deploy mock trade adapter 2
    tradeAdapterMock2 = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "MockTradeAdapter2",
      tradeAdapterMock2.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );

    // Deploy Chainlink mocks
    chainlinkCollateralPriceMock = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
    chainlinkBorrowPriceMock = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkBorrowPriceMock.setPrice(10 ** 8);

    await initializeRootScopeContracts();

    wethAddress = setV2Setup.weth.address;
    wbtcAddress = setV2Setup.wbtc.address;
    daiAddress = setV2Setup.dai.address;

    quickswapSetup = getUniswapFixture(owner.address);
    await quickswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    // Set integrations for AaveLeverageModule
    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "UniswapTradeAdapter",
      quickswapSetup.uniswapTradeAdapter.address,
    );
    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    uniswapV3Setup = getUniswapV3Fixture(owner.address);
    await uniswapV3Setup.initialize(owner, setV2Setup.weth, 3000, setV2Setup.wbtc, 40000, setV2Setup.dai);
    uniswapV3RouterAddress = uniswapV3Setup.swapRouter.address;
    await uniswapV3Setup.createNewPair(setV2Setup.weth, setV2Setup.usdc, 3000, 3000);
    await setV2Setup.weth.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
    await setV2Setup.usdc.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
    await uniswapV3Setup.addLiquidityWide(
      setV2Setup.weth,
      setV2Setup.usdc,
      3000,
      ether(100),
      usdc(300_000),
      owner.address
    );

    setTokenInitialBalance = ether(1);
    await collateralAToken.approve(debtIssuanceModule.address, MAX_UINT_256);
    await debtIssuanceModule.issue(setToken.address, setTokenInitialBalance, owner.address);
    // Engage aave fli
    await collateralToken.transfer(tradeAdapterMock.address, setTokenInitialBalance.mul(10));
    await leverageStrategyExtension.engage(exchangeName);

    quickswapRouter = quickswapSetup.router;
    sushiswapRouter = sushiswapSetup.router;
    controllerAddress = setV2Setup.controller.address;
    debtIssuanceModuleAddress = debtIssuanceModule.address;
    aaveAddressProviderAddress = aaveSetup.lendingPoolAddressesProvider.address;
    curveCalculatorAddress = ADDRESS_ZERO;
    curveAddressProviderAddress = ADDRESS_ZERO;

    // ETH-USDC pools
    await setV2Setup.usdc.connect(owner.wallet).approve(quickswapRouter.address, MAX_INT_256);
    await collateralToken.connect(owner.wallet).approve(quickswapRouter.address, MAX_INT_256);
    // Set up quickswap with sufficient liquidity
    await quickswapRouter
      .connect(owner.wallet)
      .addLiquidityETH(
        setV2Setup.usdc.address,
        UnitsUtils.usdc(100000),
        MAX_UINT_256,
        MAX_UINT_256,
        owner.address,
        (await getLastBlockTimestamp()).add(1),
        { value: ether(100), gasLimit: 9000000 },
      );

    if (collateralToken.address !== wethAddress) {
      await quickswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          collateralToken.address,
          collateralLiquidity,
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: collateralLiquidityEther, gasLimit: 9000000 },
        );
    }
  });

  const initializeRootScopeContracts = async () => {
    setToken = await setV2Setup.createSetToken(
      [collateralAToken.address],
      [ether(1)],
      [
        setV2Setup.issuanceModule.address,
        setV2Setup.streamingFeeModule.address,
        aaveLeverageModule.address,
        debtIssuanceModule.address,
      ],
    );
    await aaveLeverageModule.updateAnySetAllowed(true);

    // Initialize modules
    await debtIssuanceModule.initialize(
      setToken.address,
      ether(1),
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO,
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(0.1);
    const streamingFeePercentage = ether(0.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);
    await aaveLeverageModule.initialize(
      setToken.address,
      [collateralToken.address],
      [setV2Setup.usdc.address],
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
      leverageModule: aaveLeverageModule.address,
      aaveProtocolDataProvider: aaveSetup.protocolDataProvider.address,
      collateralPriceOracle: chainlinkCollateralPriceMock.address,
      borrowPriceOracle: chainlinkBorrowPriceMock.address,
      targetCollateralAToken: collateralAToken.address,
      targetBorrowDebtToken: usdcVariableDebtToken.address,
      collateralAsset: collateralToken.address,
      borrowAsset: setV2Setup.usdc.address,
      collateralDecimalAdjustment: BigNumber.from(10),
      borrowDecimalAdjustment: BigNumber.from(22),
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
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
    };
    incentive = {
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };
    exchangeName = "MockTradeAdapter";
    exchangeSettings = {
      twapMaxTradeSize: twapMaxTradeSize,
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
      exchangeLastTradeTimestamp: BigNumber.from(0),
      leverExchangeData: EMPTY_BYTES,
      deleverExchangeData: EMPTY_BYTES,
    };

    leverageStrategyExtension = await deployer.extensions.deployAaveLeverageStrategyExtension(
      baseManagerV2.address,
      strategy,
      methodology,
      execution,
      incentive,
      [exchangeName],
      [exchangeSettings],
    );

    // Add adapter
    await baseManagerV2.connect(owner.wallet).addAdapter(leverageStrategyExtension.address);
  };

  describe("#constructor", async () => {
    cacheBeforeEach(async () => {});

    async function subject(): Promise<ExchangeIssuanceLeveraged> {
      const result = await deployer.extensions.deployExchangeIssuanceLeveraged(
        wethAddress,
        quickswapRouter.address,
        sushiswapRouter.address,
        uniswapV3RouterAddress,
        uniswapV3Setup.quoter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        aaveLeverageModule.address,
        aaveAddressProviderAddress,
        curveCalculatorAddress,
        curveAddressProviderAddress,
      );
      return result;
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceLeveraged = await subject();

      const addresses = await exchangeIssuanceContract.addresses();
      expect(addresses.weth).to.eq(wethAddress);

      expect(addresses.quickRouter).to.eq(quickswapRouter.address);

      expect(addresses.sushiRouter).to.eq(sushiswapRouter.address);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(controllerAddress);

      const expectedDebtIssuanceModuleAddress = await exchangeIssuanceContract.debtIssuanceModule();
      expect(expectedDebtIssuanceModuleAddress).to.eq(debtIssuanceModuleAddress);
    });
  });

  describe("When exchangeIssuance is deployed", () => {
    let ethAddress: Address;
    beforeEach(async () => {
      exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
        wethAddress,
        quickswapRouter.address,
        sushiswapRouter.address,
        uniswapV3RouterAddress,
        uniswapV3Setup.quoter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        aaveLeverageModule.address,
        aaveAddressProviderAddress,
        curveCalculatorAddress,
        curveAddressProviderAddress,
      );
      ethAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    });
    describe("#approveSetToken", async () => {
      let subjectSetToken: Address;
      beforeEach(async () => {
        subjectSetToken = setToken.address;
      });
      async function subject() {
        await exchangeIssuance.approveSetToken(subjectSetToken);
      }
      it("should succeed", async () => {
        await subject();
      });
      it("should approve underlying collateral token to lending pool", async () => {
        const allowanceBefore = await collateralToken.allowance(
          exchangeIssuance.address,
          aaveSetup.lendingPool.address,
        );
        expect(allowanceBefore).to.equal(ZERO);
        await subject();
        const allowanceAfter = await collateralToken.allowance(
          exchangeIssuance.address,
          aaveSetup.lendingPool.address,
        );
        expect(allowanceAfter).to.equal(MAX_UINT_256);
      });
    });

    describe("#getLeveragedTokenData", async () => {
      let subjectSetToken: Address;
      let subjectSetAmount: BigNumber;
      let subjectIsIssuance: boolean;
      async function subject() {
        return await exchangeIssuance.getLeveragedTokenData(
          subjectSetToken,
          subjectSetAmount,
          subjectIsIssuance,
        );
      }
      context("when passed the FLI token", async () => {
        beforeEach(() => {
          subjectSetToken = setToken.address;
          subjectSetAmount = ether(1);
          subjectIsIssuance = true;
        });
        it("should return correct data", async () => {
          const {
            collateralToken: collateralTokenReturned,
            collateralAToken,
            debtToken,
            collateralAmount,
            debtAmount,
          } = await subject();
          expect(collateralAToken).to.eq(strategy.targetCollateralAToken);
          expect(collateralTokenReturned).to.eq(collateralToken.address);
          expect(debtToken).to.eq(strategy.borrowAsset);
          expect(collateralAmount).to.be.gt(ZERO);
          expect(debtAmount).to.be.gt(ZERO);
        });
      });
    });

    ["CollateralToken", "ERC20", "ETH"].forEach(tokenName => {
      describe(`#redeemExactSetFor${tokenName == "CollateralToken" ? "ERC20" : tokenName} ${
        tokenName == "CollateralToken" ? "paying with CollateralToken" : ""
      }`, async () => {
        let subjectSetToken: Address;
        let subjectSetAmount: BigNumber;
        let subjectMinAmountOutput: BigNumber;
        let exchange: Exchange;
        let subjectCollateralForDebtSwapData: SwapData;
        let subjectOutputTokenSwapData: SwapData;
        let amountReturned: BigNumber;
        let collateralAmount: BigNumber;
        let subjectOutputToken: Address;
        let outputToken: StandardTokenMock | WETH9;

        async function subject() {
          if (tokenName === "CollateralToken") {
            return await exchangeIssuance.redeemExactSetForERC20(
              subjectSetToken,
              subjectSetAmount,
              collateralToken.address,
              subjectMinAmountOutput,
              subjectCollateralForDebtSwapData,
              subjectOutputTokenSwapData,
            );
          } else if (tokenName === "ERC20") {
            return await exchangeIssuance.redeemExactSetForERC20(
              subjectSetToken,
              subjectSetAmount,
              subjectOutputToken,
              subjectMinAmountOutput,
              subjectCollateralForDebtSwapData,
              subjectOutputTokenSwapData,
            );
          } else {
            return await exchangeIssuance.redeemExactSetForETH(
              subjectSetToken,
              subjectSetAmount,
              subjectMinAmountOutput,
              subjectCollateralForDebtSwapData,
              subjectOutputTokenSwapData,
            );
          }
        }
        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectSetAmount = ether(1);
          exchange = Exchange.Quickswap;
          ({ collateralAmount } = await exchangeIssuance.getLeveragedTokenData(
            subjectSetToken,
            subjectSetAmount,
            false,
          ));
          subjectMinAmountOutput = ZERO;
          const outputTokenMapping: { [key: string]: StandardTokenMock | WETH9 } = {
            CollateralToken: collateralToken,
            ETH: setV2Setup.weth,
            ERC20: setV2Setup.usdc,
          };
          outputToken = outputTokenMapping[tokenName];
          subjectOutputToken = tokenName == "ETH" ? ethAddress : outputToken.address;

          subjectCollateralForDebtSwapData = {
            path: [collateralToken.address, setV2Setup.usdc.address],
            fees: [3000],
            pool: ADDRESS_ZERO,
            exchange,
          };
          subjectOutputTokenSwapData = {
            path: [collateralToken.address, outputToken.address],
            fees: [3000],
            pool: ADDRESS_ZERO,
            exchange,
          };

          const debtForCollateralSwapData = {
            path: [setV2Setup.usdc.address, collateralToken.address],
            fees: [3000],
            pool: ADDRESS_ZERO,
            exchange,
          };

          // Can be empty since we are paying with collateral token and don't need to do this swap
          const inputTokenSwapData = {
            path: [],
            fees: [],
            pool: ADDRESS_ZERO,
            exchange,
          };

          await collateralToken.approve(exchangeIssuance.address, collateralAmount);
          await exchangeIssuance.approveSetToken(setToken.address);
          await exchangeIssuance.issueExactSetFromERC20(
            subjectSetToken,
            subjectSetAmount,
            collateralToken.address,
            collateralAmount,
            debtForCollateralSwapData,
            inputTokenSwapData,
          );
          await setToken.approve(exchangeIssuance.address, subjectSetAmount);
        });
        it("should succeed", async () => {
          await subject();
        });
        it("should reduce set balance by the expected amount", async () => {
          const balanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const balanceAfter = await setToken.balanceOf(owner.address);
          expect(balanceBefore.sub(balanceAfter)).to.equal(subjectSetAmount);
        });
        it("should return at least the expected amount of the output token", async () => {
          const balanceBefore =
            tokenName == "ETH"
              ? await owner.wallet.getBalance()
              : await outputToken.balanceOf(owner.address);
          const tx = await subject();
          const transactionFee = await getTxFee(tx);
          const balanceAfter =
            tokenName == "ETH"
              ? await owner.wallet.getBalance()
              : await outputToken.balanceOf(owner.address);
          amountReturned = balanceAfter.sub(balanceBefore);
          if (tokenName == "ETH") amountReturned = amountReturned.add(transactionFee);
          expect(amountReturned.gt(subjectMinAmountOutput)).to.equal(true);
        });
        it("should emit ExchangeRedeem event", async () => {
          await expect(subject())
            .to.emit(exchangeIssuance, "ExchangeRedeem")
            .withArgs(
              owner.address,
              subjectSetToken,
              subjectOutputToken,
              subjectSetAmount,
              amountReturned,
            );
        });
        context("when minAmountOutputToken is too high", async () => {
          beforeEach(() => {
            subjectMinAmountOutput = collateralAmount;
          });
          it("should revert", async () => {
            const revertReason =
              tokenName == "ERC20"
                ? "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
                : "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT";
            await expect(subject()).to.be.revertedWith(revertReason);
          });
        });
      });
      describe(`#issueExactSetFrom${tokenName == "CollateralToken" ? "ERC20" : tokenName} ${
        tokenName == "CollateralToken" ? "paying with CollateralToken" : ""
      }`, async () => {
        let subjectSetToken: Address;
        let subjectSetAmount: BigNumber;
        let subjectMaxAmountInput: BigNumber;
        let exchange: Exchange;
        let subjectInputToken: Address;
        let subjectDebtForCollateralSwapData: SwapData;
        let subjectInputTokenSwapData: SwapData;
        let inputToken: StandardTokenMock | WETH9;
        let collateralAmount: BigNumber;
        let inputAmountSpent: BigNumber;
        async function subject() {
          if (tokenName === "CollateralToken") {
            return await exchangeIssuance.issueExactSetFromERC20(
              subjectSetToken,
              subjectSetAmount,
              collateralToken.address,
              subjectMaxAmountInput,
              subjectDebtForCollateralSwapData,
              subjectInputTokenSwapData,
            );
          } else if (tokenName === "ERC20") {
            return await exchangeIssuance.issueExactSetFromERC20(
              subjectSetToken,
              subjectSetAmount,
              subjectInputToken,
              subjectMaxAmountInput,
              subjectDebtForCollateralSwapData,
              subjectInputTokenSwapData,
            );
          } else {
            return await exchangeIssuance.issueExactSetFromETH(
              subjectSetToken,
              subjectSetAmount,
              subjectDebtForCollateralSwapData,
              subjectInputTokenSwapData,
              { value: subjectMaxAmountInput },
            );
          }
        }
        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectSetAmount = ether(1);
          exchange = Exchange.Quickswap;
          ({ collateralAmount } = await exchangeIssuance.getLeveragedTokenData(
            subjectSetToken,
            subjectSetAmount,
            true,
          ));
          subjectMaxAmountInput = tokenName == "ERC20" ? UnitsUtils.usdc(12000) : collateralAmount;
          const inputTokenMapping: { [key: string]: StandardTokenMock | WETH9 } = {
            CollateralToken: collateralToken,
            ETH: setV2Setup.weth,
            ERC20: setV2Setup.usdc,
          };
          inputToken = inputTokenMapping[tokenName];
          subjectInputToken = tokenName == "ETH" ? ethAddress : inputToken.address;

          subjectDebtForCollateralSwapData = {
            path: [setV2Setup.usdc.address, collateralToken.address],
            fees: [3000],
            pool: ADDRESS_ZERO,
            exchange,
          };

          subjectInputTokenSwapData = {
            path: [inputToken.address, collateralToken.address],
            fees: [3000],
            pool: ADDRESS_ZERO,
            exchange,
          };

          await inputToken.approve(exchangeIssuance.address, subjectMaxAmountInput);
          await exchangeIssuance.approveSetToken(setToken.address);
        });
        it("should succeed", async () => {
          await subject();
        });
        it("should return the requested amount of set", async () => {
          const balanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const balanceAfter = await setToken.balanceOf(owner.address);
          expect(balanceAfter.sub(balanceBefore)).to.equal(subjectSetAmount);
        });
        it("should cost less than the max amount", async () => {
          const balanceBefore =
            tokenName == "ETH"
              ? await owner.wallet.getBalance()
              : await inputToken.balanceOf(owner.address);
          const tx = await subject();
          const transactionFee = await getTxFee(tx);
          const balanceAfter =
            tokenName == "ETH"
              ? await owner.wallet.getBalance()
              : await inputToken.balanceOf(owner.address);
          inputAmountSpent = balanceBefore.sub(balanceAfter);
          if (tokenName == "ETH") inputAmountSpent = inputAmountSpent.sub(transactionFee);
          expect(inputAmountSpent.gt(0)).to.equal(true);
          expect(inputAmountSpent.lt(subjectMaxAmountInput)).to.equal(true);
        });
        it("should emit ExchangeIssuance event", async () => {
          await expect(subject())
            .to.emit(exchangeIssuance, "ExchangeIssue")
            .withArgs(
              owner.address,
              subjectSetToken,
              subjectInputToken,
              inputAmountSpent,
              subjectSetAmount,
            );
        });
        context("when subjectMaxInput is too low", async () => {
          beforeEach(() => {
            subjectMaxAmountInput = ZERO;
          });
          it("should revert", async () => {
            const revertReason =
              tokenName == "ERC20"
                ? "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT'"
                : "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT";
            await expect(subject()).to.be.revertedWith(revertReason);
          });
        });
        context("when exchange without any liquidity is specified", async () => {
          beforeEach(async () => {
            subjectDebtForCollateralSwapData.exchange = Exchange.Sushiswap;
          });
          it("should revert", async () => {
            // TODO: Check why this is failing without any reason. Would have expected something more descriptive coming from the router
            await expect(subject()).to.be.revertedWith("revert");
          });
        });
        context("when exchange with too little liquidity is specified", async () => {
          beforeEach(async () => {
            // Set up sushiswap with INsufficient liquidity
            await setV2Setup.usdc
              .connect(owner.wallet)
              .approve(sushiswapRouter.address, MAX_INT_256);
            await sushiswapRouter
              .connect(owner.wallet)
              .addLiquidityETH(
                setV2Setup.usdc.address,
                UnitsUtils.usdc(10),
                MAX_UINT_256,
                MAX_UINT_256,
                owner.address,
                (await getLastBlockTimestamp()).add(1),
                { value: ether(0.001), gasLimit: 9000000 },
              );

            subjectDebtForCollateralSwapData.exchange = Exchange.Sushiswap;
          });
          it("should revert", async () => {
            const revertReasonMapping: Record<string, string> = {
              ERC20: "UniswapV2Router: EXCESSIVE_INPUT_AMOUNT",
              ETH: "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT",
              CollateralToken: "SafeERC20: low-level call failed",
            };
            await expect(subject()).to.be.revertedWith(revertReasonMapping[tokenName]);
          });
        });
      });

      describe("#getIssueExactSet", async () => {
        let subjectSetToken: SetToken;
        let subjectAmount: BigNumber;
        let subjectInputToken: StandardTokenMock | WETH9;
        let subjectDebtForCollateralSwapData: SwapData;
        let subjectInputTokenSwapData: SwapData;

        async function subject(): Promise<BigNumber> {
          return await exchangeIssuance.callStatic.getIssueExactSet(
            subjectSetToken.address,
            subjectAmount,
            subjectDebtForCollateralSwapData,
            subjectInputTokenSwapData
          );
        }

        async function performIssuance(): Promise<ContractTransaction> {
          return await exchangeIssuance.issueExactSetFromERC20(
            subjectSetToken.address,
            subjectAmount,
            subjectInputToken.address,
            await subjectInputToken.balanceOf(owner.address),
            subjectDebtForCollateralSwapData,
            subjectInputTokenSwapData
          );
        }

        context(`when input token is ${tokenName === "CollateralToken" ? "the collateral" : "an ERC20"}`, async () => {
          beforeEach(async () => {
            subjectSetToken = setToken;
            subjectAmount = ether(0.1);
            subjectInputToken = tokenName === "CollateralToken" ? setV2Setup.weth : setV2Setup.usdc;

            subjectDebtForCollateralSwapData = {
              exchange: Exchange.Quickswap,
              pool: ADDRESS_ZERO,
              path: [setV2Setup.usdc.address, wethAddress],
              fees: [],
            };

            subjectInputTokenSwapData = {
              exchange: Exchange.Quickswap,
              pool: ADDRESS_ZERO,
              path: [subjectInputToken.address, wethAddress],
              fees: [],
            };

            await setV2Setup.usdc.approve(exchangeIssuance.address, MAX_UINT_256);
            await setV2Setup.weth.approve(exchangeIssuance.address, MAX_UINT_256);
            await exchangeIssuance.approveSetToken(subjectSetToken.address);
          });

          it("should return correct issuance cost", async () => {
            const amountIn = await subject();

            const initAmount = await subjectInputToken.balanceOf(owner.address);
            await performIssuance();
            const finalAmount = await subjectInputToken.balanceOf(owner.address);

            const expectedAmountIn = initAmount.sub(finalAmount);

            expect(amountIn).to.gt(preciseMul(expectedAmountIn, ether(0.99)));
            expect(amountIn).to.lt(preciseMul(expectedAmountIn, ether(1.01)));
          });

          context("when using Uniswap V3 as the exchange", async () => {
            beforeEach(() => {
              subjectDebtForCollateralSwapData = {
                exchange: Exchange.UniV3,
                pool: ADDRESS_ZERO,
                path: [setV2Setup.usdc.address, wethAddress],
                fees: [3000],
              };

              subjectInputTokenSwapData = {
                exchange: Exchange.UniV3,
                pool: ADDRESS_ZERO,
                path: [subjectInputToken.address, wethAddress],
                fees: [3000],
              };
            });

            it("should return the correct issuance cost", async () => {
              const amountIn = await subject();

              const initAmount = await subjectInputToken.balanceOf(owner.address);
              await performIssuance();
              const finalAmount = await subjectInputToken.balanceOf(owner.address);

              const expectedAmountIn = initAmount.sub(finalAmount);

              expect(amountIn).to.gt(preciseMul(expectedAmountIn, ether(0.99)));
              expect(amountIn).to.lt(preciseMul(expectedAmountIn, ether(1.01)));
            });
          });
        });
      });

      describe("#getRedeemExactSet", async () => {
        let subjectSetToken: SetToken;
        let subjectAmount: BigNumber;
        let subjectOutputToken: StandardTokenMock | WETH9;
        let subjectCollateralForDebtSwapData: SwapData;
        let subjectOutputTokenSwapData: SwapData;

        async function subject(): Promise<BigNumber> {
          return await exchangeIssuance.callStatic.getRedeemExactSet(
            subjectSetToken.address,
            subjectAmount,
            subjectCollateralForDebtSwapData,
            subjectOutputTokenSwapData
          );
        }

        async function performRedemption(): Promise<ContractTransaction> {
          return await exchangeIssuance.redeemExactSetForERC20(
            subjectSetToken.address,
            subjectAmount,
            subjectOutputToken.address,
            ZERO,
            subjectCollateralForDebtSwapData,
            subjectOutputTokenSwapData
          );
        }

        context(`when output token is ${tokenName === "CollateralToken" ? "the collateral" : "an ERC20"}`, async () => {
          beforeEach(async () => {
            subjectSetToken = setToken;
            subjectAmount = ether(0.1);
            subjectOutputToken = tokenName === "CollateralToken" ? setV2Setup.weth : setV2Setup.usdc;

            subjectCollateralForDebtSwapData = {
              exchange: Exchange.Quickswap,
              pool: ADDRESS_ZERO,
              path: [wethAddress, setV2Setup.usdc.address],
              fees: [],
            };

            subjectOutputTokenSwapData = {
              exchange: Exchange.Quickswap,
              pool: ADDRESS_ZERO,
              path: [wethAddress, subjectOutputToken.address],
              fees: [],
            };

            await subjectSetToken.approve(exchangeIssuance.address, MAX_UINT_256);
            await exchangeIssuance.approveSetToken(subjectSetToken.address);
          });

          it("should return correct redemption proceeds", async () => {
            const amountOut = await subject();

            const initAmount = await subjectOutputToken.balanceOf(owner.address);
            await performRedemption();
            const finalAmount = await subjectOutputToken.balanceOf(owner.address);

            const expectedAmountOut = finalAmount.sub(initAmount);

            expect(amountOut).to.gt(preciseMul(expectedAmountOut, ether(0.99)));
            expect(amountOut).to.lt(preciseMul(expectedAmountOut, ether(1.01)));
          });

          context("when using Uniswap V3 as the exchange", async () => {
            beforeEach(() => {
              subjectCollateralForDebtSwapData = {
                exchange: Exchange.UniV3,
                pool: ADDRESS_ZERO,
                path: [wethAddress, setV2Setup.usdc.address],
                fees: [3000],
              };

              subjectOutputTokenSwapData = {
                exchange: Exchange.UniV3,
                pool: ADDRESS_ZERO,
                path: [wethAddress, subjectOutputToken.address],
                fees: [3000],
              };
            });

            it("should return the correct issuance cost", async () => {
              const amountOut = await subject();

              const initAmount = await subjectOutputToken.balanceOf(owner.address);
              await performRedemption();
              const finalAmount = await subjectOutputToken.balanceOf(owner.address);

              const expectedAmountOut = finalAmount.sub(initAmount);

              expect(amountOut).to.gt(preciseMul(expectedAmountOut, ether(0.99)));
              expect(amountOut).to.lt(preciseMul(expectedAmountOut, ether(1.01)));
            });
          });
        });
      });

      describe("#executeOperation", async () => {
        context("When caller is not the lending pool", () => {
          let subjectAssets: Address[];
          let subjectAmounts: BigNumber[];
          let subjectPremiums: BigNumber[];
          let subjectInitiator: Address;
          let subjectParams: Bytes;
          beforeEach(async () => {
            subjectAssets = [ADDRESS_ZERO];
            subjectAmounts = [ZERO];
            subjectPremiums = [ZERO];
            subjectInitiator = ADDRESS_ZERO;
            subjectParams = EMPTY_BYTES;
          });
          async function subject() {
            await exchangeIssuance.executeOperation(
              subjectAssets,
              subjectAmounts,
              subjectPremiums,
              subjectInitiator,
              subjectParams,
            );
          }
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("ExchangeIssuance: LENDING POOL ONLY");
          });
        });
        context("When flashloan initiator is not the Exchange Issuance contract", () => {
          let subjectReceiver: Address;
          let subjectAssets: Address[];
          let subjectAmounts: BigNumber[];
          let subjectModes: BigNumber[];
          let subjectOnBehalfOf: Address;
          let subjectParams: Bytes;
          let subjectReferalCode: BigNumber;
          beforeEach(async () => {
            subjectReceiver = exchangeIssuance.address;
            subjectAssets = [wethAddress];
            subjectAmounts = [utils.parseEther("1")];
            subjectModes = [ZERO];
            subjectOnBehalfOf = exchangeIssuance.address;
            subjectParams = EMPTY_BYTES;
            subjectReferalCode = ZERO;
          });
          async function subject() {
            await aaveSetup.lendingPool.flashLoan(
              subjectReceiver,
              subjectAssets,
              subjectAmounts,
              subjectModes,
              subjectOnBehalfOf,
              subjectParams,
              subjectReferalCode,
            );
          }
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "ExchangeIssuance: INVALID FLASHLOAN INITIATOR",
            );
          });
        });
      });
    });
  });
});
