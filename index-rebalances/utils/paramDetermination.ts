import {
  ChainId as uniChainId,
  TokenAmount as uniTokenAmount,
  Pair as uniPair,
  Trade as uniTrade,
  Token as uniToken,
  Fetcher,
} from "@uniswap/sdk";
import {
  ChainId as sushiChainId,
  CurrencyAmount,
  Pair as sushiPair,
  Trade as sushiTrade,
  Token as sushiToken,
} from "@sushiswap/sdk";

import {
  FeeAmount,
} from "@uniswap/v3-sdk";

import {
  Fetcher as kyberFetcher,
  Pair as kyberPair,
  Token as kyberToken,
  TokenAmount as kyberTokenAmount,
  Trade as kyberTrade,
} from "@dynamic-amm/sdk"

import {
  SOR,
} from "@balancer-labs/sor";

import { BigNumber } from 'ethers';
import { BigNumber as BigNumberJS } from "bignumber.js";
import { hexlify, hexZeroPad } from "ethers/lib/utils";
import { ether, preciseDiv, preciseMul, sqrt, gWei } from "../../utils/common";
import { Address } from "hardhat-deploy/dist/types";
import DeployHelper from "../../utils/deploys";
import { ADDRESS_ZERO, ZERO } from "../../utils/constants";
import { ExchangeQuote, exchanges } from "../types";
import { BaseProvider } from "@ethersproject/providers";

const ETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const BTC_ADDRESS = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const SUSHI_FACTORY = "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac";
const UNI_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const KYBER_FACTORY = "0x833e4083B7ae46CeA85695c4f7ed25CDAd8886dE";

const THIRTY_BPS_IN_PERCENT = ether(.3);
const FOURTY_BPS_IN_PERCENT = ether(.4);
const FIFTY_BPS_IN_PERCENT = ether(.5);

// UNISWAP_V2

export async function getUniswapV2Quote(tokenAddress: Address): Promise<ExchangeQuote> {
  const token: uniToken = await Fetcher.fetchTokenData(uniChainId.MAINNET, tokenAddress);
  const weth: uniToken = await Fetcher.fetchTokenData(uniChainId.MAINNET, ETH_ADDRESS);
  const wbtc: uniToken = await Fetcher.fetchTokenData(uniChainId.MAINNET, BTC_ADDRESS);
  const usdc: uniToken = await Fetcher.fetchTokenData(uniChainId.MAINNET, USDC_ADDRESS);

  const trades = uniTrade.bestTradeExactIn(
    await getUniswapV2Pairs([token, weth, wbtc, usdc]),
    new uniTokenAmount(weth, ether(1).toString()),
    token,
    {maxNumResults: 3, maxHops: 2},
  );

  if (trades.length != 0) {
    // Use linear approximation of price impact to find out how many 1 ETH trades add to 50 bps price impact (net of fees)
    const hops = trades[0].route.pairs.length;
    const priceImpactRatio = preciseDiv(
      hops > 1 ? FOURTY_BPS_IN_PERCENT : FIFTY_BPS_IN_PERCENT,
      ether(parseFloat(trades[0].priceImpact.toSignificant(18))).sub(THIRTY_BPS_IN_PERCENT.mul(trades[0].route.pairs.length))
    );
    return {
      exchange: exchanges.UNISWAP,
      size: preciseMul(ether(parseFloat(trades[0].outputAmount.toExact())), priceImpactRatio).toString(),
      data: hops > 1 ? trades[0].route.path[1].address : "0x",
    } as ExchangeQuote
  }

  return {
    exchange: exchanges.UNISWAP,
    size: ZERO.toString(),
    data: "0x"
  } as ExchangeQuote
}

async function getUniswapV2Pairs(tokens: uniToken[]): Promise<uniPair[]> {
  let pairs: uniPair[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    for (let j = 1; j <tokens.length - i - 1; j++) {
      const tokenOne = tokens[i];
      const tokenTwo = tokens[i+j];

      let pair;
      try {
        pair = await Fetcher.fetchPairData(tokenOne, tokenTwo);
      } catch (error) {
        continue;
      }

      pairs.push(pair);
    }
  }
  
  return pairs;
}

// SUSHISWAP

