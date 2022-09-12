import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO, ZERO_BYTES } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getUniswapFixture,
  getUniswapV3Fixture,
  getCompoundFixture,
} from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils, usdc } from "@utils/common/unitsUtils";
import { SetFixture, UniswapFixture, UniswapV3Fixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { StandardTokenMock, WETH9 } from "@utils/contracts/index";
import { getTxFee } from "@utils/test";
import { ethers } from "hardhat";
import { FlashMintWrapped } from "@typechain/FlashMintWrapped";
import { CERc20 } from "@typechain/CERc20";
import { IERC20 } from "@typechain/IERC20";
import { IERC20__factory } from "@typechain/factories/IERC20__factory";
import { expectThrowsAsync, getLastBlockTimestamp } from "@utils/test/testingUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

const expect = getWaffleExpect();

//#region types, consts
const compoundWrapAdapterIntegrationName: string = "CompoundWrapV2Adapter";

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

type ComponentSwapData = {
  // unwrapped token version, e.g. DAI
  underlyingERC20: Address;

  // // swap data for DEX operation: fees, path, etc. see DEXAdapter.SwapData
  dexData: SwapData;

  // ONLY relevant for issue, not used for redeem:
  // amount that has to be bought of the unwrapped token version (to cover required wrapped component amounts for issuance)
  // this amount has to be computed beforehand through the exchange rate of wrapped Component <> unwrappedComponent
  // i.e. getRequiredComponentIssuanceUnits() on the IssuanceModule and then convert units through exchange rate to unwrapped component units
  // e.g. 300 cDAI needed for issuance of 1 Set token. exchange rate 1cDAI = 0.05 DAI. -> buyUnderlyingAmount = 0.05 DAI * 300 = 15 DAI
  buyUnderlyingAmount: BigNumber;
};

type ComponentWrapData = {
  fromToken: Address; // wrap / unwrap from
  toToken: Address; // wrap / unwrap to
  // amount to wrap / unwrap.
  // for wrapping, this would be ComponentSwapData.buyUnderlyingAmount
  // for unwrapping, it's IssuanceModule.getRequiredComponentRdemptionUnits()
  amount: BigNumber;
  integrationName: string; // wrap adapter integration name as listed in the IntegrationRegistry for the wrapModule
  wrapData: string; // optional wrapData passed to the wrapAdapter
};

type ComponentInvokeWrapData = {
  callTarget: Address;
  value: BigNumber;
  callData: string;
};

//#endregion

//#region testHelper
class TestHelper {
  readonly setTokenInitialBalance: BigNumber = ether(1);
  readonly ethAddress: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

  owner: Account;
  methodologist: Account;

  setV2Setup: SetFixture;
  deployer: DeployHelper;
  setToken: SetToken;

  controllerAddress: Address;

  sushiswap: UniswapFixture;
  uniswapV3: UniswapV3Fixture;

  cDAI: CERc20;
  cUSDC: CERc20;
  cUSDT: CERc20;

  get issuanceModule() {
    return this.setV2Setup.debtIssuanceModule;
  }

  ownerBalanceOf(token: StandardTokenMock | IERC20 | CERc20 | WETH9 | "ETH") {
    return token === "ETH" ? this.owner.wallet.getBalance() : token.balanceOf(this.owner.address);
  }

  async init() {
    [this.owner, this.methodologist] = await getAccounts();
    this.deployer = new DeployHelper(this.owner.wallet);
  }

  async defaultSetV2Setup() {
    this.setV2Setup = getSetFixture(this.owner.address);
    await this.setV2Setup.initialize();

    this.controllerAddress = this.setV2Setup.controller.address;

    // deploy CompoundWrapV2Adapter
    const compoundWrapAdapter = await this.deployer.setV2.deployCompoundWrapV2Adapter();
    await this.setV2Setup.integrationRegistry.addIntegration(
      this.setV2Setup.wrapModule.address,
      compoundWrapAdapterIntegrationName,
      compoundWrapAdapter.address,
    );
  }

  async compoundSetup() {
    const compoundSetup = getCompoundFixture(this.owner.address);
    await compoundSetup.initialize();

    // Mint cTokens
    this.cUSDC = await compoundSetup.createAndEnableCToken(
      this.setV2Setup.usdc.address,
      100000000000000,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound USDC",
      "cUSDC",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000), // IMPORTANT: Compound oracles account for decimals scaled by 10e18. For USDC, this is $1 * 10^18 * 10^18 / 10^6 = 10^30
    );

    this.cDAI = await compoundSetup.createAndEnableCToken(
      this.setV2Setup.dai.address,
      100000000000000,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound DAI",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000),
    );

    this.cUSDT = await compoundSetup.createAndEnableCToken(
      this.setV2Setup.usdt.address,
      100000000000000,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound USDT",
      "cUSDT",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000),
    );
    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([
      this.cDAI.address,
      this.cUSDC.address,
      this.cUSDT.address,
    ]);

    await this.setV2Setup.dai.approve(this.cDAI.address, MAX_UINT_256);
    await this.setV2Setup.usdc.approve(this.cUSDC.address, MAX_UINT_256);
    await this.setV2Setup.usdt.approve(this.cUSDT.address, MAX_UINT_256);

    await this.cDAI.mint(ether(1000));
    await this.cUSDC.mint(ether(1000));
    await this.cUSDT.mint(ether(1000));
  }

  async createSetToken() {
    this.setToken = await this.setV2Setup.createSetToken(
      [this.cDAI.address, this.cUSDC.address, this.cUSDT.address],
      [BigNumber.from(200_000_000), BigNumber.from(300_000_000), BigNumber.from(100_000_000)],
      [
        this.issuanceModule.address,
        this.setV2Setup.streamingFeeModule.address,
        this.setV2Setup.wrapModule.address,
      ],
    );
  }

  async issueInitialSetTokens() {
    await this.cDAI.connect(this.owner.wallet).approve(this.issuanceModule.address, MAX_UINT_256);
    await this.cUSDC.connect(this.owner.wallet).approve(this.issuanceModule.address, MAX_UINT_256);
    await this.cUSDT.connect(this.owner.wallet).approve(this.issuanceModule.address, MAX_UINT_256);

    await this.issuanceModule.issue(
      this.setToken.address,
      this.setTokenInitialBalance,
      this.owner.address,
    );
  }

  async deployManager() {
    const baseManagerV2 = await this.deployer.manager.deployBaseManagerV2(
      this.setToken.address,
      this.owner.address,
      this.methodologist.address,
    );
    await baseManagerV2.connect(this.methodologist.wallet).authorizeInitialization();
    // Transfer ownership to manager
    if ((await this.setToken.manager()) == this.owner.address) {
      await this.setToken.connect(this.owner.wallet).setManager(baseManagerV2.address);
    }
  }

  async initializeContracts() {
    // Initialize modules
    await this.issuanceModule.initialize(
      this.setToken.address,
      ether(1),
      ZERO,
      ZERO,
      this.owner.address,
      ADDRESS_ZERO,
    );

    const streamingFeeSettings = {
      feeRecipient: this.owner.address,
      maxStreamingFeePercentage: ether(0.1),
      streamingFeePercentage: ether(0.02),
      lastStreamingFeeTimestamp: ZERO,
    };
    await this.setV2Setup.streamingFeeModule.initialize(
      this.setToken.address,
      streamingFeeSettings,
    );

    await this.setV2Setup.wrapModule.initialize(this.setToken.address);
  }

  async setupDexes() {
    this.sushiswap = getUniswapFixture(this.owner.address);
    await this.sushiswap.initialize(
      this.owner,
      this.setV2Setup.weth.address,
      this.setV2Setup.wbtc.address,
      this.setV2Setup.dai.address,
    );

    this.uniswapV3 = getUniswapV3Fixture(this.owner.address);
    await this.uniswapV3.initialize(
      this.owner,
      this.setV2Setup.weth,
      3000,
      this.setV2Setup.wbtc,
      40000,
      this.setV2Setup.dai,
    );
  }

  async seedDexLiquidity() {
    // uniV3: WETH <-> USDC, WETH <-> USDT and WETH <-> DAI
    await this.setV2Setup.weth.approve(this.uniswapV3.nftPositionManager.address, MAX_UINT_256);
    await this.setV2Setup.dai.approve(this.uniswapV3.nftPositionManager.address, MAX_UINT_256);
    await this.setV2Setup.usdc.approve(this.uniswapV3.nftPositionManager.address, MAX_UINT_256);
    await this.setV2Setup.usdt.approve(this.uniswapV3.nftPositionManager.address, MAX_UINT_256);

    // usdc
    await this.uniswapV3.createNewPair(this.setV2Setup.weth, this.setV2Setup.usdc, 3000, 3000);
    await this.uniswapV3.addLiquidityWide(
      this.setV2Setup.weth,
      this.setV2Setup.usdc,
      3000,
      ether(10000),
      usdc(300_000_000),
      this.owner.address,
    );

    // usdt
    await this.uniswapV3.createNewPair(this.setV2Setup.weth, this.setV2Setup.usdt, 3000, 3000);
    await this.uniswapV3.addLiquidityWide(
      this.setV2Setup.weth,
      this.setV2Setup.usdt,
      3000,
      ether(10000),
      usdc(300_000_000),
      this.owner.address,
    );

    // dai
    await this.uniswapV3.createNewPair(this.setV2Setup.weth, this.setV2Setup.dai, 3000, 3000);
    await this.uniswapV3.addLiquidityWide(
      this.setV2Setup.weth,
      this.setV2Setup.dai,
      3000,
      ether(10000),
      ether(300000),
      this.owner.address,
    );
  }

  async deployFlashMintWrappedExtension(): Promise<FlashMintWrapped> {
    return await this.deployer.extensions.deployFlashMintWrappedExtension(
      this.setV2Setup.weth.address,
      ADDRESS_ZERO, // quickswap router
      this.sushiswap.router.address,
      this.uniswapV3.swapRouter.address,
      this.uniswapV3.quoter.address,
      ADDRESS_ZERO, // curveCalculatorAddress
      ADDRESS_ZERO, // curveAddressProviderAddress
      this.controllerAddress,
      this.issuanceModule.address,
    );
  }

  async getRequiredIssuanceInputAmount(
    setToken: Address,
    inputToken: Address,
    issueSetAmount: BigNumber,
    componentSwapData: ComponentSwapData[],
    flashMintContract: FlashMintWrapped,
    tolerancePercentage: number = 1, // 1% tolerance
  ) {
    const estimatedInputAmount: BigNumber = await flashMintContract.callStatic.getIssueExactSet(
      setToken,
      inputToken,
      issueSetAmount,
      componentSwapData,
    );

    // add some slight tolerance to the inputAmount to cover minor pricing changes or slippage until
    // tx is actually executed
    return estimatedInputAmount
      .mul(BigNumber.from(100 + tolerancePercentage))
      .div(BigNumber.from(100));
  }

  async getIssuanceComponentSwapData(
    inputToken: Address,
    issueSetAmount: BigNumber,
    setToken = this.setToken.address,
  ) {
    // get required issuance components
    const [
      issuanceComponents, // cDAI, cUSDC and cUSDT, in that order
      issuanceUnits,
    ] = await this.issuanceModule.getRequiredComponentIssuanceUnits(setToken, issueSetAmount);

    if (
      JSON.stringify([this.cDAI.address, this.cUSDC.address, this.cUSDT.address]) !==
      JSON.stringify(issuanceComponents)
    ) {
      throw new Error("issuance components test case not implemented");
    }

    // get exchange rates for each of the cTokens
    // RETURN: The current exchange rate as an unsigned integer, scaled by 1 * 10^(18 - 8 + Underlying Token Decimals).
    // => 1e18
    const exchangeRateDAI = await this.cDAI.callStatic.exchangeRateCurrent();
    const exchangeRateUSDC = await this.cUSDC.callStatic.exchangeRateCurrent();
    const exchangeRateUSDT = await this.cUSDT.callStatic.exchangeRateCurrent();

    // required cTokens each = 100.000
    // precision good enough for test case, should be done exact in JS library
    const requiredDAI = issuanceUnits[0].mul(exchangeRateDAI.div(1e6)).div(1e12);
    const requiredUSDC = issuanceUnits[1].mul(exchangeRateUSDC.div(1e6)).div(1e12);
    const requiredUSDT = issuanceUnits[2].mul(exchangeRateUSDT.div(1e6)).div(1e12);

    const componentSwapData: ComponentSwapData[] = [
      {
        underlyingERC20: this.setV2Setup.dai.address,
        buyUnderlyingAmount: requiredDAI,
        dexData: {
          exchange: Exchange.UniV3,
          path:
            inputToken === this.setV2Setup.weth.address
              ? [inputToken, this.setV2Setup.dai.address]
              : [inputToken, this.setV2Setup.weth.address, this.setV2Setup.dai.address],
          fees: inputToken === this.setV2Setup.weth.address ? [3000] : [3000, 3000],
          pool: ADDRESS_ZERO,
        },
      },
      {
        underlyingERC20: this.setV2Setup.usdc.address,
        buyUnderlyingAmount: requiredUSDC,
        dexData: {
          exchange: Exchange.UniV3,
          path:
            inputToken === this.setV2Setup.weth.address
              ? [inputToken, this.setV2Setup.usdc.address]
              : [inputToken, this.setV2Setup.weth.address, this.setV2Setup.usdc.address],
          fees: inputToken === this.setV2Setup.weth.address ? [3000] : [3000, 3000],
          pool: ADDRESS_ZERO,
        },
      },
      {
        underlyingERC20: this.setV2Setup.usdt.address,
        buyUnderlyingAmount: requiredUSDT,
        dexData: {
          exchange: Exchange.UniV3,
          path:
            inputToken === this.setV2Setup.weth.address
              ? [inputToken, this.setV2Setup.usdt.address]
              : [inputToken, this.setV2Setup.weth.address, this.setV2Setup.usdt.address],
          fees: inputToken === this.setV2Setup.weth.address ? [3000] : [3000, 3000],
          pool: ADDRESS_ZERO,
        },
      },
    ];

    return componentSwapData;
  }

  async getIssuanceInvokeWrapData(
    componentSwapData: ComponentSwapData[],
    flashMintContract: FlashMintWrapped,
  ) {
    const componentWrapData: ComponentWrapData[] = [
      {
        fromToken: componentSwapData[0].underlyingERC20,
        toToken: this.cDAI.address,
        amount: componentSwapData[0].buyUnderlyingAmount,
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
      {
        fromToken: componentSwapData[1].underlyingERC20,
        toToken: this.cUSDC.address,
        amount: componentSwapData[1].buyUnderlyingAmount,
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
      {
        fromToken: componentSwapData[2].underlyingERC20,
        toToken: this.cUSDT.address,
        amount: componentSwapData[2].buyUnderlyingAmount,
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
    ];

    const componentInvokeWrapData: ComponentInvokeWrapData[] = await flashMintContract.getWrapCallData(
      this.setV2Setup.wrapModule.address,
      componentWrapData,
    );

    return componentInvokeWrapData;
  }

  async getRedemptionComponentSwapData(outputToken: Address) {
    const componentSwapData: ComponentSwapData[] = [
      {
        underlyingERC20: this.setV2Setup.dai.address,
        buyUnderlyingAmount: ZERO, // not used in redeem
        dexData: {
          exchange: Exchange.UniV3,
          path:
            outputToken === this.setV2Setup.weth.address
              ? [this.setV2Setup.dai.address, outputToken]
              : [this.setV2Setup.dai.address, this.setV2Setup.weth.address, outputToken],
          fees: outputToken === this.setV2Setup.weth.address ? [3000] : [3000, 3000],
          pool: ADDRESS_ZERO,
        },
      },
      {
        underlyingERC20: this.setV2Setup.usdc.address,
        buyUnderlyingAmount: ZERO, // not used in redeem
        dexData: {
          exchange: Exchange.UniV3,
          path:
            outputToken === this.setV2Setup.weth.address
              ? [this.setV2Setup.usdc.address, outputToken]
              : [this.setV2Setup.usdc.address, this.setV2Setup.weth.address, outputToken],
          fees: outputToken === this.setV2Setup.weth.address ? [3000] : [3000, 3000],
          pool: ADDRESS_ZERO,
        },
      },
      {
        underlyingERC20: this.setV2Setup.usdt.address,
        buyUnderlyingAmount: ZERO, // not used in redeem
        dexData: {
          exchange: Exchange.UniV3,
          path:
            outputToken === this.setV2Setup.weth.address
              ? [this.setV2Setup.usdt.address, outputToken]
              : [this.setV2Setup.usdt.address, this.setV2Setup.weth.address, outputToken],
          fees: outputToken === this.setV2Setup.weth.address ? [3000] : [3000, 3000],
          pool: ADDRESS_ZERO,
        },
      },
    ];

    return componentSwapData;
  }

  async getRedemptionInvokeUnwrapData(
    componentSwapData: ComponentSwapData[],
    flashMintContract: FlashMintWrapped,
    redeemSetAmount: BigNumber,
    setToken = this.setToken.address,
  ) {
    // get received redemption components
    const [
      redemptionComponents, // cDAI, cUSDC and cUSDT, in that order
      redemptionUnits,
    ] = await this.issuanceModule.getRequiredComponentRedemptionUnits(setToken, redeemSetAmount);

    if (
      JSON.stringify([this.cDAI.address, this.cUSDC.address, this.cUSDT.address]) !==
      JSON.stringify(redemptionComponents)
    ) {
      throw new Error("redemption components test case not implemented");
    }

    const componentWrapData: ComponentWrapData[] = [
      {
        fromToken: this.cDAI.address,
        toToken: componentSwapData[0].underlyingERC20,
        amount: redemptionUnits[0],
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
      {
        fromToken: this.cUSDC.address,
        toToken: componentSwapData[1].underlyingERC20,
        amount: redemptionUnits[1],
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
      {
        fromToken: this.cUSDT.address,
        toToken: componentSwapData[2].underlyingERC20,
        amount: redemptionUnits[2],
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
    ];

    const componentInvokeUnwrapData: ComponentInvokeWrapData[] = await flashMintContract.getUnwrapCallData(
      this.setV2Setup.wrapModule.address,
      componentWrapData,
    );

    return componentInvokeUnwrapData;
  }

  async getRedemptionMinAmountOutput(
    setToken: Address,
    outputToken: Address,
    redeemSetAmount: BigNumber,
    componentSwapData: ComponentSwapData[],
    flashMintContract: FlashMintWrapped,
    tolerancePercentage: number = 1, // 1% tolerance
  ) {
    // get received redemption components
    const [, redemptionUnits] = await this.issuanceModule.getRequiredComponentRedemptionUnits(
      setToken,
      redeemSetAmount,
    );

    // get exchange rates for each of the cTokens
    const exchangeRateDAI = await this.cDAI.callStatic.exchangeRateCurrent();
    const exchangeRateUSDC = await this.cUSDC.callStatic.exchangeRateCurrent();
    const exchangeRateUSDT = await this.cUSDT.callStatic.exchangeRateCurrent();

    const expectedDAI = redemptionUnits[0].mul(exchangeRateDAI.div(1e6)).div(1e12);
    const expectedUSDC = redemptionUnits[1].mul(exchangeRateUSDC.div(1e6)).div(1e12);
    const expectedUSDT = redemptionUnits[2].mul(exchangeRateUSDT.div(1e6)).div(1e12);

    componentSwapData[0].buyUnderlyingAmount = expectedDAI;
    componentSwapData[1].buyUnderlyingAmount = expectedUSDC;
    componentSwapData[2].buyUnderlyingAmount = expectedUSDT;

    const estimatedOutputAmount: BigNumber = await flashMintContract.callStatic.getRedeemExactSet(
      setToken,
      outputToken,
      redeemSetAmount,
      componentSwapData,
    );

    // add some slight tolerance to the expected output to cover minor pricing changes or slippage until
    // tx is actually executed
    return estimatedOutputAmount
      .mul(BigNumber.from(100 - tolerancePercentage))
      .div(BigNumber.from(100));
  }

  async issueSetTokens(
    flashMintContract: FlashMintWrapped,
    issueSetAmount: BigNumber = ether(100),
    setToken: Address = this.setToken.address,
  ) {
    const inputToken = this.setV2Setup.dai;
    const componentSwapData = await this.getIssuanceComponentSwapData(
      inputToken.address,
      issueSetAmount,
    );
    const componentInvokeWrapData = await this.getIssuanceInvokeWrapData(
      componentSwapData,
      flashMintContract,
    );

    const maxAmountInputToken = await this.getRequiredIssuanceInputAmount(
      setToken,
      inputToken.address,
      issueSetAmount,
      componentSwapData,
      flashMintContract,
    );

    await flashMintContract.approveSetToken(setToken);

    return await flashMintContract.issueExactSetFromERC20(
      setToken,
      inputToken.address,
      issueSetAmount,
      maxAmountInputToken,
      componentSwapData,
      componentInvokeWrapData,
    );
  }
}
//#endregion

// seed liquidity is
// uniV3: WETH <-> USDC, WETH <-> USDT and WETH <-> DAI
describe("FlashMintWrapped", async () => {
  const testHelper = new TestHelper();

  //#region basic setup, deployment & constructor
  // basic test setup, Setv2, modules, set token, external protocols etc.
  cacheBeforeEach(async () => {
    await testHelper.init();
    await testHelper.defaultSetV2Setup();

    // prepare external protocols
    await testHelper.compoundSetup();
    await testHelper.setupDexes();
    await testHelper.seedDexLiquidity();

    // prepare our suite
    await testHelper.createSetToken();
    await testHelper.initializeContracts();
    await testHelper.deployManager();

    await testHelper.issueInitialSetTokens();
  });

  context("basic setup", async () => {
    describe("#constructor", async () => {
      it("should deploy & set constructor data correctly", async () => {
        const flashMintContract: FlashMintWrapped = await testHelper.deployFlashMintWrappedExtension();

        const addresses = await flashMintContract.dexAdapter();

        expect(addresses.quickRouter).to.eq(ADDRESS_ZERO, "quickswap");
        expect(addresses.sushiRouter).to.eq(testHelper.sushiswap.router.address, "sushiswap");
        expect(addresses.uniV3Router).to.eq(
          testHelper.uniswapV3.swapRouter.address,
          "uniswapV3 router",
        );
        expect(addresses.uniV3Quoter).to.eq(
          testHelper.uniswapV3.quoter.address,
          "uniswapV3 quoter",
        );
        expect(addresses.curveAddressProvider).to.eq(ADDRESS_ZERO, "curveAddressProvider");
        expect(addresses.curveCalculator).to.eq(ADDRESS_ZERO, "curveCalculator");
        expect(addresses.weth).to.eq(testHelper.setV2Setup.weth.address, "weth");

        const expectedIssuanceModuleAddress = await flashMintContract.debtIssuanceModule();
        expect(expectedIssuanceModuleAddress).to.eq(
          testHelper.issuanceModule.address,
          "issuanceModule",
        );

        const expectedControllerAddress = await flashMintContract.setController();
        expect(expectedControllerAddress).to.eq(testHelper.controllerAddress, "controller");
      });
    });
  });
  //#endregion

  context("when flashMint is deployed", async () => {
    let flashMintContract: FlashMintWrapped;
    cacheBeforeEach(async () => {
      flashMintContract = await testHelper.deployFlashMintWrappedExtension();

      await testHelper.setV2Setup.dai
        .connect(testHelper.owner.wallet)
        .approve(flashMintContract.address, MAX_UINT_256);
      await testHelper.setV2Setup.usdc
        .connect(testHelper.owner.wallet)
        .approve(flashMintContract.address, MAX_UINT_256);
      await testHelper.setV2Setup.usdt
        .connect(testHelper.owner.wallet)
        .approve(flashMintContract.address, MAX_UINT_256);
    });

    //#region approveSetToken
    describe("#approveSetToken", async () => {
      async function subject(setToken: Address = testHelper.setToken.address) {
        await flashMintContract.approveSetToken(setToken);
      }

      it("should approve set token", async () => {
        await subject();
      });

      it("should fail when not a set token", async () => {
        await expectThrowsAsync(subject(testHelper.cDAI.address), "FlashMint: INVALID_SET");
      });

      it("should approve all Set components to issuanceModule", async () => {
        // get all set components as IERC20
        const components: IERC20[] = (await testHelper.setToken.getComponents()).map(component =>
          IERC20__factory.connect(component, ethers.provider),
        );

        // allowance before should be 0
        for (const component of components) {
          const allowanceBefore = await component.allowance(
            flashMintContract.address,
            testHelper.issuanceModule.address,
          );
          expect(allowanceBefore).to.equal(ZERO);
        }

        await subject();

        // allowance after should be MAX_UINT_256
        for (const component of components) {
          const allowanceAfter = await ((component as unknown) as IERC20).allowance(
            flashMintContract.address,
            testHelper.issuanceModule.address,
          );
          expect(allowanceAfter).to.equal(MAX_UINT_256);
        }
      });
    });
    //#endregion

    //#region allowList wrapCallTarget
    describe("#allowList wrap call Target", async () => {
      async function subject(overwriteFrom?: SignerWithAddress) {
        await flashMintContract
          .connect(overwriteFrom || testHelper.owner.wallet)
          .setAllowWrapTarget(testHelper.setV2Setup.wbtc.address, true);
      }

      it("should set allowList wrap callTarget", async () => {
        let isWrapCallTarget = await flashMintContract.isWrapCallTarget(
          testHelper.setV2Setup.wbtc.address,
        );
        expect(isWrapCallTarget).to.equal(false);

        await subject();

        isWrapCallTarget = await flashMintContract.isWrapCallTarget(
          testHelper.setV2Setup.wbtc.address,
        );
        expect(isWrapCallTarget).to.equal(true);
      });

      it("should unset allowList wrap callTarget", async () => {
        await subject();
        let isWrapCallTarget = await flashMintContract.isWrapCallTarget(
          testHelper.setV2Setup.wbtc.address,
        );
        expect(isWrapCallTarget).to.equal(true);

        await flashMintContract.setAllowWrapTarget(testHelper.setV2Setup.wbtc.address, false);

        isWrapCallTarget = await flashMintContract.isWrapCallTarget(
          testHelper.setV2Setup.wbtc.address,
        );
        expect(isWrapCallTarget).to.equal(false);
      });

      it("should revert if not owner", async () => {
        await expect(subject((await getAccounts())[2].wallet)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });
    //#endregion

    //#region getters
    // all getter functions are indirectly tested through the other tests, only reverts are tested explicitly:
    // getWrapCallData
    // getUnwrapCallData
    // getIssueExactSet
    // getRedeemExactSet
    describe("#getIssueExactSet", async () => {
      async function subject(
        issueSetAmount = ether(10),
        inputToken = testHelper.setV2Setup.usdc.address,
        setToken = testHelper.setToken.address,
      ) {
        const componentSwapData: ComponentSwapData[] = [];
        await flashMintContract.getIssueExactSet(
          setToken,
          inputToken,
          issueSetAmount,
          componentSwapData,
        );
      }

      // Note component swap data checks are tested through other tests (e.g. path)

      it("should revert if issueSetAmount is 0", async () => {
        const revertReason = "FlashMint: INVALID_INPUTS";
        await expect(subject(ZERO)).to.be.revertedWith(revertReason);
      });

      it("should revert if input token is 0x00", async () => {
        const revertReason = "FlashMint: INVALID_INPUTS";
        await expect(subject(ether(10), ADDRESS_ZERO)).to.be.revertedWith(revertReason);
      });

      it("should revert if not a set token", async () => {
        const revertReason = "FlashMint: INVALID_SET";
        await expect(
          subject(
            ether(10),
            testHelper.setV2Setup.usdc.address,
            testHelper.setV2Setup.wbtc.address,
          ),
        ).to.be.revertedWith(revertReason);
      });
    });

    describe("#getRedeemExactSet", async () => {
      async function subject(
        redeeemSetAmount = ether(10),
        outputToken = testHelper.setV2Setup.usdc.address,
        setToken = testHelper.setToken.address,
      ) {
        const componentSwapData: ComponentSwapData[] = [];
        await flashMintContract.getRedeemExactSet(
          setToken,
          outputToken,
          redeeemSetAmount,
          componentSwapData,
        );
      }

      // Note component swap data checks are tested through other tests (e.g. path)

      it("should revert if redeeemSetAmount is 0", async () => {
        const revertReason = "FlashMint: INVALID_INPUTS";
        await expect(subject(ZERO)).to.be.revertedWith(revertReason);
      });

      it("should revert if output token is 0x00", async () => {
        const revertReason = "FlashMint: INVALID_INPUTS";
        await expect(subject(ether(10), ADDRESS_ZERO)).to.be.revertedWith(revertReason);
      });

      it("should revert if not a set token", async () => {
        const revertReason = "FlashMint: INVALID_SET";
        await expect(
          subject(
            ether(10),
            testHelper.setV2Setup.usdc.address,
            testHelper.setV2Setup.wbtc.address,
          ),
        ).to.be.revertedWith(revertReason);
      });
    });
    //#endregion

    //#region issue
    ["DAI", "USDC", "ETH"].forEach(tokenName => {
      describe(`\n\n\n---------\n\n #issueExactSetFrom${
        tokenName !== "ETH" ? "ERC20" : tokenName
      }: paying with ${tokenName}`, async () => {
        //#region issue setup
        let issueSetAmount: BigNumber;
        let setToken: Address;
        let maxAmountInputToken: BigNumber;
        let componentSwapData: ComponentSwapData[];
        let componentInvokeWrapData: ComponentInvokeWrapData[];
        let inputToken: StandardTokenMock | WETH9;
        let inputAmountSpent: BigNumber;

        beforeEach(async () => {
          if (tokenName === "DAI") {
            inputToken = testHelper.setV2Setup.dai;
          } else if (tokenName === "USDC") {
            inputToken = testHelper.setV2Setup.usdc;
          } else if (tokenName === "ETH") {
            // for ETH, input token for swaps etc. is WETH
            inputToken = testHelper.setV2Setup.weth;
          } else {
            throw new Error("test case not implemented!");
          }

          issueSetAmount = ether(100000);
          setToken = testHelper.setToken.address;

          componentSwapData = await testHelper.getIssuanceComponentSwapData(
            inputToken.address,
            issueSetAmount,
          );

          componentInvokeWrapData = await testHelper.getIssuanceInvokeWrapData(
            componentSwapData,
            flashMintContract,
          );

          maxAmountInputToken = await testHelper.getRequiredIssuanceInputAmount(
            setToken,
            inputToken.address,
            issueSetAmount,
            componentSwapData,
            flashMintContract,
          );

          await flashMintContract.approveSetToken(setToken);
        });

        async function subject(overwrite_input_address?: Address) {
          if (tokenName !== "ETH") {
            return await flashMintContract.issueExactSetFromERC20(
              setToken,
              overwrite_input_address || inputToken.address,
              issueSetAmount,
              maxAmountInputToken,
              componentSwapData,
              componentInvokeWrapData,
            );
          } else {
            return await flashMintContract.issueExactSetFromETH(
              setToken,
              issueSetAmount,
              componentSwapData,
              componentInvokeWrapData,
              { value: maxAmountInputToken },
            );
          }
        }
        //#endregion

        //#region issue tests with amount checks
        it(`should issue from ${tokenName}`, async () => {
          await subject();
        });

        it(`should not have left over amounts in contract after issue`, async () => {
          await subject();
          expect(await testHelper.cDAI.balanceOf(flashMintContract.address)).to.equal(ZERO);
          expect(await testHelper.cUSDC.balanceOf(flashMintContract.address)).to.equal(ZERO);
          expect(await testHelper.cUSDT.balanceOf(flashMintContract.address)).to.equal(ZERO);
          expect(await testHelper.setV2Setup.dai.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await testHelper.setV2Setup.usdc.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await testHelper.setV2Setup.usdt.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await testHelper.setV2Setup.weth.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await ethers.provider.getBalance(flashMintContract.address)).to.equal(ZERO);
        });

        it("should return the requested amount of set", async () => {
          const balanceBefore = await testHelper.setToken.balanceOf(testHelper.owner.address);
          await subject();
          const balanceAfter = await testHelper.setToken.balanceOf(testHelper.owner.address);
          expect(balanceAfter.sub(balanceBefore)).to.equal(issueSetAmount);
        });

        it("should cost less than the max amount", async () => {
          const balanceBefore = await testHelper.ownerBalanceOf(
            tokenName === "ETH" ? "ETH" : inputToken,
          );
          const tx = await subject();
          const balanceAfter = await testHelper.ownerBalanceOf(
            tokenName === "ETH" ? "ETH" : inputToken,
          );
          inputAmountSpent = balanceBefore.sub(balanceAfter);
          if (tokenName == "ETH") {
            const transactionFee = await getTxFee(tx);
            inputAmountSpent = inputAmountSpent.sub(transactionFee);
          }

          expect(inputAmountSpent.gt(0)).to.equal(true);
          expect(inputAmountSpent.lt(maxAmountInputToken)).to.equal(true);
        });

        it("should emit ExchangeIssuance event", async () => {
          await expect(subject())
            .to.emit(flashMintContract, "FlashMint")
            .withArgs(
              testHelper.owner.address,
              setToken,
              tokenName === "ETH" ? testHelper.ethAddress : inputToken.address,
              inputAmountSpent,
              issueSetAmount,
            );
        });

        it("should return excess Input amount", async () => {
          maxAmountInputToken = maxAmountInputToken.mul(3); // send way more than needed

          const balanceBefore = await testHelper.ownerBalanceOf(
            tokenName === "ETH" ? "ETH" : inputToken,
          );
          const tx = await subject();
          const balanceAfter = await testHelper.ownerBalanceOf(
            tokenName === "ETH" ? "ETH" : inputToken,
          );
          let inputAmountSpentWithExcess = balanceBefore.sub(balanceAfter);
          if (tokenName == "ETH") {
            const transactionFee = await getTxFee(tx);
            inputAmountSpentWithExcess = inputAmountSpentWithExcess.sub(transactionFee);
          }

          expect(inputAmountSpent).to.equal(inputAmountSpentWithExcess);
        });
        //#endregion

        //#region issue reverts
        it("should revert if maxAmountInputToken is zero", async () => {
          maxAmountInputToken = ZERO;
          const revertReason = "FlashMint: INVALID_INPUTS";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if issueSetAmount is zero", async () => {
          issueSetAmount = ZERO;
          const revertReason = "FlashMint: INVALID_INPUTS";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if input token is address 0x000", async () => {
          if (tokenName !== "ETH") {
            const revertReason = "FlashMint: INVALID_INPUTS";
            await expect(subject(ADDRESS_ZERO)).to.be.revertedWith(revertReason);
          }
        });

        it("should revert if invalid invoke wrap data length", async () => {
          const revertReason = "FlashMint: MISMATCH_INPUT_ARRAYS";
          componentInvokeWrapData = componentInvokeWrapData.slice(
            0,
            componentInvokeWrapData?.length - 1,
          );
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if invalid swap data length", async () => {
          const revertReason = "FlashMint: MISMATCH_INPUT_ARRAYS";
          componentSwapData = componentSwapData.slice(0, componentSwapData?.length - 1);
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if not a set token", async () => {
          setToken = testHelper.cDAI.address;
          const revertReason = "FlashMint: INVALID_SET";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if maxAmountInputToken is too low", async () => {
          maxAmountInputToken = BigNumber.from(100);
          const revertReason = tokenName === "ETH" ? "STF" : "UNDERBOUGHT_COMPONENT";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if exchange without liquidity is specified", async () => {
          componentSwapData[0].dexData.exchange = Exchange.Sushiswap;
          componentSwapData[1].dexData.exchange = Exchange.Sushiswap;
          await expect(subject()).to.be.revertedWith("");
        });

        it("should revert if exchange with too little liquidity is specified", async () => {
          // Set up sushiswap with insufficient liquidity
          await testHelper.setV2Setup.usdc
            .connect(testHelper.owner.wallet)
            .approve(testHelper.sushiswap.router.address, MAX_UINT_256);
          await testHelper.sushiswap.router
            .connect(testHelper.owner.wallet)
            .addLiquidityETH(
              testHelper.setV2Setup.usdc.address,
              UnitsUtils.usdc(10),
              MAX_UINT_256,
              MAX_UINT_256,
              testHelper.owner.address,
              (await getLastBlockTimestamp()).add(1),
              { value: ether(0.001), gasLimit: 9000000 },
            );

          await testHelper.setV2Setup.dai
            .connect(testHelper.owner.wallet)
            .approve(testHelper.sushiswap.router.address, MAX_UINT_256);
          await testHelper.sushiswap.router
            .connect(testHelper.owner.wallet)
            .addLiquidityETH(
              testHelper.setV2Setup.dai.address,
              UnitsUtils.usdc(10),
              MAX_UINT_256,
              MAX_UINT_256,
              testHelper.owner.address,
              (await getLastBlockTimestamp()).add(1),
              { value: ether(0.001), gasLimit: 9000000 },
            );

          componentSwapData[0].dexData.exchange = Exchange.Sushiswap;
          componentSwapData[1].dexData.exchange = Exchange.Sushiswap;

          await expect(subject()).to.be.revertedWith("ds-math-sub-underflow");
        });

        it("should revert if a not allowListed wrap call target is specified", async () => {
          componentInvokeWrapData = [
            { ...componentInvokeWrapData[0], callTarget: testHelper.setV2Setup.wbtc.address },
            { ...componentInvokeWrapData[1], callTarget: testHelper.setV2Setup.wbtc.address },
            { ...componentInvokeWrapData[2], callTarget: testHelper.setV2Setup.wbtc.address },
          ];
          await expect(subject()).to.be.revertedWith("FlashMint: WRAP_CALLTARGET_NOT_ALLOWED");
        });

        it("should revert if wrap call data is missing", async () => {
          componentInvokeWrapData = [
            { ...componentInvokeWrapData[0], callData: ZERO_BYTES },
            { ...componentInvokeWrapData[1], callData: ZERO_BYTES },
            { ...componentInvokeWrapData[2], callData: ZERO_BYTES },
          ];
          await expect(subject()).to.be.revertedWith("FlashMint: WRAP_DATA_MISSING");
        });

        it("should revert if wrap call target is 0x000", async () => {
          componentInvokeWrapData = [
            { ...componentInvokeWrapData[0], callTarget: ADDRESS_ZERO },
            { ...componentInvokeWrapData[1], callTarget: ADDRESS_ZERO },
            { ...componentInvokeWrapData[2], callTarget: ADDRESS_ZERO },
          ];
          await expect(subject()).to.be.revertedWith("FlashMint: WRAP_DATA_MISSING");
        });

        it("should revert if invalid swap path input token is given", async () => {
          const revertReason = "FlashMint: INPUT_TOKEN_NOT_IN_PATH";
          componentSwapData[2].dexData.path[0] = testHelper.setV2Setup.wrapModule.address; // just some other address
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if invalid swap path output token is given", async () => {
          const revertReason = "FlashMint: OUTPUT_TOKEN_NOT_IN_PATH";
          componentSwapData[2].dexData.path[componentSwapData[2].dexData.path.length - 1] =
            testHelper.setV2Setup.wrapModule.address; // just some other address
          await expect(subject()).to.be.revertedWith(revertReason);
        });
        //#endregion
      });
    });
    //#endregion

    //#region redeem
    ["DAI", "USDC", "ETH"].forEach(tokenName => {
      describe(`\n\n\n---------\n\n #redeemExactSetFor${
        tokenName !== "ETH" ? "ERC20" : tokenName
      }: receiving ${tokenName}`, async () => {
        //#region redeem setup
        let redeemSetAmount: BigNumber;
        let setToken: Address;
        let minAmounOutput: BigNumber;
        let componentSwapData: ComponentSwapData[];
        let componentInvokeUnwrapData: ComponentInvokeWrapData[];
        let outputToken: StandardTokenMock | WETH9;
        let outputAmountReceived: BigNumber;

        beforeEach(async () => {
          if (tokenName === "DAI") {
            outputToken = testHelper.setV2Setup.dai;
          } else if (tokenName === "USDC") {
            outputToken = testHelper.setV2Setup.usdc;
          } else if (tokenName === "ETH") {
            // for ETH, output token for swaps etc. is WETH
            outputToken = testHelper.setV2Setup.weth;
          } else {
            throw new Error("test case not implemented!");
          }

          // issue set tokens to be redeemed
          await testHelper.issueSetTokens(flashMintContract);

          redeemSetAmount = ether(100);
          setToken = testHelper.setToken.address;

          componentSwapData = await testHelper.getRedemptionComponentSwapData(outputToken.address);

          componentInvokeUnwrapData = await testHelper.getRedemptionInvokeUnwrapData(
            componentSwapData,
            flashMintContract,
            redeemSetAmount,
          );

          minAmounOutput = await testHelper.getRedemptionMinAmountOutput(
            setToken,
            outputToken.address,
            redeemSetAmount,
            componentSwapData,
            flashMintContract,
          );

          await testHelper.setToken.approve(flashMintContract.address, redeemSetAmount);
        });

        async function subject(overwrite_output_address?: Address) {
          if (tokenName !== "ETH") {
            return await flashMintContract.redeemExactSetForERC20(
              setToken,
              overwrite_output_address || outputToken.address,
              redeemSetAmount,
              minAmounOutput,
              componentSwapData,
              componentInvokeUnwrapData,
            );
          } else {
            return await flashMintContract.redeemExactSetForETH(
              setToken,
              redeemSetAmount,
              minAmounOutput,
              componentSwapData,
              componentInvokeUnwrapData,
            );
          }
        }
        //#endregion

        //#region redeem tests with amount checks
        it(`should redeem to ${tokenName}`, async () => {
          await subject();
        });

        it(`should not have left over amounts in contract after redeem`, async () => {
          await subject();
          expect(await testHelper.cDAI.balanceOf(flashMintContract.address)).to.equal(ZERO);
          expect(await testHelper.cUSDC.balanceOf(flashMintContract.address)).to.equal(ZERO);
          expect(await testHelper.cUSDT.balanceOf(flashMintContract.address)).to.equal(ZERO);
          expect(await testHelper.setV2Setup.dai.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await testHelper.setV2Setup.usdc.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await testHelper.setV2Setup.usdt.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await testHelper.setV2Setup.weth.balanceOf(flashMintContract.address)).to.equal(
            ZERO,
          );
          expect(await ethers.provider.getBalance(flashMintContract.address)).to.equal(ZERO);
        });

        it("should redeem the requested amount of set", async () => {
          const balanceBefore = await testHelper.setToken.balanceOf(testHelper.owner.address);
          await subject();
          const balanceAfter = await testHelper.setToken.balanceOf(testHelper.owner.address);
          expect(balanceBefore.sub(balanceAfter)).to.equal(redeemSetAmount);
        });

        it("should return at least the expected output amount", async () => {
          const balanceBefore = await testHelper.ownerBalanceOf(
            tokenName === "ETH" ? "ETH" : outputToken,
          );
          const tx = await subject();
          const balanceAfter = await testHelper.ownerBalanceOf(
            tokenName === "ETH" ? "ETH" : outputToken,
          );
          outputAmountReceived = balanceAfter.sub(balanceBefore);
          if (tokenName == "ETH") {
            const transactionFee = await getTxFee(tx);
            outputAmountReceived = outputAmountReceived.add(transactionFee);
          }

          expect(outputAmountReceived.gt(0)).to.equal(true);
          expect(outputAmountReceived.gt(minAmounOutput)).to.equal(true);
        });

        it("should emit ExchangeIssuance event", async () => {
          await expect(subject())
            .to.emit(flashMintContract, "FlashRedeem")
            .withArgs(
              testHelper.owner.address,
              setToken,
              tokenName === "ETH" ? testHelper.ethAddress : outputToken.address,
              redeemSetAmount,
              outputAmountReceived,
            );
        });
        //#endregion

        // #region redeem reverts
        it("should revert if redeemSetAmount is zero", async () => {
          redeemSetAmount = ZERO;
          const revertReason = "FlashMint: INVALID_INPUTS";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if output token is address 0x000", async () => {
          if (tokenName !== "ETH") {
            const revertReason = "FlashMint: INVALID_INPUTS";
            await expect(subject(ADDRESS_ZERO)).to.be.revertedWith(revertReason);
          }
        });

        it("should revert if invalid invoke unwrap data length", async () => {
          const revertReason = "FlashMint: MISMATCH_INPUT_ARRAYS";
          componentInvokeUnwrapData = componentInvokeUnwrapData.slice(
            0,
            componentInvokeUnwrapData?.length - 1,
          );
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if invalid swap data length", async () => {
          const revertReason = "FlashMint: MISMATCH_INPUT_ARRAYS";
          componentSwapData = componentSwapData.slice(0, componentSwapData?.length - 1);
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if not a set token", async () => {
          setToken = testHelper.cDAI.address;
          const revertReason = "FlashMint: INVALID_SET";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if minAmountOutput is too high", async () => {
          minAmounOutput = minAmounOutput.mul(BigNumber.from(10));
          const revertReason = "INSUFFICIENT_OUTPUT_AMOUNT";
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if exchange without liquidity is specified", async () => {
          componentSwapData[0].dexData.exchange = Exchange.Sushiswap;
          componentSwapData[1].dexData.exchange = Exchange.Sushiswap;
          await expect(subject()).to.be.revertedWith("");
        });

        it("should revert if exchange with too little liquidity is specified", async () => {
          // Set up sushiswap with insufficient liquidity
          await testHelper.setV2Setup.usdc
            .connect(testHelper.owner.wallet)
            .approve(testHelper.sushiswap.router.address, MAX_UINT_256);
          await testHelper.sushiswap.router
            .connect(testHelper.owner.wallet)
            .addLiquidityETH(
              testHelper.setV2Setup.usdc.address,
              BigNumber.from(1),
              MAX_UINT_256,
              MAX_UINT_256,
              testHelper.owner.address,
              (await getLastBlockTimestamp()).add(1),
              { value: ether(0.00001), gasLimit: 9000000 },
            );

          await testHelper.setV2Setup.dai
            .connect(testHelper.owner.wallet)
            .approve(testHelper.sushiswap.router.address, MAX_UINT_256);
          await testHelper.sushiswap.router
            .connect(testHelper.owner.wallet)
            .addLiquidityETH(
              testHelper.setV2Setup.dai.address,
              BigNumber.from(1),
              MAX_UINT_256,
              MAX_UINT_256,
              testHelper.owner.address,
              (await getLastBlockTimestamp()).add(1),
              { value: ether(0.00001), gasLimit: 9000000 },
            );

          componentSwapData[0].dexData.exchange = Exchange.Sushiswap;
          componentSwapData[1].dexData.exchange = Exchange.Sushiswap;

          await expect(subject()).to.be.revertedWith("INSUFFICIENT_OUTPUT_AMOUNT");
        });

        it("should revert if a not allowListed wrap call target is specified", async () => {
          componentInvokeUnwrapData = [
            { ...componentInvokeUnwrapData[0], callTarget: testHelper.setV2Setup.wbtc.address },
            { ...componentInvokeUnwrapData[1], callTarget: testHelper.setV2Setup.wbtc.address },
            { ...componentInvokeUnwrapData[2], callTarget: testHelper.setV2Setup.wbtc.address },
          ];
          await expect(subject()).to.be.revertedWith("FlashMint: WRAP_CALLTARGET_NOT_ALLOWED");
        });

        it("should revert if wrap call data is missing", async () => {
          componentInvokeUnwrapData = [
            { ...componentInvokeUnwrapData[0], callData: ZERO_BYTES },
            { ...componentInvokeUnwrapData[1], callData: ZERO_BYTES },
            { ...componentInvokeUnwrapData[2], callData: ZERO_BYTES },
          ];
          await expect(subject()).to.be.revertedWith("FlashMint: UNWRAP_DATA_MISSING");
        });

        it("should revert if wrap call target is 0x000", async () => {
          componentInvokeUnwrapData = [
            { ...componentInvokeUnwrapData[0], callTarget: ADDRESS_ZERO },
            { ...componentInvokeUnwrapData[1], callTarget: ADDRESS_ZERO },
            { ...componentInvokeUnwrapData[2], callTarget: ADDRESS_ZERO },
          ];
          await expect(subject()).to.be.revertedWith("FlashMint: UNWRAP_DATA_MISSING");
        });

        it("should revert if invalid swap path input token is given", async () => {
          const revertReason = "FlashMint: INPUT_TOKEN_NOT_IN_PATH";
          componentSwapData[2].dexData.path[0] = testHelper.setV2Setup.wrapModule.address; // just some other address
          await expect(subject()).to.be.revertedWith(revertReason);
        });

        it("should revert if invalid swap path output token is given", async () => {
          const revertReason = "FlashMint: OUTPUT_TOKEN_NOT_IN_PATH";
          componentSwapData[2].dexData.path[componentSwapData[0].dexData.path.length - 1] =
            testHelper.setV2Setup.wrapModule.address; // just some other address
          await expect(subject()).to.be.revertedWith(revertReason);
        });
        // #endregion
      });
    });
    //#endregion
  });
});
