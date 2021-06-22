import { BigNumber } from 'ethers';

import { ZERO } from "../../utils/constants";
import { ASSETS } from "../assetInfo";

import { RebalanceSummary, StrategyObject } from "../types";
import { ether } from '../../utils/common/index';

export function createRebalanceSchedule(
  rebalanceData: RebalanceSummary[],
  strategyInfo: StrategyObject
): string {
  let tradeOrder: string = "";

  let ethBalance: BigNumber = ZERO;
  let buyAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.gte(ZERO));
  let sellAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.lt(ZERO));

  const totalRounds: BigNumber = Object.entries(rebalanceData).map(([, obj]) => obj.tradeCount).reduce((a, b) => { return  a.gt(b) ? a : b; }, ZERO);
  for (let i = 0; i < totalRounds.toNumber(); i++) {
    [sellAssets, ethBalance, tradeOrder] = doSellTrades(sellAssets, strategyInfo, tradeOrder, ethBalance);
    console.log(ethBalance.toString());
    [buyAssets, ethBalance, tradeOrder] = doBuyTrades(buyAssets, strategyInfo, tradeOrder, ethBalance);
    console.log(ethBalance.toString());
  }
  return cleanupTrades(buyAssets, tradeOrder);
}

function doSellTrades(
  sellAssets: RebalanceSummary[],
  strategyInfo: StrategyObject,
  tradeOrder: string,
  ethBalance: BigNumber,
): [RebalanceSummary[], BigNumber, string] {
  let newEthBalance = ethBalance;
  let newTradeOrder = tradeOrder;
  for (let i = 0; i < sellAssets.length; i++) {
    if (sellAssets[i].tradeCount.gt(0)) {
      const asset = sellAssets[i].asset;
      const tradeSize = strategyInfo[asset].maxTradeSize.gt(sellAssets[i].notionalInToken.mul(-1)) ? sellAssets[i].notionalInToken.mul(-1) : strategyInfo[asset].maxTradeSize;
      const decimals = strategyInfo[asset].decimals;

      sellAssets[i].notionalInToken = sellAssets[i].notionalInToken.add(tradeSize);
      sellAssets[i].tradeCount = sellAssets[i].tradeCount.sub(1);
      newEthBalance = newEthBalance.add(
        tradeSize.mul(ASSETS[asset].price).mul(ether(1).div(decimals)).div(ASSETS['WETH'].price)
      );
      newTradeOrder = newTradeOrder.concat(asset.concat(","));
    }
    sellAssets[i].isBuy = false;
  }
  return [sellAssets, newEthBalance, newTradeOrder];
}

function doBuyTrades(
  buyAssets: RebalanceSummary[],
  strategyInfo: StrategyObject,
  tradeOrder: string,
  ethBalance: BigNumber,
): [RebalanceSummary[], BigNumber, string] {
  let newEthBalance = ethBalance;
  let newTradeOrder = tradeOrder;
  for (let i = 0; i < buyAssets.length; i++) {
    const asset = buyAssets[i].asset;
    const tradeSize = strategyInfo[asset].maxTradeSize.gt(buyAssets[i].notionalInToken) ? buyAssets[i].notionalInToken : strategyInfo[asset].maxTradeSize;
    const decimals = strategyInfo[asset].decimals;
    const tradeSizeInEth = tradeSize
      .mul(ASSETS[asset].price)
      .mul(ether(1).div(decimals))
      .div(ASSETS['WETH'].price);

    if (buyAssets[i].tradeCount.gt(0) && tradeSizeInEth.lte(newEthBalance)) {
      buyAssets[i].notionalInToken = buyAssets[i].notionalInToken.sub(tradeSize);
      buyAssets[i].tradeCount = buyAssets[i].tradeCount.sub(1);
      newEthBalance = newEthBalance.sub(tradeSizeInEth);
      newTradeOrder = newTradeOrder.concat(asset.concat(","));
    }
    buyAssets[i].isBuy = true;
  }
  return [buyAssets, newEthBalance, newTradeOrder];
}

function cleanupTrades(buyAssets: RebalanceSummary[], tradeOrder: string): string {
  let newTradeOrder = tradeOrder;
  for (let i = 0; i < buyAssets.length; i++) {
    if (buyAssets[i].tradeCount.gt(0)) {
      newTradeOrder = newTradeOrder.concat(buyAssets[i].asset.concat(","));
    }
  }

  return newTradeOrder;
}