import { BigNumber } from "ethers";

import { UniswapV2Pair, UniswapV2Router02 } from "../contracts/uniswap";
import { StandardTokenMock } from "@utils/contracts/index";
import { WETH9 } from "@typechain/WETH9";
import { Address } from "../types";
import { preciseDiv, sqrt } from "../index";
import { ZERO, MAX_UINT_256 } from "../constants";

export async function setUniswapPoolToPrice(
  uniswapRouter: UniswapV2Router02,
  uniswapPool: UniswapV2Pair,
  baseAsset: StandardTokenMock | WETH9,
  quoteAsset: StandardTokenMock | WETH9,
  price: BigNumber,
  to: Address
): Promise<void> {
  const baseDecimals = BigNumber.from(10).pow((await baseAsset.decimals()));
  const quoteDecimals = BigNumber.from(10).pow((await quoteAsset.decimals()));

  const [ baseReserve, quoteReserve ] = await getUniswapReserves(uniswapPool, baseAsset.address);

  const currentK = baseReserve.mul(quoteReserve);
  const baseLeft = sqrt(preciseDiv(currentK, price.mul(quoteDecimals).div(baseDecimals)));

  if (baseLeft.gt(baseReserve)) {
    await uniswapRouter.swapExactTokensForTokens(
      baseLeft.sub(baseReserve),
      ZERO,
      [baseAsset.address, quoteAsset.address],
      to,
      MAX_UINT_256
    );
  } else {
    await uniswapRouter.swapTokensForExactTokens(
      baseReserve.sub(baseLeft),
      MAX_UINT_256,
      [quoteAsset.address, baseAsset.address],
      to,
      MAX_UINT_256
    );

  }
}

async function getUniswapReserves(
  uniswapPool: UniswapV2Pair,
  baseAsset: Address
): Promise<[BigNumber, BigNumber]> {
  const [ reserveOne, reserveTwo ] = await uniswapPool.getReserves();
  const tokenOne = await uniswapPool.token0();
  return tokenOne == baseAsset ? [reserveOne, reserveTwo] : [reserveTwo, reserveOne];
}
