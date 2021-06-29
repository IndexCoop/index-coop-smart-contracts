import * as _ from "lodash";
import * as fs from "fs";

import { Address } from "../../utils/types";
import { ZERO, PRECISE_UNIT } from "../../utils/constants";
import { ether, preciseDiv, preciseMul } from "../../utils/common/index";
import { Assets } from "../../index-rebalances/assetInfo";
import { strategyInfo } from "../../index-rebalances/indices/dpi/strategyInfo";
import { BigNumber } from 'ethers';
import {
  RebalanceReport,
  RebalanceSummary,
  StrategyObject
} from "../../index-rebalances/types";

import DEPENDENCY from "../../index-rebalances/dependencies"

const {
  DPI,
  GENERAL_INDEX_MODULE,
} = DEPENDENCY;

let tradeOrder: string = "";

async function calculateNewDPIPositions(
  currentPositions: any[],
  assets: Assets,
  dpiTotalSupply: BigNumber,
  DPIAddress: string,
) {

  const strategyConstants: StrategyObject = createStrategyObject(currentPositions, assets);

  const dpiValue = Object.entries(strategyConstants).map(([, obj]) => {
    return obj.currentUnit.mul(obj.price);
  }).reduce((a, b) => a.add(b), ZERO).div(PRECISE_UNIT);

  const divisor = Object.entries(strategyConstants).map(([, obj]) => {
    return obj.supply.mul(obj.price);
  }).reduce((a, b) => a.add(b), ZERO).div(dpiValue);

  let rebalanceData: RebalanceSummary[] = await calculateNewAllocations(
    strategyConstants,
    dpiValue,
    divisor,
    dpiTotalSupply,
  );
}

async function calculateNewAllocations(
  strategyConstants: StrategyObject,
  dpiValue: BigNumber,
  divisor: BigNumber,
  dpiTotalSupply: BigNumber
): Promise<RebalanceSummary[]> {
  let rebalanceData: RebalanceSummary[] = [];

  let sumOfCappedAllocations = ZERO;
  let cappedAssets: string[] = [];

  for (let i = 0; i < Object.keys(strategyConstants).length; i++) {
    const key = Object.keys(strategyConstants)[i];
    const assetObj = strategyConstants[key];

    let newUnit = assetObj.supply.mul(PRECISE_UNIT).div(divisor);

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
    const notionalInToken = finalNewUnit.sub(currentUnit).mul(totalSupply).div(PRECISE_UNIT);

    rebalanceData[i].newUnit = finalNewUnit;
    rebalanceData[i].currentUnit = currentUnit;
    rebalanceData[i].notionalInToken = notionalInToken;
    rebalanceData[i].notionalInUSD = notionalInToken.mul(assetObj.price).div(PRECISE_UNIT).div(PRECISE_UNIT);
    rebalanceData[i].tradeCount = notionalInToken.div(assetObj.maxTradeSize).abs().add(1);
  }
  return rebalanceData;
}

function createStrategyObject(
  currentPositions: any[],
  _assets?: Assets
): any {
  if (_assets === undefined ) _assets = assets;

  const filteredConstants = _.pick(_.merge(_assets, strategyInfo), Object.keys(strategyInfo));
  const keys = Object.keys(filteredConstants);
  for (let i = 0; i < keys.length; i++) {
    const position = currentPositions.filter(
      obj => obj.component.toLowerCase() == filteredConstants[keys[i]].address.toLowerCase()
    )[0];

    if (position) { filteredConstants[keys[i]].currentUnit = position.unit; }
  }
  return filteredConstants;
}

function createRebalanceSchedule(rebalanceData: RebalanceSummary[]) {
  let ethBalance: BigNumber = ZERO;
  let buyAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.gte(ZERO));
  let sellAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.lt(ZERO));

  const totalRounds: BigNumber = Object.entries(rebalanceData).map(([, obj]) => obj.tradeCount).reduce((a, b) => { return  a.gt(b) ? a : b; }, ZERO);
  for (let i = 0; i < totalRounds.toNumber(); i++) {
    [sellAssets, ethBalance] = doSellTrades(sellAssets, ethBalance);
    [buyAssets, ethBalance] = doBuyTrades(buyAssets, ethBalance);
  }
  cleanupTrades(buyAssets);
}

function doSellTrades(sellAssets: RebalanceSummary[], ethBalance: BigNumber): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance
  for (let i = 0; i < sellAssets.length; i++) {
    if (sellAssets[i].tradeCount.gt(0)) {
      const asset = sellAssets[i].asset;
      const tradeSize = strategyInfo[asset].maxTradeSize.gt(sellAssets[i].notionalInToken.mul(-1)) ? sellAssets[i].notionalInToken.mul(-1) : strategyInfo[asset].maxTradeSize;
      sellAssets[i].notionalInToken = sellAssets[i].notionalInToken.add(tradeSize);
      sellAssets[i].tradeCount = sellAssets[i].tradeCount.sub(1);
      newEthBalance = newEthBalance.add(tradeSize.mul(assets[asset].price).div(assets['WETH'].price));
      tradeOrder = tradeOrder.concat(asset.concat(","));
    }
    sellAssets[i].isBuy = false;
  }
  return [sellAssets, newEthBalance];
}

function doBuyTrades(buyAssets: RebalanceSummary[], ethBalance: BigNumber): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance
  for (let i = 0; i < buyAssets.length; i++) {
    const asset = buyAssets[i].asset;
    const tradeSize = strategyInfo[asset].maxTradeSize.gt(buyAssets[i].notionalInToken) ? buyAssets[i].notionalInToken : strategyInfo[asset].maxTradeSize;
    const tradeSizeInEth = tradeSize.mul(assets[asset].price).div(assets['WETH'].price);

    if (buyAssets[i].tradeCount.gt(0) && tradeSizeInEth.lte(newEthBalance)) {
      buyAssets[i].notionalInToken = buyAssets[i].notionalInToken.sub(tradeSize);
      buyAssets[i].tradeCount = buyAssets[i].tradeCount.sub(1);
      newEthBalance = newEthBalance.sub(tradeSizeInEth);
      tradeOrder = tradeOrder.concat(asset.concat(","));
    }
    buyAssets[i].isBuy = true;
  }
  return [buyAssets, newEthBalance];
}

function cleanupTrades(buyAssets: RebalanceSummary[]) {
  for (let i = 0; i < buyAssets.length; i++) {
    if (buyAssets[i].tradeCount.gt(0)) {
      tradeOrder = tradeOrder.concat(buyAssets[i].asset.concat(","));
    }
  }
}

module.exports = {};