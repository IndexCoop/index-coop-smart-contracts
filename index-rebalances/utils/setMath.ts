import { BigNumber } from "ethers";

import { PRECISE_UNIT, ZERO } from "../../utils/constants";

import { StrategyObject } from "../types";

export function calculateSetValue(
  strategyConstants: StrategyObject
): BigNumber {
  return Object.entries(strategyConstants).map(([, obj]) => {
    return obj.currentUnit.mul(obj.price).div(obj.decimals);
  }).reduce((a, b) => a.add(b), ZERO);
}

export function calculateNotionalInToken(
  currentUnit: BigNumber,
  newUnit: BigNumber,
  totalSupply: BigNumber
): BigNumber {
  return newUnit.sub(currentUnit).mul(totalSupply).div(PRECISE_UNIT);
}

export function calculateNotionalInUSD(
  notionalInToken: BigNumber,
  tokenDecimal: BigNumber,
  tokenPrice: BigNumber
): BigNumber {
  return notionalInToken.mul(tokenPrice).div(tokenDecimal).div(PRECISE_UNIT);
}