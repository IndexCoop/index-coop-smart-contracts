import { BigNumber } from "ethers";

import {
  ChainId,
  TokenAmount,
  Pair,
  Trade,
  Token,
  Fetcher,
} from "@uniswap/sdk";

import { ExchangeQuote, exchanges, Address } from "../../types";
import { ether, preciseDiv, preciseMul } from "../../../utils/common";
import { ZERO } from "../../../utils/constants";

import DEPENDENCY from "../../dependencies";

const TEN_BPS_IN_PERCENT = ether(.1);
const THIRTY_BPS_IN_PERCENT = ether(.3);

const {
  ETH_ADDRESS,
  BTC_ADDRESS,
  USDC_ADDRESS,
} = DEPENDENCY;

export async function getUniswapV2Quote(tokenAddress: Address, targetPriceImpact: BigNumber): Promise<ExchangeQuote> {
  const token: Token = await Fetcher.fetchTokenData(ChainId.MAINNET, tokenAddress);
  const weth: Token = await Fetcher.fetchTokenData(ChainId.MAINNET, ETH_ADDRESS);
  const wbtc: Token = await Fetcher.fetchTokenData(ChainId.MAINNET, BTC_ADDRESS);
  const usdc: Token = await Fetcher.fetchTokenData(ChainId.MAINNET, USDC_ADDRESS);

  const trades = Trade.bestTradeExactIn(
    await getUniswapV2Pairs([token, weth, wbtc, usdc]),
    new TokenAmount(weth, ether(1).toString()),
    token,
    {maxNumResults: 3, maxHops: 2},
  );

  if (trades.length != 0) {
    // Use linear approximation of price impact to find out how many 1 ETH trades add to 50 bps price impact (net of fees)
    const hops = trades[0].route.pairs.length;
    const priceImpactRatio = preciseDiv(
      hops > 1 ? targetPriceImpact.sub(TEN_BPS_IN_PERCENT) : targetPriceImpact,   // Subtract 10 bps from targetPriceImpact if extra hop used
      ether(parseFloat(trades[0].priceImpact.toSignificant(18))).sub(THIRTY_BPS_IN_PERCENT.mul(trades[0].route.pairs.length))
    );
    return {
      exchange: exchanges.UNISWAP,
      size: preciseMul(ether(parseFloat(trades[0].outputAmount.toExact())), priceImpactRatio).toString(),
      data: hops > 1 ? trades[0].route.path[1].address : "0x",
    } as ExchangeQuote;
  }

  return {
    exchange: exchanges.UNISWAP,
    size: ZERO.toString(),
    data: "0x",
  } as ExchangeQuote;
}

async function getUniswapV2Pairs(tokens: Token[]): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    for (let j = 1; j < tokens.length - i - 1; j++) {
      const tokenOne = tokens[i];
      const tokenTwo = tokens[i + j];

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