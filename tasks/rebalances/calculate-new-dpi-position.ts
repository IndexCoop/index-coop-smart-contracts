// @ts-nocheck
import * as _ from "lodash";
import * as fs from "fs";
const handlebars = require("handlebars");

import { task } from "hardhat/config";
import { SetToken } from "../../typechain/SetToken";
import { GeneralIndexModule } from "../../typechain/GeneralIndexModule";
import { SetToken__factory } from "../../typechain/factories/SetToken__factory";
import { GeneralIndexModule__factory } from "../../typechain/factories/GeneralIndexModule__factory";
import { Address } from "../../utils/types";
import { ZERO, PRECISE_UNIT } from "../../utils/constants";
import { ether, preciseDiv, preciseMul } from "../../utils/common/index";
import { assets } from "../../index-rebalances/assetInfo";
import { strategyInfo } from "../../index-rebalances/indices/dpi/strategyInfo";
import { BigNumber } from "ethers";
import { RebalanceReport, RebalanceSummary, StrategyObject } from "../../index-rebalances/types";
import DEPENDENCY from "../../index-rebalances/dependencies";

const {
  DPI,
  GENERAL_INDEX_MODULE,
} = DEPENDENCY;

let tradeOrder: string = "";

task("calculate-new-dpi-position", "Calculates new rebalance details for an index")
  .addParam("rebalance", "Rebalance month")
  .setAction(async ({rebalance}, hre) => {
    const [owner] = await hre.ethers.getSigners();
    const dpi: SetToken = await new SetToken__factory(owner).attach(DPI);
    const indexModule: GeneralIndexModule = await new GeneralIndexModule__factory(owner).attach(
      GENERAL_INDEX_MODULE
    );

    const currentPositions: any[] = await dpi.getPositions();

    const strategyConstants: StrategyObject = createStrategyObject(currentPositions);

    const dpiValue = Object.entries(strategyConstants).map(([, obj]) => {
      return obj.currentUnit.mul(obj.price);
    }).reduce((a, b) => a.add(b), ZERO).div(PRECISE_UNIT);

    const divisor = Object.entries(strategyConstants).map(([, obj]) => {
      return obj.supply.mul(obj.price);
    }).reduce((a, b) => a.add(b), ZERO).div(dpiValue);

    const rebalanceData: RebalanceSummary[] = await calculateNewAllocations(strategyConstants, dpiValue, divisor, dpi);

    createRebalanceSchedule(rebalanceData);

    const report = await generateReports(rebalanceData, dpi, indexModule);

    const content = getNamedContent("index-rebalances/dpi/rebalances/report.mustache");
    const templateScript = handlebars.compile(content);
    fs.writeFileSync(`index-rebalances/dpi/rebalances/rebalance-${rebalance}.txt`, templateScript(report));
    fs.writeFileSync(`index-rebalances/dpi/rebalances/rebalance-${rebalance}.json`, JSON.stringify(report));
  });

