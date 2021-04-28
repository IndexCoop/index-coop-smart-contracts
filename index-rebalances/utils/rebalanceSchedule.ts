import { BigNumber } from 'ethers';

import { ZERO } from "../../utils/constants";
import { ASSETS } from "../assetInfo";

import { RebalanceSummary, StrategyInfo } from "../types";

export function createRebalanceSchedule(
  rebalanceData: RebalanceSummary[],
  strategyInfo: StrategyInfo
): string {
  let tradeOrder: string = "";

  let ethBalance: BigNumber = ZERO;
  let buyAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.gte(ZERO));
  let sellAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.lt(ZERO));

  const totalRounds: BigNumber = Object.entries(rebalanceData).map(([, obj]) => obj.tradeCount).reduce((a, b) => { return  a.gt(b) ? a : b; }, ZERO);
  for (let i = 0; i < totalRounds.toNumber(); i++) {
    [sellAssets, ethBalance] = doSellTrades(sellAssets, strategyInfo, tradeOrder, ethBalance);
    [buyAssets, ethBalance] = doBuyTrades(buyAssets, strategyInfo, tradeOrder, ethBalance);
  }
  cleanupTrades(buyAssets, tradeOrder);

  return tradeOrder;
}

function doSellTrades(
  sellAssets: RebalanceSummary[],
  strategyInfo: StrategyInfo,
  tradeOrder: string,
  ethBalance: BigNumber,
): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance
  for (let i = 0; i < sellAssets.length; i++) {
    if (sellAssets[i].tradeCount.gt(0)) {
      const asset = sellAssets[i].asset;
      const tradeSize = strategyInfo[asset].maxTradeSize.gt(sellAssets[i].notionalInToken.mul(-1)) ? sellAssets[i].notionalInToken.mul(-1) : strategyInfo[asset].maxTradeSize;
      sellAssets[i].notionalInToken = sellAssets[i].notionalInToken.add(tradeSize);
      sellAssets[i].tradeCount = sellAssets[i].tradeCount.sub(1);
      newEthBalance = newEthBalance.add(tradeSize.mul(ASSETS[asset].price).div(ASSETS['WETH'].price));
      tradeOrder = tradeOrder.concat(asset.concat(","));
    }
    sellAssets[i].isBuy = false;
  }
  return [sellAssets, newEthBalance];
}

function doBuyTrades(
  buyAssets: RebalanceSummary[],
  strategyInfo: StrategyInfo,
  tradeOrder: string,
  ethBalance: BigNumber,
): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance
  for (let i = 0; i < buyAssets.length; i++) {
    const asset = buyAssets[i].asset;
    const tradeSize = strategyInfo[asset].maxTradeSize.gt(buyAssets[i].notionalInToken) ? buyAssets[i].notionalInToken : strategyInfo[asset].maxTradeSize;
    const tradeSizeInEth = tradeSize.mul(ASSETS[asset].price).div(ASSETS['WETH'].price);

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

function cleanupTrades(buyAssets: RebalanceSummary[], tradeOrder: string,) {
  for (let i = 0; i < buyAssets.length; i++) {
    if (buyAssets[i].tradeCount.gt(0)) {
      tradeOrder = tradeOrder.concat(buyAssets[i].asset.concat(","));
    }
  }
}