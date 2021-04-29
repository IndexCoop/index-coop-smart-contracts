import { BigNumber } from "@ethersproject/bignumber";
import { IndexInfo, Indices, StrategyObject, RebalanceSummary } from "index-rebalances/types";
import { SetToken } from "../../utils/contracts/setV2";

import { strategyInfo as dpiStrategyInfo } from "./dpi/strategyInfo";
import { strategyInfo as mviStrategyInfo } from "./mvi/strategyInfo";

import { calculateNewAllocations as dpiAssetAllocation } from "./dpi/assetAllocation";
import { calculateNewAllocations as mviAssetAllocation } from "./mvi/assetAllocation";

import { Signer } from "ethers";

export const indices: Indices = {
  "DPI": {
    "address": "0x73BAA8A41ddA1Cbcae8C7709A2A7B171182A1D46",
    "strategyInfo": dpiStrategyInfo,
    "path": buildPath("dpi"),
    calculateAssetAllocation(
      setToken: SetToken,
      strategyConstants: StrategyObject,
      setTokenValue: BigNumber
    ): Promise<RebalanceSummary[]> {
      return dpiAssetAllocation(setToken, strategyConstants, setTokenValue);
    }
  } as IndexInfo,
  "MVI": {
    address: "0x72e364F2ABdC788b7E918bc238B21f109Cd634D7",
    strategyInfo: mviStrategyInfo,
    path: buildPath("mvi"),
    calculateAssetAllocation(
      setToken: SetToken,
      strategyConstants: StrategyObject,
      setTokenValue: BigNumber
    ): Promise<RebalanceSummary[]> {
      return mviAssetAllocation(setToken, strategyConstants, setTokenValue);
    }
  } as IndexInfo
}

function buildPath(name: string): string {
  return `index-rebalances/indices/${name.toLowerCase()}/rebalances/rebalance-`;
}