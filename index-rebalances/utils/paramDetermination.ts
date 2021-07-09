import { ChainId, TokenAmount, Pair, Trade, Token, Fetcher } from "@uniswap/sdk";
import { BigNumber } from 'ethers';
import { ether } from "../../utils/index"

import DeployHelper from "@utils/deploys";

const BADGER_ADDRESS = "0x3472A5A71965499acd81997a54BBA8D852C6E53d";
const ETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

export async function getUniswapV2Quote(deployHelper: DeployHelper): Promise<BigNumber> {
  const badger: Token = await Fetcher.fetchTokenData(ChainId.MAINNET, BADGER_ADDRESS);
  const weth: Token = await Fetcher.fetchTokenData(ChainId.MAINNET, ETH_ADDRESS);
  const pair: Pair = await Fetcher.fetchPairData(badger, weth); 
  const trades = Trade.bestTradeExactIn([pair], new TokenAmount(weth, ether(1).toString()), badger)
  console.log(trades);
  return BigNumber.from(trades[0].outputAmount);
}