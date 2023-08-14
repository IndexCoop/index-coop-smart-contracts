import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, usdc, getSetFixture, preciseMul } from "@utils/index";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import {
  IWETH,
  StandardTokenMock,
  IUniswapV2Router,
  FlashMintWrapped,
  IERC20__factory,
  IERC20,
  IDebtIssuanceModule,
  CERc20__factory,
  ICErc20__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, ZERO, ZERO_BYTES } from "@utils/constants";
import { ether } from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { getTxFee } from "@utils/test";

const expect = getWaffleExpect();
const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;

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
  integrationName: string; // wrap adapter integration name as listed in the IntegrationRegistry for the wrapModule
  wrapData: string; // optional wrapData passed to the wrapAdapter
};

//#endregion

const getDeadline = async () => {
  const block = await ethers.provider.getBlock("latest");
  // add 7 days
  return BigNumber.from(block.timestamp).add(60 * 60 * 24 * 7);
};
class TestHelper {
  async getIssuanceComponentSwapData(
    inputToken: Address,
    issueSetAmount: BigNumber,
    setToken: Address,
    issuanceModule: IDebtIssuanceModule,
  ) {
    // get required issuance components
    const [
      issuanceComponents, // cDAI, cUSDC
      issuanceUnits,
    ] = await issuanceModule.getRequiredComponentIssuanceUnits(setToken, issueSetAmount);

    const cDAI = CERc20__factory.connect(addresses.tokens.cDAI, ethers.provider);
    const cUSDC = CERc20__factory.connect(addresses.tokens.cUSDC, ethers.provider);

    if (
      JSON.stringify([cDAI.address, cUSDC.address]).toLowerCase() !==
      JSON.stringify(issuanceComponents).toLowerCase()
    ) {
      throw new Error("issuance components test case not implemented");
    }

    // get exchange rates for each of the cTokens
    // RETURN: The current exchange rate as an unsigned integer, scaled by 1 * 10^(18 - 8 + Underlying Token Decimals).
    const exchangeRateDAI = await cDAI.callStatic.exchangeRateCurrent();
    const exchangeRateUSDC = await cUSDC.callStatic.exchangeRateCurrent();

    // precision good enough for test case, should be done exact in JS library
    let requiredDAI = issuanceUnits[0].mul(exchangeRateDAI.div(1e6)).div(1e12);
    let requiredUSDC = issuanceUnits[1].mul(exchangeRateUSDC.div(1e6)).div(1e12);

    // add a minimum of tolerance...(one unit)
    requiredDAI = requiredDAI.add(ether(1));
    requiredUSDC = requiredUSDC.add(usdc(1));

    const componentSwapData: ComponentSwapData[] = [
      {
        underlyingERC20: addresses.tokens.dai,
        buyUnderlyingAmount: requiredDAI,
        dexData: {
          exchange: Exchange.Sushiswap,
          path:
            inputToken === addresses.dexes.curve.ethAddress
              ? [addresses.tokens.weth, addresses.tokens.dai]
              : [inputToken, addresses.tokens.weth, addresses.tokens.dai],
          fees: inputToken === addresses.dexes.curve.ethAddress ? [500] : [500, 500], // not needed for sushi
          pool: ADDRESS_ZERO,
        },
      },
      {
        underlyingERC20: addresses.tokens.USDC,
        buyUnderlyingAmount: requiredUSDC,
        dexData: {
          exchange: Exchange.Sushiswap,
          path:
            inputToken === addresses.dexes.curve.ethAddress
              ? [addresses.tokens.weth, addresses.tokens.USDC]
              : [inputToken, addresses.tokens.weth, addresses.tokens.USDC],
          fees: inputToken === addresses.dexes.curve.ethAddress ? [500] : [500, 500], // not needed for sushi
          pool: ADDRESS_ZERO,
        },
      },
    ];

    return componentSwapData;
  }

