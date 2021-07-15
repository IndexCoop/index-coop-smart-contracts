import { BigNumber } from 'ethers';
import { BigNumber as BigNumberJS } from "bignumber.js";
import { Address } from "hardhat-deploy/dist/types";

import {
  SOR,
} from "@balancer-labs/sor";

import { ether, gWei } from "../../../utils/common";
import { ZERO } from "../../../utils/constants";
import { ExchangeQuote, exchanges } from "../../types";
import { BaseProvider } from "@ethersproject/providers";
import DEPENDENCY from "../../dependencies";

const {
  ETH_ADDRESS
} = DEPENDENCY;

export async function getBalancerV1Quote(provider: BaseProvider, tokenAddress: Address, targetPriceImpact: BigNumber): Promise<ExchangeQuote> {
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
    const priceImpactRatio = targetPriceImpact.div(priceImpact.mul(100));
  
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

function toBigNumberJS(value: BigNumber): BigNumberJS {
  return new BigNumberJS(value.toString());
}

function fromBigNumberJS(value: BigNumberJS): BigNumber {
  return BigNumber.from(value.toString());
}