export async function getSushiswapQuote(deployHelper: DeployHelper, tokenAddress: Address): Promise<ExchangeQuote> {
  const token: sushiToken = await fetchSushiTokenData(deployHelper, uniChainId.MAINNET, tokenAddress);
  const weth: sushiToken = await fetchSushiTokenData(deployHelper, uniChainId.MAINNET, ETH_ADDRESS);
  const wbtc: sushiToken = await fetchSushiTokenData(deployHelper, uniChainId.MAINNET, BTC_ADDRESS);
  const usdc: sushiToken = await fetchSushiTokenData(deployHelper, uniChainId.MAINNET, USDC_ADDRESS);

  const trades = sushiTrade.bestTradeExactIn(
    await getSushiswapPairs(deployHelper, [token, weth, wbtc, usdc]),
    CurrencyAmount.fromRawAmount(weth, ether(1).toString()),
    token,
    {maxNumResults: 3, maxHops: 2},
  );
  
  if (trades.length != 0) {
    // Use linear approximation of price impact to find out how many 1 ETH trades add to 50 bps price impact (net of fees)
    const hops = trades[0].route.pairs.length;
    const priceImpactRatio = preciseDiv(
      hops > 1 ? FOURTY_BPS_IN_PERCENT : FIFTY_BPS_IN_PERCENT,
      ether(parseFloat(trades[0].priceImpact.toSignificant(18))).sub(THIRTY_BPS_IN_PERCENT.mul(trades[0].route.pairs.length))
    );
    return {
      exchange: exchanges.SUSHISWAP,
      size: preciseMul(ether(parseFloat(trades[0].outputAmount.toExact())), priceImpactRatio).toString(),
      data: hops > 1 ? trades[0].route.path[1].address : "0x",
    } as ExchangeQuote;
  }

  return {
    exchange: exchanges.SUSHISWAP,
    size: ZERO.toString(),
    data: "0x"
  } as ExchangeQuote;
}

async function fetchSushiTokenData(
  deployHelper: DeployHelper,
  chainId: sushiChainId,
  token: Address
): Promise<sushiToken> {
  const tokenInstance = await deployHelper.setV2.getTokenMock(token);
  return new sushiToken(chainId, token, await tokenInstance.decimals());
}

async function getSushiswapPairs(deployHelper: DeployHelper, tokens: sushiToken[]): Promise<sushiPair[]> {
  let pairs: sushiPair[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    for (let j = 1; j <tokens.length - i - 1; j++) {
      const tokenOne = tokens[i];
      const tokenTwo = tokens[i+j];

      let pair;
      try {
        pair = await fetchSushiPairData(deployHelper, tokenOne, tokenTwo);
      } catch (error) {
        continue;
      }

      pairs.push(pair);
    }
  }

  return pairs;
}

async function fetchSushiPairData(
  deployHelper: DeployHelper,
  tokenOne: sushiToken,
  tokenTwo: sushiToken
): Promise<sushiPair> {
  const factoryInstance = await deployHelper.external.getUniswapV2FactoryInstance(SUSHI_FACTORY);
  const pairInstance = await deployHelper.external.getUniswapV2PairInstance(
    await factoryInstance.getPair(tokenOne.address, tokenTwo.address)
  );

  if (pairInstance.address == ADDRESS_ZERO) {
    throw new Error("Invalid Pair");
  }

  const reserves = await pairInstance.getReserves();
  const token0 = await pairInstance.token0();

  const [ tokenOneReserve, tokenTwoReserve ] = token0 == tokenOne.address ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];
  return new sushiPair(
    CurrencyAmount.fromRawAmount(tokenOne, tokenOneReserve.toString()),
    CurrencyAmount.fromRawAmount(tokenTwo, tokenTwoReserve.toString())
  );
}

// UNISWAP_V3

export async function getUniswapV3Quote(deployHelper: DeployHelper, token: Address): Promise<ExchangeQuote> {
  const factoryInstance = await deployHelper.external.getUniswapV3FactoryInstance(UNI_V3_FACTORY);
  const poolAddress = await factoryInstance.getPool(token, ETH_ADDRESS, FeeAmount.MEDIUM);
  if (poolAddress == ADDRESS_ZERO) { 
    return {
      exchange: exchanges.UNISWAP_V3,
      size: ZERO.toString(),
      data: "0x"
    } as ExchangeQuote;
  }

  const poolInstance = await deployHelper.external.getUniswapV3PoolInstance(poolAddress);
  const globalStorage = await poolInstance.slot0();
  const currentSqrtPrice = globalStorage.sqrtPriceX96;

  const token0 = await poolInstance.token0();
  const decimals = token0 == token ? 
    [await (await deployHelper.setV2.getTokenMock(token)).decimals(), await (await deployHelper.setV2.getTokenMock(ETH_ADDRESS)).decimals()] :
    [await (await deployHelper.setV2.getTokenMock(ETH_ADDRESS)).decimals(), await (await deployHelper.setV2.getTokenMock(token)).decimals()];
  const currentPrice = preciseDiv(BigNumber.from(2).pow(192), currentSqrtPrice.pow(2)).mul(10**(decimals[1]-decimals[0]));

  // This is not actually one percent price impact. It instead sets a maximum price change after trade of 2%.
  // If you assume that the liquidity is flat accross the 2%, then it will equal to 1% slippage. The worst-case
  // scenario outcome for this approximation is when you move across ticks and the liquidity falls off significantly,
  // and you execute the trade a price impact of 2% instead of 1%.
  const onePercentImpactPrice = preciseMul(currentPrice, ether(1).sub(FOURTY_BPS_IN_PERCENT.div(50)));
  const sqrtPriceLimit = sqrt(preciseDiv(BigNumber.from(2).pow(192), onePercentImpactPrice));
  // TO DO: DECIMAL ADJUSTMENTS
  const quoterInstance = await deployHelper.external.getUniswapV3QuoterInstance(UNI_V3_QUOTER);
  return {
    exchange: exchanges.UNISWAP_V3,
    size:   (await quoterInstance.callStatic.quoteExactInputSingle(
      ETH_ADDRESS,
      token,
      FeeAmount.MEDIUM,
      ether(10000),
      sqrtPriceLimit
    )).toString(),
    data: hexZeroPad(hexlify(FeeAmount.MEDIUM), 3),
  } as ExchangeQuote
}