  getWrapData(): ComponentWrapData[] {
    return [
      {
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
      {
        integrationName: compoundWrapAdapterIntegrationName,
        wrapData: ZERO_BYTES,
      },
    ];
  }

  async getRedemptionComponentSwapData(outputToken: Address) {
    const componentSwapData: ComponentSwapData[] = [
      {
        underlyingERC20: addresses.tokens.dai,
        buyUnderlyingAmount: ZERO, // not used in redeem
        dexData: {
          exchange: Exchange.Sushiswap,
          path:
            outputToken === addresses.dexes.curve.ethAddress
              ? [addresses.tokens.dai, addresses.tokens.weth]
              : [addresses.tokens.dai, addresses.tokens.weth, outputToken],
          fees: outputToken === addresses.tokens.weth ? [500] : [500, 500], // not used for sushi
          pool: ADDRESS_ZERO,
        },
      },
      {
        underlyingERC20: addresses.tokens.USDC,
        buyUnderlyingAmount: ZERO, // not used in redeem
        dexData: {
          exchange: Exchange.Sushiswap,
          path:
            outputToken === addresses.dexes.curve.ethAddress
              ? [addresses.tokens.USDC, addresses.tokens.weth]
              : [addresses.tokens.USDC, addresses.tokens.weth, outputToken],
          fees: outputToken === addresses.tokens.weth ? [500] : [500, 500], // not used for sushi
          pool: ADDRESS_ZERO,
        },
      },
    ];
    return componentSwapData;
  }

  async getRedemptionMinAmountOutput(
    setToken: Address,
    outputToken: Address,
    redeemSetAmount: BigNumber,
    componentSwapData: ComponentSwapData[],
    flashMintContract: FlashMintWrapped,
    issuanceModule: IDebtIssuanceModule,
    tolerancePercentage: number = 1, // 1% tolerance
  ) {
    // get received redemption components
    const [, redemptionUnits] = await issuanceModule.getRequiredComponentRedemptionUnits(
      setToken,
      redeemSetAmount,
    );

    // get exchange rates for each of the cTokens
    const exchangeRateDAI = await ICErc20__factory.connect(
      addresses.tokens.cDAI,
      ethers.provider,
    ).callStatic.exchangeRateCurrent();

    const exchangeRateUSDC = await ICErc20__factory.connect(
      addresses.tokens.cUSDC,
      ethers.provider,
    ).callStatic.exchangeRateCurrent();

    const expectedDAI = redemptionUnits[0].mul(exchangeRateDAI.div(1e6)).div(1e12);
    const expectedUSDC = redemptionUnits[1].mul(exchangeRateUSDC.div(1e6)).div(1e12);

    componentSwapData[0].buyUnderlyingAmount = expectedDAI;
    componentSwapData[1].buyUnderlyingAmount = expectedUSDC;

    const estimatedOutputAmount: BigNumber = await flashMintContract.callStatic.getRedeemExactSet(
      setToken,
      outputToken === addresses.dexes.curve.ethAddress ? addresses.tokens.weth : outputToken,
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
    setToken: Address,
    owner: Account,
    issuanceModule: IDebtIssuanceModule,
    wrapModule: Address,
    issueSetAmount: BigNumber = ether(100),
  ) {
    const inputToken = IERC20__factory.connect(addresses.tokens.USDC, ethers.provider);

    const amountIn = usdc(10000);

    const uniV2Router = (await ethers.getContractAt(
      "IUniswapV2Router",
      addresses.dexes.uniV2.router,
    )) as IUniswapV2Router;

    await uniV2Router.swapETHForExactTokens(
      amountIn,
      [addresses.tokens.weth, inputToken.address],
      owner.address,
      await getDeadline(),
      { value: ether(1000) },
    );

    await inputToken.connect(owner.wallet).approve(flashMintContract.address, amountIn);

    const componentSwapData = await this.getIssuanceComponentSwapData(
      inputToken.address,
      issueSetAmount,
      setToken,
      issuanceModule,
    );

    await flashMintContract.approveSetToken(setToken);

    return await flashMintContract.issueExactSetFromERC20(
      setToken,
      inputToken.address,
      issueSetAmount,
      amountIn,
      componentSwapData,
      this.getWrapData(),
    );
  }
}

if (process.env.INTEGRATIONTEST) {
  describe("FlashMintWrapped - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let USDC: StandardTokenMock;
    let weth: IWETH;
    let setV2Setup: SetFixture;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setV2Setup = getSetFixture(owner.address);
      await setV2Setup.initialize();

      // deploy CompoundWrapV2Adapter
      const compoundWrapAdapter = await deployer.setV2.deployCompoundWrapV2Adapter();
      await setV2Setup.integrationRegistry.addIntegration(
        setV2Setup.wrapModule.address,
        compoundWrapAdapterIntegrationName,
        compoundWrapAdapter.address,
      );

      // create set token with cDAI and cUSDC
      setToken = await setV2Setup.createSetToken(
        [addresses.tokens.cDAI, addresses.tokens.cUSDC],
        [BigNumber.from(200_000_000), BigNumber.from(300_000_000)],
        [
          setV2Setup.debtIssuanceModule.address,
          setV2Setup.streamingFeeModule.address,
          setV2Setup.wrapModule.address,
        ],
      );

      await setV2Setup.debtIssuanceModule.initialize(
        setToken.address,
        ZERO,
        ZERO,
        ZERO,
        ADDRESS_ZERO,
        ADDRESS_ZERO,
      );

      USDC = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.USDC,
      )) as StandardTokenMock;

      weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;
    });

    context("When flash mint wrapped is deployed", () => {
      let flashMintContract: FlashMintWrapped;
      //#region basic setup and constructor with addresses set correctly checks
      before(async () => {
        flashMintContract = await deployer.extensions.deployFlashMintWrappedExtension(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.dexes.curve.addressProvider,
          addresses.dexes.curve.calculator,
          setV2Setup.controller.address,
          setV2Setup.debtIssuanceModule.address,
          setV2Setup.wrapModule.address,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintContract.dexAdapter();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintContract.dexAdapter();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintContract.dexAdapter();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintContract.dexAdapter();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("uniV3 quoter address is set correctly", async () => {
        const returnedAddresses = await flashMintContract.dexAdapter();
        expect(returnedAddresses.uniV3Quoter).to.eq(utils.getAddress(addresses.dexes.uniV3.quoter));
      });

      it("controller address is set correctly", async () => {
        expect(await flashMintContract.setController()).to.eq(
          utils.getAddress(setV2Setup.controller.address),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintContract.issuanceModule()).to.eq(
          utils.getAddress(setV2Setup.debtIssuanceModule.address),
        );
      });
      //#endregion

      describe("When setToken is approved", () => {
        before(async () => {
          await flashMintContract.approveSetToken(setToken.address);
        });

        ["USDC", "ETH"].forEach(tokenName => {
          describe(`When input/output token is ${tokenName}`, () => {
            const testHelper = new TestHelper();

            //#region issue
            describe(
              tokenName == "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                //#region issue test setup
                let inputToken: IERC20;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;

                let issueSetAmount: BigNumber;
                let inputAmount: BigNumber;

                let componentSwapData: ComponentSwapData[];

                beforeEach(async () => {
                  inputAmount = ether(100);

                  inputToken = IERC20__factory.connect(
                    tokenName === "ETH" ? addresses.dexes.curve.ethAddress : USDC.address,
                    ethers.provider,
                  );

                  if (tokenName !== "ETH") {
                    inputAmount = usdc(10000);

                    const uniV2Router = (await ethers.getContractAt(
                      "IUniswapV2Router",
                      addresses.dexes.uniV2.router,
                    )) as IUniswapV2Router;

                    await uniV2Router.swapETHForExactTokens(
                      inputAmount,
                      [weth.address, USDC.address],
                      owner.address,
                      await getDeadline(),
                      { value: ether(100) },
                    );
                  }

                  subjectMaxAmountIn = inputAmount;

                  const inputTokenBalance: BigNumber = await (tokenName === "ETH"
                    ? owner.wallet.getBalance()
                    : inputToken.balanceOf(owner.address));
                  if (tokenName === "ETH") {
                    subjectMaxAmountIn = inputAmount;
                  } else {
                    subjectMaxAmountIn = inputTokenBalance;

                    await inputToken
                      .connect(owner.wallet)
                      .approve(flashMintContract.address, subjectMaxAmountIn);
                  }

                  subjectSetToken = setToken.address;
                  issueSetAmount = ether(1000);

                  componentSwapData = await testHelper.getIssuanceComponentSwapData(
                    inputToken.address,
                    issueSetAmount,
                    subjectSetToken,
                    setV2Setup.debtIssuanceModule,
                  );
                });

                async function subject() {
                  if (tokenName !== "ETH") {
                    return await flashMintContract.issueExactSetFromERC20(
                      subjectSetToken,
                      inputToken.address,
                      issueSetAmount,
                      subjectMaxAmountIn,
                      componentSwapData,
                      testHelper.getWrapData(),
                    );
                  } else {
                    return await flashMintContract.issueExactSetFromETH(
                      subjectSetToken,
                      issueSetAmount,
                      componentSwapData,
                      testHelper.getWrapData(),
                      { value: subjectMaxAmountIn },
                    );
                  }
                }

                async function subjectQuote() {
                  return flashMintContract.callStatic.getIssueExactSet(
                    subjectSetToken,
                    inputToken.address,
                    issueSetAmount,
                    componentSwapData,
                  );
                }
                //#endregion

                //#region issue tests
                it("should issue the correct amount of tokens", async () => {
                  const setBalancebefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setObtained = setBalanceAfter.sub(setBalancebefore);
                  expect(setObtained).to.eq(issueSetAmount);
                });

                it("should spend less than specified max amount", async () => {
                  const inputBalanceBefore =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  await subject();
                  const inputBalanceAfter =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  expect(inputSpent.gt(0)).to.be.true;
                  expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
                });

                it("should quote the correct input amount", async () => {
                  const inputBalanceBefore =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const result = await subject();
                  const inputBalanceAfter =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  let inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

                  if (tokenName == "ETH") {
                    const gasFee = await flashMintContract.estimateGas.issueExactSetFromETH(
                      subjectSetToken,
                      issueSetAmount,
                      componentSwapData,
                      testHelper.getWrapData(),
                      { value: subjectMaxAmountIn },
                    );
                    const gasCost = gasFee.mul(result.gasPrice);

                    inputSpent = inputSpent.sub(gasCost);
                  }
                  const quotedInputAmount = await subjectQuote();
                  expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
                  expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
                });
                //#endregion
              },
            );
            //#endregion

            //#region redeem
            describe(
              tokenName == "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                //#region redeem test setup
                let outputToken: IERC20;

                let minAmountOutput: BigNumber;
                let redeemSetAmount: BigNumber;

                let componentSwapData: ComponentSwapData[];

                let subjectSetToken: Address;

                beforeEach(async () => {
                  outputToken = IERC20__factory.connect(
                    tokenName === "ETH" ? addresses.dexes.curve.ethAddress : USDC.address,
                    ethers.provider,
                  );

                  redeemSetAmount = ether(100);
                  subjectSetToken = setToken.address;

                  // issue set tokens to be redeemed
                  await testHelper.issueSetTokens(
                    flashMintContract,
                    subjectSetToken,
                    owner,
                    setV2Setup.debtIssuanceModule,
                    setV2Setup.wrapModule.address,
                    redeemSetAmount,
                  );

                  componentSwapData = await testHelper.getRedemptionComponentSwapData(
                    outputToken.address,
                  );

                  minAmountOutput = await testHelper.getRedemptionMinAmountOutput(
                    subjectSetToken,
                    outputToken.address,
                    redeemSetAmount,
                    componentSwapData,
                    flashMintContract,
                    setV2Setup.debtIssuanceModule,
                  );

                  await setToken.approve(flashMintContract.address, redeemSetAmount);
                });

                async function subject() {
                  if (tokenName == "ETH") {
                    return flashMintContract.redeemExactSetForETH(
                      subjectSetToken,
                      redeemSetAmount,
                      minAmountOutput,
                      componentSwapData,
                      testHelper.getWrapData(),
                    );
                  }
                  return flashMintContract.redeemExactSetForERC20(
                    subjectSetToken,
                    outputToken.address,
                    redeemSetAmount,
                    minAmountOutput,
                    componentSwapData,
                    testHelper.getWrapData(),
                  );
                }

                async function subjectQuote(): Promise<BigNumber> {
                  return flashMintContract.callStatic.getRedeemExactSet(
                    subjectSetToken,
                    outputToken.address,
                    redeemSetAmount,
                    componentSwapData,
                  );
                }
                //#endregion

                //#region redeem tests
                it("should redeem the correct amount of tokens", async () => {
                  const setBalanceBefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
                  expect(setRedeemed).to.eq(redeemSetAmount);
                });

                it("should return at least the specified minimum of output tokens", async () => {
                  const outputBalanceBefore =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);

                  const tx = await subject();

                  const outputBalanceAfter =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);

                  let outputObtained = outputBalanceAfter.sub(outputBalanceBefore);

                  if (tokenName == "ETH") {
                    const transactionFee = await getTxFee(tx);
                    outputObtained = outputObtained.add(transactionFee);
                  }

                  expect(outputObtained.gte(minAmountOutput)).to.be.true;
                });

                it("should quote the correct output amount", async () => {
                  let gasCount = BigNumber.from(0);
                  let gasCost: BigNumber;
                  let outputObtained: BigNumber;
                  const outputBalanceBefore =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  if (tokenName == "ETH") {
                    gasCount = await flashMintContract.estimateGas.redeemExactSetForETH(
                      subjectSetToken,
                      redeemSetAmount,
                      minAmountOutput,
                      componentSwapData,
                      testHelper.getWrapData(),
                    );
                  }
                  const result = await subject();
                  const outputBalanceAfter =
                    tokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  gasCount = preciseMul(gasCount, ether(0.9));
                  gasCost = gasCount.mul(result.gasPrice);
                  outputObtained = outputObtained.add(gasCost);
                  const outputAmountQuote = await subjectQuote();
                  expect(outputAmountQuote).to.gt(preciseMul(outputObtained, ether(0.99)));
                  expect(outputAmountQuote).to.lt(preciseMul(outputObtained, ether(1.01)));
                });
                //#endregion
              },
            );
            //#endregion
          });
        });
      });
    });
  });
}
