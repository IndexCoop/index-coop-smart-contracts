import { BigNumber } from "ethers";

import {
  ChainId,
  CurrencyAmount,
  Pair,
  Token,
  Trade,
} from "@sushiswap/sdk";

import { ExchangeQuote, exchanges, Address } from "../../types";
import { ether, preciseDiv, preciseMul } from "../../../utils/common";
import { ADDRESS_ZERO, ZERO } from "../../../utils/constants";
import DEPENDENCY from "../../dependencies";

import DeployHelper from "../../../utils/deploys";

const TEN_BPS_IN_PERCENT = ether(.1);
const THIRTY_BPS_IN_PERCENT = ether(.3);

const {
  ETH_ADDRESS,
  BTC_ADDRESS,
  USDC_ADDRESS,
} = DEPENDENCY;

const SUSHI_FACTORY = "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac";

export async function getSushiswapQuote(deployHelper: DeployHelper, tokenAddress: Address, targetPriceImpact: BigNumber): Promise<ExchangeQuote> {
  const token: Token = await fetchSushiTokenData(deployHelper, ChainId.MAINNET, tokenAddress);
  const weth: Token = await fetchSushiTokenData(deployHelper, ChainId.MAINNET, ETH_ADDRESS);
  const wbtc: Token = await fetchSushiTokenData(deployHelper, ChainId.MAINNET, BTC_ADDRESS);
  const usdc: Token = await fetchSushiTokenData(deployHelper, ChainId.MAINNET, USDC_ADDRESS);

  const trades = Trade.bestTradeExactIn(
    await getSushiswapPairs(deployHelper, [token, weth, wbtc, usdc]),
    CurrencyAmount.fromRawAmount(weth, ether(1).toString()),
    token,
    {maxNumResults: 3, maxHops: 2},
  );

  if (trades.length != 0) {
    // Use linear approximation of price impact to find out how many 1 ETH trades add to 50 bps price impact (net of fees)
    const hops = trades[0].route.pairs.length;
    const priceImpactRatio = preciseDiv(
      hops > 1 ? targetPriceImpact.sub(TEN_BPS_IN_PERCENT) : targetPriceImpact,
      ether(parseFloat(trades[0].priceImpact.toSignificant(18))).sub(THIRTY_BPS_IN_PERCENT.mul(trades[0].route.pairs.length))
    );
    return {
      exchange: exchanges.SUSHISWAP,
      size: preciseMul(
        ether(parseFloat(trades[0].outputAmount.toExact())).div(ether(1).div(10 ** token.decimals)),
        priceImpactRatio).toString(),
      data: hops > 1 ? trades[0].route.path[1].address : "0x",
    } as ExchangeQuote;
  }

  return {
    exchange: exchanges.SUSHISWAP,
    size: ZERO.toString(),
    data: "0x",
  } as ExchangeQuote;
}

async function fetchSushiTokenData(
  deployHelper: DeployHelper,
  chainId: ChainId,
  token: Address
): Promise<Token> {
  const tokenInstance = await deployHelper.setV2.getTokenMock(token);
  return new Token(chainId, token, await tokenInstance.decimals());
}

async function getSushiswapPairs(deployHelper: DeployHelper, tokens: Token[]): Promise<Pair[]> {
  const pairs: Pair[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    for (let j = 1; j < tokens.length - i - 1; j++) {
      const tokenOne = tokens[i];
      const tokenTwo = tokens[i + j];

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
  tokenOne: Token,
  tokenTwo: Token
): Promise<Pair> {
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
  return new Pair(
    CurrencyAmount.fromRawAmount(tokenOne, tokenOneReserve.toString()),
    CurrencyAmount.fromRawAmount(tokenTwo, tokenTwoReserve.toString())
  );
}