async function calculateNewAllocations(
  strategyConstants: StrategyObject,
  dpiValue: BigNumber,
  divisor: BigNumber,
  dpi: SetToken,
): Promise<RebalanceSummary[]> {
  const rebalanceData: RebalanceSummary[] = [];

  let sumOfCappedAllocations = ZERO;
  const cappedAssets: string[] = [];

  const totalSupply = await dpi.totalSupply();
  for (let i = 0; i < Object.keys(strategyConstants).length; i++) {
    const key = Object.keys(strategyConstants)[i];
    const assetObj = strategyConstants[key];

    let newUnit = assetObj.supply.mul(PRECISE_UNIT).div(divisor);

    let allocation: BigNumber = strategyConstants[key].price.mul(newUnit).div(dpiValue);
    if (allocation.gt(ether(.25))) {
      cappedAssets.push(key);
      newUnit = ether(.25).mul(dpiValue).div(strategyConstants[key].price);
      allocation = ether(.25);
    }
    sumOfCappedAllocations = sumOfCappedAllocations.add(allocation);
    rebalanceData.push({
      asset: key,
      newUnit: newUnit,
      currentUnit: ZERO,
      notionalInToken: ZERO,
      notionalInUSD: ZERO,
      tradeCount: ZERO,
      isBuy: undefined,
      exchange: assetObj.exchange,
      maxTradeSize: assetObj.maxTradeSize,
      coolOffPeriod: assetObj.coolOffPeriod,
    });
  }

  const cappedAssetAllocationSum = ether(.25).mul(cappedAssets.length);

  for (let i = 0; i < rebalanceData.length; i++) {
    const assetObj = strategyConstants[rebalanceData[i].asset];

    let finalNewUnit: BigNumber = rebalanceData[i].newUnit;
    if (!cappedAssets.includes(rebalanceData[i].asset)) {
      const allocation: BigNumber = assetObj.price.mul(rebalanceData[i].newUnit).div(dpiValue);
      const allocationSansCapped = preciseDiv(allocation, sumOfCappedAllocations.sub(cappedAssetAllocationSum));
      const additionalAllocation = preciseMul(allocationSansCapped, PRECISE_UNIT.sub(sumOfCappedAllocations));

      const finalCappedAllocation = allocation.add(additionalAllocation);
      finalNewUnit = finalCappedAllocation.mul(dpiValue).div(assetObj.price);
    }

    const currentUnit = assetObj.currentUnit;
    const notionalInToken = finalNewUnit.sub(currentUnit).mul(totalSupply).div(PRECISE_UNIT);

    rebalanceData[i].newUnit = finalNewUnit;
    rebalanceData[i].currentUnit = currentUnit;
    rebalanceData[i].notionalInToken = notionalInToken;
    rebalanceData[i].notionalInUSD = notionalInToken.mul(assetObj.price).div(PRECISE_UNIT).div(PRECISE_UNIT);
    rebalanceData[i].tradeCount = notionalInToken.div(assetObj.maxTradeSize).abs().add(1);
  }
  return rebalanceData;
}

function createStrategyObject(
  currentPositions: any[]
): any {
  const filteredConstants = _.pick(_.merge(assets, strategyInfo), Object.keys(strategyInfo));
  const keys = Object.keys(filteredConstants);
  for (let i = 0; i < keys.length; i++) {
    const position = currentPositions.filter(obj => obj.component.toLowerCase() == filteredConstants[keys[i]].address.toLowerCase())[0];
    if (position) { filteredConstants[keys[i]].currentUnit = position.unit; }
  }
  return filteredConstants;
}

function createRebalanceSchedule(rebalanceData: RebalanceSummary[]) {
  let ethBalance: BigNumber = ZERO;
  let buyAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.gte(ZERO));
  let sellAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.lt(ZERO));

  const totalRounds: BigNumber = Object.entries(rebalanceData).map(([, obj]) => obj.tradeCount).reduce((a, b) => { return  a.gt(b) ? a : b; }, ZERO);
  for (let i = 0; i < totalRounds.toNumber(); i++) {
    [sellAssets, ethBalance] = doSellTrades(sellAssets, ethBalance);
    [buyAssets, ethBalance] = doBuyTrades(buyAssets, ethBalance);
  }
  cleanupTrades(buyAssets);
}

function doSellTrades(sellAssets: RebalanceSummary[], ethBalance: BigNumber): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance;
  for (let i = 0; i < sellAssets.length; i++) {
    if (sellAssets[i].tradeCount.gt(0)) {
      const asset = sellAssets[i].asset;

      const tradeSize = strategyInfo[asset].maxTradeSize.gt(sellAssets[i].notionalInToken.mul(-1))
        ? sellAssets[i].notionalInToken.mul(-1)
        : strategyInfo[asset].maxTradeSize;

      sellAssets[i].notionalInToken = sellAssets[i].notionalInToken.add(tradeSize);
      sellAssets[i].tradeCount = sellAssets[i].tradeCount.sub(1);
      newEthBalance = newEthBalance.add(tradeSize.mul(assets[asset].price).div(assets["WETH"].price));
      tradeOrder = tradeOrder.concat(asset.concat(","));
    }
    sellAssets[i].isBuy = false;
  }
  return [sellAssets, newEthBalance];
}

