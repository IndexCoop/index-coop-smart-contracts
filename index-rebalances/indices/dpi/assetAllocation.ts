import { ZERO, PRECISE_UNIT } from "../../../utils/constants";
import { ether, preciseDiv, preciseMul } from "../../../utils/common/index";
import { BigNumber } from 'ethers';

import { RebalanceSummary, StrategyObject } from "../../types";
import { SetToken } from "../../../utils/contracts/setV2";

import { calculateNotionalInToken, calculateNotionalInUSD } from "../../utils";

export async function calculateNewAllocations(
  dpi: SetToken,
  strategyConstants: StrategyObject,
  dpiValue: BigNumber,
): Promise<RebalanceSummary[]> {
  let rebalanceData: RebalanceSummary[] = [];

  let sumOfCappedAllocations = ZERO;
  let cappedAssets: string[] = [];

  const divisor = Object.entries(strategyConstants).map(([, obj]) => {
    return obj.input.mul(obj.price);
  }).reduce((a, b) => a.add(b), ZERO).div(dpiValue);

  const totalSupply = await dpi.totalSupply();
  for (let i = 0; i < Object.keys(strategyConstants).length; i++) {
    const key = Object.keys(strategyConstants)[i];
    const assetObj = strategyConstants[key];

    let newUnit = assetObj.input.mul(PRECISE_UNIT).div(divisor);

    let allocation: BigNumber = strategyConstants[key].price.mul(newUnit).div(dpiValue);
    if (allocation.gt(ether(.25))) {
      cappedAssets.push(key);
      newUnit = ether(.25).mul(dpiValue).div(strategyConstants[key].price);
      allocation = ether(.25);
    }
    sumOfCappedAllocations = sumOfCappedAllocations.add(allocation);
    rebalanceData.push({
      asset: key,
      newUnit: newUnit,
      currentUnit: ZERO,
      notionalInToken: ZERO,
      notionalInUSD: ZERO,
      tradeCount: ZERO,
      isBuy: undefined,
      exchange: assetObj.exchange,
      maxTradeSize: assetObj.maxTradeSize,
      coolOffPeriod:assetObj.coolOffPeriod,
    });
  }

  const cappedAssetAllocationSum = ether(.25).mul(cappedAssets.length);

  for (let i = 0; i < rebalanceData.length; i++) {
    const assetObj = strategyConstants[rebalanceData[i].asset];

    let finalNewUnit: BigNumber = rebalanceData[i].newUnit;
    if(!cappedAssets.includes(rebalanceData[i].asset)) {
      const allocation: BigNumber = assetObj.price.mul(rebalanceData[i].newUnit).div(dpiValue);
      const allocationSansCapped = preciseDiv(allocation, sumOfCappedAllocations.sub(cappedAssetAllocationSum));
      const additionalAllocation = preciseMul(allocationSansCapped, PRECISE_UNIT.sub(sumOfCappedAllocations));

      const finalCappedAllocation = allocation.add(additionalAllocation);
      finalNewUnit = finalCappedAllocation.mul(dpiValue).div(assetObj.price);
    }

    const currentUnit = assetObj.currentUnit;
    const notionalInToken = calculateNotionalInToken(currentUnit, finalNewUnit, totalSupply);

    rebalanceData[i].newUnit = finalNewUnit;
    rebalanceData[i].currentUnit = currentUnit;
    rebalanceData[i].notionalInToken = notionalInToken;
    rebalanceData[i].notionalInUSD = calculateNotionalInUSD(notionalInToken, assetObj.decimals, assetObj.price);
    rebalanceData[i].tradeCount = notionalInToken.div(assetObj.maxTradeSize).abs().add(1);
  }
  return rebalanceData;
}