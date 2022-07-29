import { BigNumber, BigNumberish, ethers } from "ethers";
import { ether } from "@utils/index";
import { Address } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken, SlippageIssuanceModule } from "@utils/contracts/setV2";
import { StandardTokenMock, WETH9 } from "@utils/contracts/index";
import { UniswapV2Factory, UniswapV2Router02 } from "@utils/contracts/uniswap";
import { IQuoter } from "@typechain/IQuoter";
import { expect } from "chai";

export const getAllowances = async (
  tokens: (StandardTokenMock | WETH9)[],
  owner: string,
  spenders: string[],
) => {
  const allowances: BigNumber[] = [];
  tokens.forEach(async token => {
    allowances.push(
      ...(await Promise.all(
        spenders.map(async address => await token.allowance(owner, address)),
      )),
    );
  });
  return allowances;
};

export const getIssueSetForExactETH = async (
  setToken: SetToken,
  ethInput: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  let sumEth = BigNumber.from(0);
  const amountEthForComponents = [];
  const components = await setToken.getComponents();
  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    const unit = await setToken.getDefaultPositionRealUnit(component);

    let amountEthForComponent = ether(0);
    if (component === weth) {
      amountEthForComponent = unit;
    } else {
      const hasUniPair = await hasPair(uniswapFactory, weth, component);
      const uniAmount = hasUniPair
        ? (await uniswapRouter.getAmountsIn(unit, [weth, component]))[0]
        : MAX_UINT_256;
      const hasSushiPair = await hasPair(sushiswapFactory, weth, component);
      const sushiAmount = hasSushiPair
        ? (await sushiswapRouter.getAmountsIn(unit, [weth, component]))[0]
        : MAX_UINT_256;
      amountEthForComponent = uniAmount.lt(sushiAmount) ? uniAmount : sushiAmount;
    }

    amountEthForComponents.push(amountEthForComponent);
    sumEth = sumEth.add(amountEthForComponent);
  }

  let expectedOutput: BigNumber = MAX_UINT_256;
  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    const unit = await setToken.getDefaultPositionRealUnit(component);
    const scaledEth = amountEthForComponents[i].mul(ethInput).div(sumEth);

    let amountComponentOut = BigNumber.from(0);
    if (component === weth) {
      amountComponentOut = scaledEth;
    } else {
      const hasUniPair = await hasPair(uniswapFactory, weth, component);
      const uniAmount = hasUniPair
        ? (await uniswapRouter.getAmountsOut(scaledEth, [weth, component]))[1]
        : BigNumber.from(0);
      const hasSushiPair = await hasPair(sushiswapFactory, weth, component);
      const sushiAmount = hasSushiPair
        ? (await sushiswapRouter.getAmountsOut(scaledEth, [weth, component]))[1]
        : BigNumber.from(0);
      amountComponentOut = uniAmount.gt(sushiAmount) ? uniAmount : sushiAmount;
    }

    const potentialSetTokenOut = amountComponentOut.mul(ether(1)).div(unit);
    if (potentialSetTokenOut.lt(expectedOutput)) {
      expectedOutput = potentialSetTokenOut;
    }
  }
  return expectedOutput;
};

export const getIssueSetForExactToken = async (
  setToken: SetToken,
  inputToken: string,
  inputAmount: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  // get eth amount that can be aquired with inputToken
  const ethInput =
    inputToken !== weth
      ? (await uniswapRouter.getAmountsOut(inputAmount, [inputToken, weth]))[1]
      : inputAmount;
  return await getIssueSetForExactETH(
    setToken,
    ethInput,
    uniswapRouter,
    uniswapFactory,
    sushiswapRouter,
    sushiswapFactory,
    weth,
  );
};

export const getIssueExactSetFromETH = async (
  setToken: SetToken,
  amountSet: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  const components = await setToken.getComponents();
  let sumEth = BigNumber.from(0);
  for (let i = 0; i < components.length; i++) {
    const componentAmount = amountSet
      .mul(await setToken.getDefaultPositionRealUnit(components[i]))
      .div(ether(1));
    const ethAmount = await getInputAmountBestPrice(
      components[i],
      componentAmount,
      uniswapRouter,
      uniswapFactory,
      sushiswapRouter,
      sushiswapFactory,
      weth,
    );
    sumEth = sumEth.add(ethAmount);
  }
  return sumEth;
};

