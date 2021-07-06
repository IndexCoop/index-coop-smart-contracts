import * as _ from "lodash";
import * as fs from "fs";
const handlebars = require("handlebars");

import { Address } from "../../utils/types";

import { ASSETS } from "../assetInfo";
import { PRECISE_UNIT, ZERO } from "../../utils/constants";
import DEPENDENCY from "../dependencies";

import { RebalanceReport, RebalanceSummary, StrategyInfo } from "index-rebalances/types";
import {
  GeneralIndexModule,
  SetToken,
} from "../../utils/contracts/setV2";

const {
  GENERAL_INDEX_MODULE,
} = DEPENDENCY;

export async function createStrategyObject(
  setToken: SetToken,
  strategyInfo: StrategyInfo
): Promise<any> {

  const currentPositions: any[] = await setToken.getPositions();

  const filteredConstants = _.pick(_.merge(ASSETS, strategyInfo), Object.keys(strategyInfo));
  const keys = Object.keys(filteredConstants);
  for (let i = 0; i < keys.length; i++) {
    const position = currentPositions.filter(obj => obj.component.toLowerCase() == filteredConstants[keys[i]].address.toLowerCase())[0];
    if (position) { filteredConstants[keys[i]].currentUnit = position.unit; }
  }
  return filteredConstants;
}

export async function generateReports(
  rebalanceData: RebalanceSummary[],
  tradeOrder: string,
  strategyInfo: StrategyInfo,
  setToken: SetToken,
  indexModule: GeneralIndexModule
): Promise<RebalanceReport> {
  // Generate trade order for backend and new components params for rebalance()
  let newComponents: Address[] = [];
  let newComponentsTargetUnits: string[] = [];
  let oldComponentsTargetUnits: string[] = [];
  for (let i = 0; i < rebalanceData.length; i++) {
    const asset = rebalanceData[i].asset;
    tradeOrder = tradeOrder.replace(new RegExp(asset, 'g'), ASSETS[asset].id);

    if (rebalanceData[i].currentUnit == ZERO) {
      newComponents.push(ASSETS[rebalanceData[i].asset].address);
      newComponentsTargetUnits.push(rebalanceData[i].newUnit.toString());
    }
  }

  // Generate old component rebalance() params
  const components = await setToken.getComponents();

  for (let j = 0; j < components.length; j++) {
    const [[asset,]] = Object.entries(ASSETS).filter(([key, obj]) => obj.address.toLowerCase() == components[j].toLowerCase());
    oldComponentsTargetUnits.push(rebalanceData.filter(obj => obj.asset == asset)[0].newUnit.toString());
  }

  // Generate params for setAssetMaximums and setAssetExchanges
  const tradeSizeComponents: Address[] = [];
  const tradeSizeValue: string[] = [];
  const exchangeComponents: Address[] = [];
  const exchangeValue: string[] = [];
  const coolOffComponents: Address[] = [];
  const coolOffValue: string[] = [];
  await Promise.all(Object.entries(strategyInfo).map(async ([key, obj]) => {
    const address = obj.address;
    const info: any = await indexModule.executionInfo(setToken.address, address);

    if (info.maxSize.toString() != obj.maxTradeSize.toString()) {
      tradeSizeComponents.push(address);
      tradeSizeValue.push(obj.maxTradeSize.toString());
    }
    if (info.exchangeName.toString() != obj.exchange.toString()) {
      exchangeComponents.push(address);
      exchangeValue.push(obj.exchange.toString());
    }
    if (info.coolOffPeriod.toString() != obj.coolOffPeriod.toString()) {
      coolOffComponents.push(address);
      coolOffValue.push(obj.coolOffPeriod.toString());
    }
  }));

  // Refill fields in rebalanceData altered during trade scheduling
  const totalSupply = await setToken.totalSupply();
  for (let k = 0; k < rebalanceData.length; k++) {
    rebalanceData[k].notionalInToken = rebalanceData[k].newUnit.sub(rebalanceData[k].currentUnit).mul(totalSupply).div(PRECISE_UNIT);
    rebalanceData[k].tradeCount = rebalanceData[k].notionalInToken.div(
      strategyInfo[rebalanceData[k].asset].maxTradeSize
    ).abs().add(1);
  }

  const positionMultiplier = (await setToken.positionMultiplier()).toString();

  return {
    summary: rebalanceData,
    maxTradeSizeParams: {
      components: tradeSizeComponents,
      values: tradeSizeValue,
      data: indexModule.interface.encodeFunctionData(
        'setTradeMaximums',
        [setToken.address, tradeSizeComponents, tradeSizeValue]
      )
    },
    exchangeParams: {
      components: exchangeComponents,
      values: exchangeValue,
      data: indexModule.interface.encodeFunctionData(
        'setExchanges',
        [setToken.address, exchangeComponents, exchangeValue]
      )
    },
    coolOffPeriodParams: {
      components: coolOffComponents,
      values: coolOffValue,
      data: indexModule.interface.encodeFunctionData(
        'setCoolOffPeriods',
        [setToken.address, coolOffComponents, coolOffValue]
      )
    },
    rebalanceParams: {
      newComponents,
      newComponentUnits: newComponentsTargetUnits,
      oldComponentUnits: oldComponentsTargetUnits,
      positionMultiplier: positionMultiplier,
      data: indexModule.interface.encodeFunctionData(
        'startRebalance',
        [setToken.address, newComponents, newComponentsTargetUnits, oldComponentsTargetUnits, positionMultiplier]
      )
    },
    tradeOrder
  } as RebalanceReport;
}

export function writeToOutputs(report:RebalanceReport, path: string) {
  const content = getNamedContent('index-rebalances/report.mustache');

  var templateScript = handlebars.compile(content);

  fs.writeFileSync(path + ".txt", templateScript(report));
  fs.writeFileSync(path + ".json", JSON.stringify(report));
}

function getNamedContent(filename: string) {
  try {
      const content = fs.readFileSync(filename).toString();
      return content;
  } catch (err) {
      throw new Error(`Failed to read ${filename}: ${err}`);
  }
}