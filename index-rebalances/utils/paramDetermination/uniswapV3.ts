import { BigNumber } from "ethers";
import { Address } from "hardhat-deploy/dist/types";
import { hexlify, hexZeroPad } from "ethers/lib/utils";

import {
  FeeAmount,
} from "@uniswap/v3-sdk";

import { ExchangeQuote, exchanges } from "../../types";
import { ether, preciseDiv, preciseMul, sqrt } from "../../../utils/common";
import { ADDRESS_ZERO, ZERO } from "../../../utils/constants";
import DEPENDENCY from "../../dependencies";

import DeployHelper from "../../../utils/deploys";

const {
  ETH_ADDRESS,
} = DEPENDENCY;

const UNI_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

export async function getUniswapV3Quote(deployHelper: DeployHelper, token: Address, targetPriceImpact: BigNumber): Promise<ExchangeQuote> {
  const factoryInstance = await deployHelper.external.getUniswapV3FactoryInstance(UNI_V3_FACTORY);
  const poolAddress = await factoryInstance.getPool(token, ETH_ADDRESS, FeeAmount.MEDIUM);
  if (poolAddress == ADDRESS_ZERO) {
    return {
      exchange: exchanges.UNISWAP_V3,
      size: ZERO.toString(),
      data: "0x",
    } as ExchangeQuote;
  }

  const poolInstance = await deployHelper.external.getUniswapV3PoolInstance(poolAddress);
  const globalStorage = await poolInstance.slot0();
  const currentSqrtPrice = globalStorage.sqrtPriceX96;

  const currentPrice = preciseDiv(BigNumber.from(2).pow(192), currentSqrtPrice.pow(2));

  if (currentPrice.eq(0)) {
    return {
      exchange: exchanges.UNISWAP_V3,
      size: ZERO.toString(),
      data: "0x",
    } as ExchangeQuote;
  }

  // This is not actually target price where targetPrice = price*(1+targetPriceImpact). It instead sets a maximum price change after trade
  // of 2 * targetPriceImpact. If you assume that the liquidity is flat accross the 2 * targetPriceImpact, then it will equal to targetPriceImpact
  // slippage. The worst-case scenario outcome for this approximation is when you move across ticks and the liquidity falls off significantly,
  // and you execute the trade a price impact of 2% instead of 1%.

  // Divide by 50: convert basis point in percent to basis points in decimal (/100) multiply by two to meet target price impact
  const targetPrice = token > ETH_ADDRESS ? preciseMul(currentPrice, ether(1).add(targetPriceImpact.div(50))) :
    preciseMul(currentPrice, ether(1).sub(targetPriceImpact.div(50)));
  const sqrtPriceLimit = sqrt(preciseDiv(BigNumber.from(2).pow(192), targetPrice));

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
  } as ExchangeQuote;
}