export const getIssueExactSetFromToken = async (
  setToken: SetToken,
  inputToken: StandardTokenMock | WETH9,
  amountSet: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  const ethCost = await getIssueExactSetFromETH(
    setToken,
    amountSet,
    uniswapRouter,
    uniswapFactory,
    sushiswapRouter,
    sushiswapFactory,
    weth,
  );
  if (inputToken.address === weth) return ethCost;

  const hasUniPair = await hasPair(uniswapFactory, weth, inputToken.address);
  const uniAmount = hasUniPair
    ? (await uniswapRouter.getAmountsIn(ethCost, [inputToken.address, weth]))[0]
    : MAX_UINT_256;
  const hasSushiPair = await hasPair(sushiswapFactory, weth, inputToken.address);
  const sushiAmount = hasSushiPair
    ? (await sushiswapRouter.getAmountsIn(ethCost, [inputToken.address, weth]))[0]
    : MAX_UINT_256;
  const tokenCost = uniAmount.lt(sushiAmount) ? uniAmount : sushiAmount;
  return tokenCost;
};

export const getIssueExactSetFromTokenRefund = async (
  setToken: SetToken,
  inputToken: StandardTokenMock | WETH9,
  inputAmount: BigNumber,
  amountSet: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  const ethCost = await getIssueExactSetFromETH(
    setToken,
    amountSet,
    uniswapRouter,
    uniswapFactory,
    sushiswapRouter,
    sushiswapFactory,
    weth,
  );
  const inputEthValue =
    inputToken.address == weth
      ? inputAmount
      : (await uniswapRouter.getAmountsOut(inputAmount, [inputToken.address, weth]))[1];
  const refundAmount = inputEthValue.sub(ethCost);

  return refundAmount;
};

export const getRedeemExactSetForETH = async (
  setToken: SetToken,
  amountSet: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  const components = await setToken.getComponents();
  let sumEth = BigNumber.from(0);
  for (let i = 0; i < components.length; i++) {
    const componentAmount = amountSet
      .mul(await setToken.getDefaultPositionRealUnit(components[i]))
      .div(ether(1));
    let ethAmount = BigNumber.from(0);

    if (components[i] !== weth) {
      const hasUniPair = await hasPair(uniswapFactory, weth, components[i]);
      const uniAmount = hasUniPair
        ? (await uniswapRouter.getAmountsOut(componentAmount, [components[i], weth]))[1]
        : BigNumber.from(0);
      const hasSushiPair = await hasPair(sushiswapFactory, weth, components[i]);
      const sushiAmount = hasSushiPair
        ? (await sushiswapRouter.getAmountsOut(componentAmount, [components[i], weth]))[1]
        : BigNumber.from(0);
      ethAmount = sushiAmount.gt(uniAmount) ? sushiAmount : uniAmount;
    } else {
      ethAmount = componentAmount;
    }
    sumEth = sumEth.add(ethAmount);
  }
  return sumEth;
};

export const getRedeemExactSetForToken = async (
  setToken: SetToken,
  outputToken: StandardTokenMock | WETH9,
  amountSet: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  const ethOut = await getRedeemExactSetForETH(
    setToken,
    amountSet,
    uniswapRouter,
    uniswapFactory,
    sushiswapRouter,
    sushiswapFactory,
    weth,
  );
  if (outputToken.address === weth) return ethOut;

  const tokenOut = (await uniswapRouter.getAmountsOut(ethOut, [weth, outputToken.address]))[1];
  return tokenOut;
};

const hasPair = async (factory: UniswapV2Factory, tokenA: string, tokenB: string) => {
  return (await factory.getPair(tokenA, tokenB)) != ADDRESS_ZERO;
};