// KYBER DMM
export async function getKyberDMMQuote(tokenAddress: Address): Promise<ExchangeQuote> {
  const token: kyberToken = await kyberFetcher.fetchTokenData(uniChainId.MAINNET, tokenAddress);
  const weth: kyberToken = await kyberFetcher.fetchTokenData(uniChainId.MAINNET, ETH_ADDRESS);
  const wbtc: kyberToken = await kyberFetcher.fetchTokenData(uniChainId.MAINNET, BTC_ADDRESS);
  const usdc: kyberToken = await kyberFetcher.fetchTokenData(uniChainId.MAINNET, USDC_ADDRESS);

  const trades = await kyberTrade.bestTradeExactIn(
    await getKyberDMMPairs([token, weth, wbtc, usdc]),
    new kyberTokenAmount(weth, ether(1).toString()),
    token,
    {maxNumResults: 3, maxHops: 1},
  );

  if (trades.length != 0) {
    // Use linear approximation of price impact to find out how many 1 ETH trades add to 50 bps price impact (net of fees)
    const fee: BigNumber = BigNumber.from(trades[0].route.pairs[0].fee.toString());
    const priceImpactRatio = preciseDiv(
      FIFTY_BPS_IN_PERCENT,
      ether(parseFloat(trades[0].priceImpact.toSignificant(18)) - fee.toNumber() / 10 ** 16)  // Price impact measured in percent so fee must be as well
    );

    return {
      exchange: exchanges.KYBER,
      size: preciseMul(ether(parseFloat(trades[0].outputAmount.toExact())), priceImpactRatio).toString(),
      data: trades[0].route.pairs[0].address,
    } as ExchangeQuote;
  }

  return {
    exchange: exchanges.KYBER,
    size: ZERO.toString(),
    data: "0x"
  } as ExchangeQuote;
}

async function getKyberDMMPairs(tokens: kyberToken[]): Promise<kyberPair[][]> {
  let pairs: kyberPair[][] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    for (let j = 1; j <tokens.length - i - 1; j++) {
      const tokenOne = tokens[i];
      const tokenTwo = tokens[i+j];

      let assetPairs;
      try {
        assetPairs = await kyberFetcher.fetchPairData(tokenOne, tokenTwo, KYBER_FACTORY);
      } catch (error) {
        continue;
      }
      if (assetPairs.length > 0) { pairs.push(assetPairs); }
    }
  }

  return pairs;
}

// BALANCER
export async function getBalancerV1Quote(provider: BaseProvider, tokenAddress: Address): Promise<ExchangeQuote> {
  const sor = new SOR(
    provider,
    toBigNumberJS(gWei(100)),
    3,      // Max 3 pools used
    1,      // ChainId = mainnet (1)
    "https://storageapi.fleek.co/balancer-bucket/balancer-exchange/pools"
  );
  await sor.fetchFilteredPairPools(ETH_ADDRESS, tokenAddress);
  await sor.setCostOutputToken(tokenAddress);   // Set cost to limit small trades

  const inputAmount = toBigNumberJS(ether(1));
  const [
    ,
    returnAmountV1,
    marketSpV1Scaled
  ] = await sor.getSwaps(
    ETH_ADDRESS.toLowerCase(),
    tokenAddress.toLowerCase(),
    'swapExactIn',
    inputAmount
  );
  
  if (!returnAmountV1.eq(0)) {
    const effectivePrice = inputAmount.div(returnAmountV1);

    const priceImpact = ether(effectivePrice.div(marketSpV1Scaled.div(10 ** 18)).toNumber()).sub(ether(1));
    const priceImpactRatio = FIFTY_BPS_IN_PERCENT.div(priceImpact.mul(100));
  
    return {
      exchange: exchanges.BALANCER,
      size: fromBigNumberJS(returnAmountV1).mul(priceImpactRatio).toString(),
      data: "0x"
    } as ExchangeQuote;
  }

  return {
    exchange: exchanges.KYBER,
    size: ZERO.toString(),
    data: "0x"
  } as ExchangeQuote;
}

// GENERAL
export function getBestQuote(quotes: ExchangeQuote[]): ExchangeQuote {
  return quotes.reduce((p, c) => BigNumber.from(p.size).gt(BigNumber.from(c.size)) ? p : c);
}

function toBigNumberJS(value: BigNumber): BigNumberJS {
  return new BigNumberJS(value.toString());
}

function fromBigNumberJS(value: BigNumberJS): BigNumber {
  return BigNumber.from(value.toString());
}