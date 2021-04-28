import { BigNumber } from "ethers";

import { PRECISE_UNIT, ZERO } from "../../utils/constants";

import { StrategyObject } from "../types";

export function calculateSetValue(
  strategyConstants: StrategyObject
): BigNumber {
  return Object.entries(strategyConstants).map(([, obj]) => {
    return obj.currentUnit.mul(obj.price);
  }).reduce((a, b) => a.add(b), ZERO).div(PRECISE_UNIT);
}