function doBuyTrades(buyAssets: RebalanceSummary[], ethBalance: BigNumber): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance;
  for (let i = 0; i < buyAssets.length; i++) {
    const asset = buyAssets[i].asset;

    const tradeSize = strategyInfo[asset].maxTradeSize.gt(buyAssets[i].notionalInToken)
      ? buyAssets[i].notionalInToken
      : strategyInfo[asset].maxTradeSize;

    const tradeSizeInEth = tradeSize.mul(assets[asset].price).div(assets["WETH"].price);

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

function cleanupTrades(buyAssets: RebalanceSummary[]) {
  for (let i = 0; i < buyAssets.length; i++) {
    if (buyAssets[i].tradeCount.gt(0)) {
      tradeOrder = tradeOrder.concat(buyAssets[i].asset.concat(","));
    }
  }
}

async function generateReports(
  rebalanceData: RebalanceSummary[],
  dpi: SetToken,
  indexModule: GeneralIndexModule
): Promise<RebalanceReport> {
  // Generate trade order for backend and new components params for rebalance()
  const newComponents: Address[] = [];
  const newComponentsTargetUnits: string[] = [];
  const oldComponentsTargetUnits: string[] = [];
  for (let i = 0; i < rebalanceData.length; i++) {
    const asset = rebalanceData[i].asset;
    tradeOrder = tradeOrder.replace(new RegExp(asset, "g"), assets[asset].id);

    if (rebalanceData[i].currentUnit == ZERO) {
      newComponents.push(assets[rebalanceData[i].asset].address);
      newComponentsTargetUnits.push(rebalanceData[i].newUnit.toString());
    }
  }

  // Generate old component rebalance() params
  const components = await dpi.getComponents();

  for (let j = 0; j < components.length; j++) {
    const [[asset, ]] = Object.entries(assets).filter(([key, obj]) => obj.address.toLowerCase() == components[j].toLowerCase());
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
    const info: any = await indexModule.executionInfo(dpi.address, address);

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
  const totalSupply = await dpi.totalSupply();
  for (let k = 0; k < rebalanceData.length; k++) {
    rebalanceData[k].notionalInToken = rebalanceData[k].newUnit.sub(rebalanceData[k].currentUnit).mul(totalSupply).div(PRECISE_UNIT);
    rebalanceData[k].tradeCount = rebalanceData[k].notionalInToken.div(
      strategyInfo[rebalanceData[k].asset].maxTradeSize
    ).abs().add(1);
  }

  const positionMultiplier = (await dpi.positionMultiplier()).toString();

  return {
    summary: rebalanceData,
    maxTradeSizeParams: {
      components: tradeSizeComponents,
      values: tradeSizeValue,
      data: indexModule.interface.encodeFunctionData(
        "setTradeMaximums",
        [DPI, tradeSizeComponents, tradeSizeValue]
      ),
    },
    exchangeParams: {
      components: exchangeComponents,
      values: exchangeValue,
      data: indexModule.interface.encodeFunctionData(
        "setExchanges",
        [DPI, exchangeComponents, exchangeValue]
      ),
    },
    coolOffPeriodParams: {
      components: coolOffComponents,
      values: coolOffValue,
      data: indexModule.interface.encodeFunctionData(
        "setCoolOffPeriods",
        [DPI, coolOffComponents, coolOffValue]
      ),
    },
    rebalanceParams: {
      newComponents,
      newComponentUnits: newComponentsTargetUnits,
      oldComponentUnits: oldComponentsTargetUnits,
      positionMultiplier: positionMultiplier,
      data: indexModule.interface.encodeFunctionData(
        "startRebalance",
        [DPI, newComponents, newComponentsTargetUnits, oldComponentsTargetUnits, positionMultiplier]
      ),
    },
    tradeOrder,
  } as RebalanceReport;
}

function getNamedContent(filename: string) {
  try {
      const content = fs.readFileSync(filename).toString();
      return content;
  } catch (err) {
      throw new Error(`Failed to read ${filename}: ${err}`);
  }
}

module.exports = {};