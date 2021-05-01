import * as _ from "lodash";
import * as fs from "fs";

import { task } from 'hardhat/config';
import { BigNumber, Signer } from 'ethers';

import {
  GeneralIndexModule,
  SetToken,
} from "../utils/contracts/setV2";
import { IndexInfo, RebalanceReport } from "../index-rebalances/types";

import { indices } from "../index-rebalances/indices";
import { getTokenDecimals } from "../index-rebalances/utils/index";
import { preciseMul } from "../utils/index";
import DeployHelper from "../utils/deploys";

import DEPENDENCY from "../index-rebalances/dependencies";

const {
  GENERAL_INDEX_MODULE,
} = DEPENDENCY;

task("validate-index-params", "Validates on-chain params match generated params")
.addParam('index', "Index having new positions calculated")
.addParam('rebalance', "Rebalance month")
.setAction(async ({index, rebalance}, hre) => {
  const owner: Signer = (await hre.ethers.getSigners())[0];
  let deployHelper: DeployHelper = new DeployHelper(owner);

  const indexInfo: IndexInfo = indices[index];

  const setToken: SetToken = await deployHelper.setV2.getSetToken(indexInfo.address);
  const indexModule: GeneralIndexModule = await deployHelper.setV2.getGeneralIndexModule(GENERAL_INDEX_MODULE);

  const filepath = indexInfo.path + `${rebalance}.json`;
  const expectedParams: RebalanceReport = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  const positionMultiplier: BigNumber = await setToken.positionMultiplier();

  if (!positionMultiplier.eq(BigNumber.from(expectedParams.rebalanceParams.positionMultiplier))) {
    console.log(positionMultiplier.toString(), expectedParams.rebalanceParams.positionMultiplier.toString());
    throw Error("Different position multiplier used!")
  }

  await Promise.all(expectedParams.summary.map(async (obj, i) => {
    const address = indexInfo.strategyInfo[obj.asset].address;

    const info: any = await indexModule.executionInfo(setToken.address, address);

    if (!BigNumber.from(obj.newUnit).eq(info.targetUnit)) {
      throw Error(`Target unit for ${obj.asset} is wrong should be ${obj.newUnit.toString()} instead of ${info.targetUnit}`);
    }

    const scaledMaxTradeSize = preciseMul(indexInfo.strategyInfo[obj.asset].maxTradeSize, await getTokenDecimals(deployHelper, address));
    if (!scaledMaxTradeSize.eq(info.maxSize)) {
      throw Error(
        `Max trade size for ${obj.asset} is wrong should be ${indexInfo.strategyInfo[obj.asset].maxTradeSize.toString()} instead of ${info.maxSize}`
      );
    }

    if (indexInfo.strategyInfo[obj.asset].exchange != info.exchangeName) {
      throw Error(
        `Exchange for ${obj.asset} is wrong should be ${indexInfo.strategyInfo[obj.asset].exchange} instead of ${info.exchange}`
      );
    }

    if (!indexInfo.strategyInfo[obj.asset].coolOffPeriod.eq(info.coolOffPeriod)) {
      throw Error(
        `Cool off period for ${obj.asset} is wrong should be ${indexInfo.strategyInfo[obj.asset].coolOffPeriod.toString()} instead of ${info.coolOffPeriod}`
      );
    }
  }));
  console.log("All parameters verified!");
});