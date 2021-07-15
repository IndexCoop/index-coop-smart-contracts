import * as _ from "lodash";

import { Signer } from "ethers";
import { task } from "hardhat/config";
import {
  calculateSetValue,
  createRebalanceSchedule,
  createStrategyObject,
  generateReports,
  writeToOutputs
} from "../../index-rebalances/utils";
import { indices } from "../../index-rebalances/indices";
import { IndexInfo, RebalanceSummary, StrategyObject } from "../../index-rebalances/types";
import {
  SetToken,
} from "../../utils/contracts/setV2";

import DeployHelper from "../../utils/deploys";
import DEPENDENCY from "../../index-rebalances/dependencies";

const {
  GENERAL_INDEX_MODULE,
} = DEPENDENCY;

task("calculate-new-index-position", "Calculates new rebalance details for an index")
  .addParam("index", "Index having new positions calculated")
  .addParam("rebalance", "Rebalance month")
  .setAction(async ({index, rebalance}, hre) => {
    const owner: Signer = (await hre.ethers.getSigners())[0];
    const deployHelper: DeployHelper = new DeployHelper(owner);

    const indexInfo: IndexInfo = indices[index];

    const setToken: SetToken = await deployHelper.setV2.getSetToken(indexInfo.address);

    const strategyConstants: StrategyObject = await createStrategyObject(
      setToken,
      indexInfo.strategyInfo,
      owner
    );

    const setTokenValue = calculateSetValue(strategyConstants);

    const rebalanceData: RebalanceSummary[] = await indexInfo.calculateAssetAllocation(
      setToken,
      strategyConstants,
      setTokenValue
    );

    const tradeOrder = createRebalanceSchedule(rebalanceData, strategyConstants);

    const report = await generateReports(
      rebalanceData,
      tradeOrder,
      strategyConstants,
      setToken,
      await deployHelper.setV2.getGeneralIndexModule(GENERAL_INDEX_MODULE)
    );

    writeToOutputs(report, indexInfo.path + rebalance);
  });

module.exports = {};