import { BigNumber } from "ethers";
import { Address } from "hardhat-deploy/dist/types";

import {
  ChainId,
} from "@uniswap/sdk";

import {
  Fetcher as kyberFetcher,
  Pair as kyberPair,
  Token as kyberToken,
  TokenAmount as kyberTokenAmount,
  Trade as kyberTrade,
} from "@dynamic-amm/sdk";

import { ether, preciseDiv, preciseMul } from "../../../utils/common";
import { ZERO } from "../../../utils/constants";
import { ExchangeQuote, exchanges } from "../../types";
import DEPENDENCY from "../../dependencies";

const {
  ETH_ADDRESS,
  BTC_ADDRESS,
  USDC_ADDRESS,
} = DEPENDENCY;

const KYBER_FACTORY = "0x833e4083B7ae46CeA85695c4f7ed25CDAd8886dE";

export async function getKyberDMMQuote(
  tokenAddress: Address,
  targetPriceImpact: BigNumber
): Promise<ExchangeQuote> {
  const token: kyberToken = await kyberFetcher.fetchTokenData(ChainId.MAINNET, tokenAddress);
  const weth: kyberToken = await kyberFetcher.fetchTokenData(ChainId.MAINNET, ETH_ADDRESS);
  const wbtc: kyberToken = await kyberFetcher.fetchTokenData(ChainId.MAINNET, BTC_ADDRESS);
  const usdc: kyberToken = await kyberFetcher.fetchTokenData(ChainId.MAINNET, USDC_ADDRESS);

  const trades = await kyberTrade.bestTradeExactIn(
    await getKyberDMMPairs([token, weth, wbtc, usdc]),
    new kyberTokenAmount(weth, ether(1).toString()),
    token,
    {maxNumResults: 3, maxHops: 1},
  );

  if (trades.length != 0) {
    // Use linear approximation of price impact to find out how many 1 ETH trades add to 50 bps price
    // impact (net of fees)
    const fee: BigNumber = BigNumber.from(trades[0].route.pairs[0].fee.toString());
    const priceImpactRatio = preciseDiv(
      targetPriceImpact,
      // Price impact measured in percent so fee must be as well
      ether(parseFloat(trades[0].priceImpact.toSignificant(18)) - fee.toNumber() / 10 ** 16)
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
    data: "0x",
  } as ExchangeQuote;
}

async function getKyberDMMPairs(tokens: kyberToken[]): Promise<kyberPair[][]> {
  const pairs: kyberPair[][] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    for (let j = 1; j < tokens.length - i - 1; j++) {
      const tokenOne = tokens[i];
      const tokenTwo = tokens[i + j];

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