const getInputAmountBestPrice = async (
  token: string,
  amountIn: BigNumber,
  uniswapRouter: UniswapV2Router02,
  uniswapFactory: UniswapV2Factory,
  sushiswapRouter: UniswapV2Router02,
  sushiswapFactory: UniswapV2Factory,
  weth: string,
) => {
  if (token !== weth) {
    const hasUniPair = (await uniswapFactory.getPair(weth, token)) != ADDRESS_ZERO;
    const uniAmount = hasUniPair
      ? (await uniswapRouter.getAmountsIn(amountIn, [weth, token]))[0]
      : MAX_UINT_256;
    const hasSushiPair = (await sushiswapFactory.getPair(weth, token)) != ADDRESS_ZERO;
    const sushiAmount = hasSushiPair
      ? (await sushiswapRouter.getAmountsIn(amountIn, [weth, token]))[0]
      : MAX_UINT_256;
    if (sushiAmount.lt(uniAmount)) {
      return sushiAmount;
    } else {
      return uniAmount;
    }
  } else {
    return amountIn;
  }
};

export const getUsdcAmountInForExactSet = async (
  usdc: StandardTokenMock,
  setToken: SetToken,
  amountOut: BigNumber,
  slippageIssuanceModule: SlippageIssuanceModule,
  uniV3Quoter: IQuoter,
  spotToUsdcRoute: string,
) => {
  let totalUsdcAmountIn = BigNumber.from("0");

  const [
    slippageIssuanceComponents,
    slippageIssuanceUnits,
  ] = await slippageIssuanceModule.callStatic.getRequiredComponentIssuanceUnitsOffChain(
    setToken.address,
    amountOut,
  );

  for (let i = 0; i < slippageIssuanceComponents.length; i++) {
    if (slippageIssuanceComponents[i] === usdc.address) {
      totalUsdcAmountIn = totalUsdcAmountIn.add(slippageIssuanceUnits[i]);
    } else {
      totalUsdcAmountIn = totalUsdcAmountIn.add(
        await uniV3Quoter.callStatic.quoteExactOutput(
          spotToUsdcRoute,
          slippageIssuanceUnits[i].add(1), // add 1 wei
        ),
      );
    }
  }

  return totalUsdcAmountIn;
};

export const getUsdcAmountOutForExactSet = async (
  usdc: StandardTokenMock,
  setToken: SetToken,
  amountIn: BigNumber,
  slippageIssuanceModule: SlippageIssuanceModule,
  uniV3Quoter: IQuoter,
  spotToUsdcRoute: string,
) => {
  let totalUsdcAmountOut = BigNumber.from("0");

  const [
    slippageIssuanceComponents,
    slippageIssuanceUnits,
  ] = await slippageIssuanceModule.callStatic.getRequiredComponentRedemptionUnitsOffChain(
    setToken.address,
    amountIn,
  );

  for (let i = 0; i < slippageIssuanceComponents.length; i++) {
    if (slippageIssuanceComponents[i] === usdc.address) {
      totalUsdcAmountOut = totalUsdcAmountOut.add(slippageIssuanceUnits[i]);
    } else {
      totalUsdcAmountOut = totalUsdcAmountOut.add(
        await uniV3Quoter.callStatic.quoteExactInput(
          spotToUsdcRoute,
          slippageIssuanceUnits[i].sub(1), // leave 1 wei
        ),
      );
    }
  }

  return totalUsdcAmountOut;
};

export const encodePath = (path: Address[], fees: number[]) => {
  const FEE_SIZE = 6;
  if (path.length !== fees.length + 1) {
    throw new Error("path/fee lengths do not match");
  }

  let encoded = "0x";
  for (let i = 0; i < fees.length; i++) {
    encoded += path[i].slice(2);
    const fee = ethers.utils
      .hexlify(fees[i])
      .slice(2)
      .toString();
    encoded += fee.padStart(FEE_SIZE, "0");
  }
  encoded += path[path.length - 1].slice(2);
  return encoded.toLowerCase();
};

export const expectCloseTo = (a: BigNumber, b: BigNumber, delta: BigNumberish) => {
  expect(a).to.gte(b.sub(delta));
  expect(a).to.lte(b.add(delta));
};
