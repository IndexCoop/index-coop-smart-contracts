import * as _ from "lodash";
import * as fs from "fs";
const handlebars = require("handlebars");

import { Signer } from "ethers";
import { Address } from "../../utils/types";

import { ASSETS } from "../assetInfo";
import { PRECISE_UNIT, ZERO } from "../../utils/constants";

import {
  RebalanceReport,
  RebalanceSummary,
  StrategyInfo,
  StrategyObject,
  AssetStrategy
} from "index-rebalances/types";

import {
  GeneralIndexModule,
  SetToken,
} from "../../utils/contracts/setV2";

import DeployHelper from "../../utils/deploys";
import { getTokenDecimals } from "./tokenHelpers";

export async function createStrategyObject(
  setToken: SetToken,
  strategyInfo: StrategyInfo,
  owner: Signer
): Promise<StrategyObject> {
  const strategyObject: StrategyObject = {};

  const currentPositions: any[] = await setToken.getPositions();

  const deployHelper: DeployHelper = new DeployHelper(owner);

  const filteredConstants = _.pick(_.merge(ASSETS, strategyInfo), Object.keys(strategyInfo));
  const keys = Object.keys(filteredConstants);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];

    const position = currentPositions.filter(obj => obj.component.toLowerCase() == filteredConstants[key].address.toLowerCase())[0];
    if (position) { filteredConstants[key].currentUnit = position.unit; }

    const decimals = await getTokenDecimals(deployHelper, filteredConstants[key].address);

    strategyObject[key] = {} as AssetStrategy;
    strategyObject[key].address = filteredConstants[key].address;
    strategyObject[key].price = filteredConstants[key].price;
    strategyObject[key].maxTradeSize = filteredConstants[key].maxTradeSize.mul(decimals).div(PRECISE_UNIT);
    strategyObject[key].exchange = filteredConstants[key].exchange;
    strategyObject[key].coolOffPeriod = filteredConstants[key].coolOffPeriod;
    strategyObject[key].input = filteredConstants[key].input;
    strategyObject[key].currentUnit = position ? position.unit : ZERO;
    strategyObject[key].decimals = decimals;
  }

  return strategyObject;
}

export async function generateReports(
  rebalanceData: RebalanceSummary[],
  tradeOrder: string,
  strategyInfo: StrategyInfo,
  setToken: SetToken,
  indexModule: GeneralIndexModule
): Promise<RebalanceReport> {
  // Generate trade order for backend and new components params for rebalance()
  const newComponents: Address[] = [];
  const newComponentsTargetUnits: string[] = [];
  const oldComponentsTargetUnits: string[] = [];
  for (let i = 0; i < rebalanceData.length; i++) {
    const asset = rebalanceData[i].asset;
    tradeOrder = tradeOrder.replace(new RegExp(asset, "g"), ASSETS[asset].id);

    if (rebalanceData[i].currentUnit == ZERO) {
      newComponents.push(ASSETS[rebalanceData[i].asset].address);
      newComponentsTargetUnits.push(rebalanceData[i].newUnit.toString());
    }
  }

  // Generate old component rebalance() params
  const components = await setToken.getComponents();

  for (let j = 0; j < components.length; j++) {
    const [[asset, ]] = Object.entries(ASSETS).filter(([key, obj]) =>
      obj.address.toLowerCase() == components[j].toLowerCase()
    );

    oldComponentsTargetUnits.push(
      rebalanceData.filter(obj => obj.asset == asset)[0].newUnit.toString()
    );
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
    rebalanceData[k].notionalInToken =
      rebalanceData[k].newUnit.sub(rebalanceData[k].currentUnit).mul(totalSupply).div(PRECISE_UNIT);

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
        "setTradeMaximums",
        [setToken.address, tradeSizeComponents, tradeSizeValue]
      ),
    },
    exchangeParams: {
      components: exchangeComponents,
      values: exchangeValue,
      data: indexModule.interface.encodeFunctionData(
        "setExchanges",
        [setToken.address, exchangeComponents, exchangeValue]
      ),
    },
    coolOffPeriodParams: {
      components: coolOffComponents,
      values: coolOffValue,
      data: indexModule.interface.encodeFunctionData(
        "setCoolOffPeriods",
        [setToken.address, coolOffComponents, coolOffValue]
      ),
    },
    rebalanceParams: {
      newComponents,
      newComponentUnits: newComponentsTargetUnits,
      oldComponentUnits: oldComponentsTargetUnits,
      positionMultiplier: positionMultiplier,
      data: indexModule.interface.encodeFunctionData(
        "startRebalance",
        [
          setToken.address,
          newComponents,
          newComponentsTargetUnits,
          oldComponentsTargetUnits,
          positionMultiplier,
        ]
      ),
    },
    tradeOrder,
  } as RebalanceReport;
}

export function writeToOutputs(report: RebalanceReport, path: string) {
  const content = getNamedContent("index-rebalances/report.mustache");

  const templateScript = handlebars.compile(content);

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