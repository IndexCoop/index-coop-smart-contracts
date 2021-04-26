import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "@utils/types";

export interface DPIAssetInfo extends AssetInfo {
  supply: BigNumber;
}

export interface MVIAssetInfo extends AssetInfo {
  allocation: BigNumber;
}

export interface AssetInfo {
  address: Address,
  maxTradeSize: BigNumber,
  exchange: Exchanges,
  coolOffPeriod: BigNumber,
  currentUnit: BigNumber,
}

export interface StrategyInfo {
  [symbol: string]: DPIAssetInfo | MVIAssetInfo;
}

export enum Exchanges {
  NONE,
  UNISWAP,
  SUSHISWAP,
  BALANCER
}

export interface AssetStrategy {
  address: Address;
  supply: BigNumber;
  maxTradeSize: BigNumber;
  coolOffPeriod: BigNumber;
  exchange: Exchanges;
  currentUnit: BigNumber;
  price: BigNumber;
}
export interface StrategyObject {
  [symbol: string]: AssetStrategy;
}

export interface RebalanceSummary {
  asset: string;
  currentUnit: BigNumber;
  newUnit: BigNumber;
  notionalInToken: BigNumber;
  notionalInUSD: BigNumber;
  isBuy: boolean | undefined;
  exchange: Exchanges;
  maxTradeSize: BigNumber;
  coolOffPeriod: BigNumber;
  tradeCount: BigNumber;
}

export interface ParamSetting {
  components: Address[];
  values: string[];
}
export interface RebalanceParams {
  newComponents: Address[];
  newComponentUnits: string[];
  oldComponentUnits: string[];
  positionMultiplier: string;
}

export interface RebalanceReport {
  summary: RebalanceSummary[];
  maxTradeSizeParams: ParamSetting;
  exchangeParams: ParamSetting;
  coolOffPeriodParams: ParamSetting;
  rebalanceParams: RebalanceParams;
  tradeOrder: string;
}