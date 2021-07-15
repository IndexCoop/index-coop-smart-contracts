import { BigNumber } from "ethers";
import { IndexInfo, Indices, StrategyObject, RebalanceSummary } from "index-rebalances/types";
import { SetToken } from "../../utils/contracts/setV2";

import { strategyInfo as dpiStrategyInfo } from "./dpi/strategyInfo";
import { strategyInfo as mviStrategyInfo } from "./mvi/strategyInfo";

import { calculateNewAllocations as dpiAssetAllocation } from "./dpi/assetAllocation";
import { calculateNewAllocations as mviAssetAllocation } from "./mvi/assetAllocation";

export const indices: Indices = {
  "DPI": {
    "address": "0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b",
    "strategyInfo": dpiStrategyInfo,
    "path": buildPath("dpi"),
    calculateAssetAllocation(
      setToken: SetToken,
      strategyConstants: StrategyObject,
      setTokenValue: BigNumber
    ): Promise<RebalanceSummary[]> {
      return dpiAssetAllocation(setToken, strategyConstants, setTokenValue);
    },
  } as IndexInfo,
  "MVI": {
    address: "0x72e364f2abdc788b7e918bc238b21f109cd634d7",
    strategyInfo: mviStrategyInfo,
    path: buildPath("mvi"),
    calculateAssetAllocation(
      setToken: SetToken,
      strategyConstants: StrategyObject,
      setTokenValue: BigNumber
    ): Promise<RebalanceSummary[]> {
      return mviAssetAllocation(setToken, strategyConstants, setTokenValue);
    },
  } as IndexInfo,
};

function buildPath(name: string): string {
  return `index-rebalances/indices/${name.toLowerCase()}/rebalances/rebalance-`;
}