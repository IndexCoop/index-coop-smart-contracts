import "module-alias/register";

import {
  Address,
  Account,
  AaveContractSettings,
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
} from "@utils/contracts/index";
import { UniswapV2Factory, UniswapV2Router02 } from "@utils/contracts/uniswap";
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
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { AaveV2Fixture, SetFixture, UniswapFixture } from "@utils/fixtures";
import { BigNumber, utils } from "ethers";

const expect = getWaffleExpect();

describe("ExchangeIssuanceLeveraged", async () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let aaveSetup: AaveV2Fixture;

  let exchangeIssuance: ExchangeIssuanceLeveraged;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let aWeth: AaveV2AToken;
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
  let uniswapFactory: UniswapV2Factory;
  let uniswapRouter: UniswapV2Router02;
  let sushiswapFactory: UniswapV2Factory;
  let sushiswapRouter: UniswapV2Router02;
  let controllerAddress: Address;
  let debtIssuanceModuleAddress: Address;
  let addressProviderAddress: Address;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let setTokenInitialBalance: BigNumber;

  cacheBeforeEach(async () => {
    [owner, methodologist] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();
    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setV2Setup.weth.address, setV2Setup.dai.address);

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

    aWeth = aaveSetup.wethReserveTokens.aToken;

    const oneRay = BigNumber.from(10).pow(27); // 1e27
    await aaveSetup.setMarketBorrowRate(setV2Setup.usdc.address, oneRay.mul(39).div(1000));
    await aaveSetup.setAssetPriceInOracle(setV2Setup.usdc.address, ether(0.001));

    // Mint aTokens
    await setV2Setup.weth.approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool.deposit(setV2Setup.weth.address, ether(1000), owner.address, 0);
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

    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    // Set integrations for CompoundLeverageModule
    await setV2Setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "UniswapTradeAdapter",
      uniswapSetup.uniswapTradeAdapter.address,
    );
    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    setTokenInitialBalance = ether(1);
    console.log("Issuing set");
    await aWeth.approve(debtIssuanceModule.address, MAX_UINT_256);
    await debtIssuanceModule.issue(setToken.address, setTokenInitialBalance, owner.address);
    // Engage aave fli
    console.log("Engage aave leverage extension");
    await setV2Setup.weth.transfer(tradeAdapterMock.address, setTokenInitialBalance.mul(10));
    await leverageStrategyExtension.engage(exchangeName);
    // await increaseTimeAsync(BigNumber.from(100000));
    // console.log("iterate rebalance");
    // await leverageStrategyExtension.iterateRebalance(exchangeName);

    console.log("Setting up addresses");
    uniswapFactory = uniswapSetup.factory;
    uniswapRouter = uniswapSetup.router;
    sushiswapFactory = sushiswapSetup.factory;
    sushiswapRouter = sushiswapSetup.router;
    controllerAddress = setV2Setup.controller.address;
    debtIssuanceModuleAddress = debtIssuanceModule.address;
    addressProviderAddress = aaveSetup.lendingPoolAddressesProvider.address;
    console.log("Addresses setup");

    // ETH-USDC pools
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapRouter.address, MAX_INT_256);
    await uniswapRouter
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
  });

  const initializeRootScopeContracts = async () => {
    setToken = await setV2Setup.createSetToken(
      [aWeth.address],
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
      [setV2Setup.weth.address],
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
      targetCollateralAToken: aWeth.address,
      targetBorrowDebtToken: usdcVariableDebtToken.address,
      collateralAsset: setV2Setup.weth.address,
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
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        addressProviderAddress,
      );
      console.log("Called setup");
      return result;
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceLeveraged = await subject();

      const expectedWethAddress = await exchangeIssuanceContract.WETH();
      expect(expectedWethAddress).to.eq(wethAddress);

      const expectedUniRouterAddress = await exchangeIssuanceContract.uniRouter();
      expect(expectedUniRouterAddress).to.eq(uniswapRouter.address);

      const expectedUniFactoryAddress = await exchangeIssuanceContract.uniFactory();
      expect(expectedUniFactoryAddress).to.eq(uniswapFactory.address);

      const expectedSushiRouterAddress = await exchangeIssuanceContract.sushiRouter();
      expect(expectedSushiRouterAddress).to.eq(sushiswapRouter.address);

      const expectedSushiFactoryAddress = await exchangeIssuanceContract.sushiFactory();
      expect(expectedSushiFactoryAddress).to.eq(sushiswapFactory.address);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(controllerAddress);

      const expectedDebtIssuanceModuleAddress = await exchangeIssuanceContract.debtIssuanceModule();
      expect(expectedDebtIssuanceModuleAddress).to.eq(debtIssuanceModuleAddress);
    });

    it("approves WETH to the uniswap and sushiswap router", async () => {
      const exchangeIssuance: ExchangeIssuanceLeveraged = await subject();

      // validate the allowance of WETH between uniswap, sushiswap, and the deployed exchange issuance contract
      const uniswapWethAllowance = await setV2Setup.weth.allowance(
        exchangeIssuance.address,
        uniswapRouter.address,
      );
      expect(uniswapWethAllowance).to.eq(MAX_UINT_256);

      const sushiswapWethAllownace = await setV2Setup.weth.allowance(
        exchangeIssuance.address,
        sushiswapRouter.address,
      );
      expect(sushiswapWethAllownace).to.eq(MAX_UINT_256);
    });
  });

  describe("When exchangeIssuacne is deployed", () => {
    beforeEach(async () => {
      exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
        wethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        addressProviderAddress,
      );
    });

    describe("#getLeveragedTokenData", async () => {
      let subjectSetToken: Address;
      let subjectSetAmount: BigNumber;
      async function subject() {
        return await exchangeIssuance.getLeveragedTokenData(subjectSetToken, subjectSetAmount);
      }
      context("when passed the FLI token", async () => {
        before(() => {
          subjectSetToken = setToken.address;
          subjectSetAmount = ether(1);
        });
        it("should return correct data", async () => {
          const rawData = await setV2Setup.debtIssuanceModule.getRequiredComponentIssuanceUnits(
            subjectSetToken,
            subjectSetAmount,
          );
          console.log("rawData", rawData);
          const { longToken, shortToken, longAmount, shortAmount } = await subject();
          expect(longToken).to.eq(strategy.targetCollateralAToken);
          expect(shortToken).to.eq(strategy.borrowAsset);
          console.log("Long Amount", longAmount.toString());
          console.log("Short Amount", shortAmount.toString());
          expect(longAmount).to.be.gt(ZERO);
          expect(shortAmount).to.be.gt(ZERO);
        });
      });
    });

    describe("#issueExactSetForLongToken", async () => {
      let subjectSetToken: Address;
      let subjectSetAmount: BigNumber;
      let subjectMaxAmountInput: BigNumber;
      let longAmount: BigNumber;
      async function subject() {
        return await exchangeIssuance.issueExactSetForLongToken(
          subjectSetToken,
          subjectSetAmount,
          subjectMaxAmountInput,
        );
      }
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectSetAmount = ether(1);
        ({ longAmount } = await exchangeIssuance.getLeveragedTokenData(
          subjectSetToken,
          subjectSetAmount,
        ));
        subjectMaxAmountInput = longAmount;
        await setV2Setup.weth.approve(exchangeIssuance.address, longAmount);
        await exchangeIssuance.approveSetToken(setToken.address);
      });
      it("should succeed", async () => {
        await subject();
      });
      it("should cost less than the total long position", async () => {
        const balanceBefore = await setV2Setup.weth.balanceOf(owner.address);
        await subject();
        const balanceAfter = await setV2Setup.weth.balanceOf(owner.address);
        const diff = balanceBefore.sub(balanceAfter);
        console.log("Diff and longAmount", utils.formatEther(diff), utils.formatEther(longAmount));
        expect(diff.gt(0)).to.equal(true);
        expect(diff.lt(longAmount)).to.equal(true);
      });
      context("when subjectMaxInput is too low", async () => {
        beforeEach(() => {
          subjectMaxAmountInput = ZERO;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "revert ExchangeIssuance: INSUFFICIENT INPUT AMOUNT",
          );
        });
      });
    });
    describe("#issueExactSetForEth", async () => {
      let subjectSetToken: Address;
      let subjectSetAmount: BigNumber;
      let subjectMaxAmountInput: BigNumber;
      let longAmount: BigNumber;
      async function subject() {
        return await exchangeIssuance.issueExactSetForEth(
          subjectSetToken,
          subjectSetAmount,
          subjectMaxAmountInput,
        );
      }
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectSetAmount = ether(1);
        ({ longAmount } = await exchangeIssuance.getLeveragedTokenData(
          subjectSetToken,
          subjectSetAmount,
        ));
        subjectMaxAmountInput = longAmount;
        await setV2Setup.weth.approve(exchangeIssuance.address, longAmount);
        await exchangeIssuance.approveSetToken(setToken.address);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "revert Not Implemented",
        );
      });
    });
  });
});
