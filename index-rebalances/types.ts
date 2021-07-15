import { BigNumber } from "@ethersproject/bignumber";
import { SetToken } from "../utils/contracts/setV2";

export type Address = string;

export interface Indices {
  [symbol: string]: IndexInfo;
}

export interface IndexInfo {
  address: string;
  strategyInfo: StrategyInfo;
  path: string;
  calculateAssetAllocation(
    setToken: SetToken,
    strategyConstants: StrategyObject,
    setTokenValue: BigNumber
  ): Promise<RebalanceSummary[]>;
}

export interface AssetInfo {
  address: Address;
  maxTradeSize: BigNumber;
  exchange: string;
  exchangeData?: string;
  coolOffPeriod: BigNumber;
  currentUnit: BigNumber;
  input: BigNumber;
  decimals?: BigNumber;
}

export interface StrategyInfo {
  [symbol: string]: AssetInfo;
}

export interface Exchanges {
  [symbol: string]: string;
}

export interface ExchangeQuote {
  exchange: string;
  size: string;
  data: string;
}

export let exchanges: Exchanges = {
  NONE: "",
  UNISWAP: "UniswapV2IndexExchangeAdapter",
  SUSHISWAP: "SushiswapIndexExchangeAdapter",
  BALANCER: ";B;alancerV1IndexExchangeAdapter",
};

export interface AssetStrategy {
  address: Address;
  decimals: BigNumber;
  input: BigNumber;
  maxTradeSize: BigNumber;
  coolOffPeriod: BigNumber;
  exchange: string;
  currentUnit: BigNumber;
  price: BigNumber;
  supply?: BigNumber;
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
  exchange: string;
  maxTradeSize: BigNumber;
  coolOffPeriod: BigNumber;
  tradeCount: BigNumber;
}

export interface RebalanceSummaryLight {
  asset: string;
  currentUnit: BigNumber;
  newUnit: BigNumber;
  notionalInToken: BigNumber;
  notionalInUSD: BigNumber;
  isBuy: boolean | undefined;
}

export interface ParamSetting {
  components: Address[];
  values: string[];
  data: string;
}
export interface RebalanceParams {
  newComponents: Address[];
  newComponentUnits: string[];
  oldComponentUnits: string[];
  positionMultiplier: string;
  data: string;
}

export interface RebalanceReport {
  summary: RebalanceSummary[];
  maxTradeSizeParams: ParamSetting;
  exchangeParams: ParamSetting;
  coolOffPeriodParams: ParamSetting;
  rebalanceParams: RebalanceParams;
  tradeOrder: string;
}