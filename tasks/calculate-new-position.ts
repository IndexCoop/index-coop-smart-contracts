import * as _ from "lodash";
import * as fs from "fs";
const handlebars = require("handlebars");

import { task } from 'hardhat/config';
import { SetToken } from "../typechain/SetToken";
import { SingleIndexModule } from "../typechain/SingleIndexModule";
import { SetToken__factory } from "../typechain/factories/SetToken__factory";
import { SingleIndexModule__factory } from "../typechain/factories/SingleIndexModule__factory";
import { Address } from "../utils/types";
import { ZERO, PRECISE_UNIT } from "../utils/constants";
import { assets } from "../index-rebalances/assetInfo";
import { strategyInfo } from "../index-rebalances/dpi/strategyInfo";
import { BigNumber } from 'ethers';

require("@nomiclabs/hardhat-ethers");

const DPI_ADDRESS = "0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b";
const SINGLE_INDEX_MODULE_ADDRESS = "0x25100726b25a6ddb8f8e68988272e1883733966e";

interface AssetStrategy {
  address: Address;
  supply: BigNumber;
  maxTradeSize: BigNumber;
  currentUnit: BigNumber;
  price: BigNumber;
}
interface StrategyObject {
  [symbol: string]: AssetStrategy;
}

export interface RebalanceSummary {
  asset: string;
  currentUnit: BigNumber;
  newUnit: BigNumber;
  notionalInToken: BigNumber;
  notionalInUSD: BigNumber;
  tradeNumber: BigNumber;
}

interface ParamSetting {
  components: Address[];
  values: string[];
}
interface RebalanceParams {
  newComponents: Address[];
  newComponentUnits: string[];
  oldComponentUnits: string[];
  positionMultiplier: string;
}

interface RebalanceReport {
  summary: RebalanceSummary[];
  maxTradeSizeParams: ParamSetting;
  exchangeParams: ParamSetting;
  coolOffPeriodParams: ParamSetting;
  rebalanceParams: RebalanceParams;
  tradeOrder: string;
}

let tradeOrder: string = "";

task("calculate-new-position", "Calculates new rebalance details for an index")
  .addParam('rebalance', "Rebalance month")
  .setAction(async ({rebalance}, hre) => {
    let rebalanceData: RebalanceSummary[] = [];

    const [owner] = await hre.ethers.getSigners();
    const dpi: SetToken = await new SetToken__factory(owner).attach(DPI_ADDRESS);
    const indexModule: SingleIndexModule = await new SingleIndexModule__factory(owner).attach(SINGLE_INDEX_MODULE_ADDRESS);
    
    const currentPositions: any[] = await dpi.getPositions();
    const strategyConstants: StrategyObject = createStrategyObject(currentPositions);

    const dpiValue = Object.entries(strategyConstants).map(([, obj]) => {
      return obj.currentUnit.mul(obj.price);
    }).reduce((a, b) => a.add(b), ZERO).div(PRECISE_UNIT);

    const divisor = Object.entries(strategyConstants).map(([, obj]) => {
      return obj.supply.mul(obj.price);
    }).reduce((a, b) => a.add(b), ZERO).div(dpiValue);

    const totalSupply = await dpi.totalSupply();
    for (let i = 0; i < Object.keys(strategyConstants).length; i++) {
      const key = Object.keys(strategyConstants)[i];
      const assetObj = strategyConstants[key];

      const newUnit = assetObj.supply.mul(PRECISE_UNIT).div(divisor);
      const notionalInToken = newUnit.sub(assetObj.currentUnit).mul(totalSupply).div(PRECISE_UNIT);
      const tokenSummary = {
        asset: key,
        currentUnit: assetObj.currentUnit,
        newUnit: newUnit,
        notionalInToken: notionalInToken,
        notionalInUSD: notionalInToken.mul(assetObj.price).div(PRECISE_UNIT).div(PRECISE_UNIT),
        tradeNumber: notionalInToken.div(assetObj.maxTradeSize).abs().add(1),
      } as RebalanceSummary;
      rebalanceData.push(tokenSummary);
    }
    
    createRebalanceSchedule(rebalanceData);

    const report = await generateReports(rebalanceData, dpi, indexModule);

    const content = getNamedContent('index-rebalances/dpi/rebalances/report.mustache');
    var templateScript = handlebars.compile(content);
    fs.writeFileSync(`index-rebalances/dpi/rebalances/rebalance-${rebalance}.txt`, templateScript(report));
    fs.writeFileSync(`index-rebalances/dpi/rebalances/rebalance-${rebalance}.json`, JSON.stringify(report));
  });

function createStrategyObject(
  currentPositions: any[]
): any {
  const filteredConstants = _.pick(_.merge(assets, strategyInfo), Object.keys(strategyInfo));
  const keys = Object.keys(filteredConstants);
  for (let i = 0; i < keys.length; i++) {
    const position = currentPositions.filter(obj => obj.component == filteredConstants[keys[i]].address)[0];
    if (position) { filteredConstants[keys[i]].currentUnit = position.unit; }
  }
  return filteredConstants;
}

function createRebalanceSchedule(rebalanceData: RebalanceSummary[]) {
  let ethBalance: BigNumber = ZERO;
  let buyAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.gte(ZERO));
  let sellAssets: RebalanceSummary[] = rebalanceData.filter(obj => obj.notionalInToken.lt(ZERO));
  
  const totalRounds: BigNumber = Object.entries(rebalanceData).map(([, obj]) => obj.tradeNumber).reduce((a, b) => { return  a.gt(b) ? a : b; }, ZERO);
  for (let i = 0; i < totalRounds.toNumber(); i++) {
    [sellAssets, ethBalance] = doSellTrades(sellAssets, ethBalance);
    [buyAssets, ethBalance] = doBuyTrades(buyAssets, ethBalance);
  }
  cleanupTrades(buyAssets);
}

function doSellTrades(sellAssets: RebalanceSummary[], ethBalance: BigNumber): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance
  for (let i = 0; i < sellAssets.length; i++) {
    if (sellAssets[i].tradeNumber.gt(0)) {
      const asset = sellAssets[i].asset;
      const tradeSize = strategyInfo[asset].maxTradeSize.gt(sellAssets[i].notionalInToken.mul(-1)) ? sellAssets[i].notionalInToken.mul(-1) : strategyInfo[asset].maxTradeSize;
      sellAssets[i].notionalInToken = sellAssets[i].notionalInToken.add(tradeSize);
      sellAssets[i].tradeNumber = sellAssets[i].tradeNumber.sub(1);
      newEthBalance = newEthBalance.add(tradeSize.mul(assets[asset].price).div(assets['WETH'].price));
      tradeOrder = tradeOrder.concat(asset.concat(","));
    }
  }
  return [sellAssets, newEthBalance];
}

function doBuyTrades(buyAssets: RebalanceSummary[], ethBalance: BigNumber): [RebalanceSummary[], BigNumber] {
  let newEthBalance = ethBalance
  for (let i = 0; i < buyAssets.length; i++) {
    const asset = buyAssets[i].asset;
    const tradeSize = strategyInfo[asset].maxTradeSize.gt(buyAssets[i].notionalInToken) ? buyAssets[i].notionalInToken : strategyInfo[asset].maxTradeSize;
    const tradeSizeInEth = tradeSize.mul(assets[asset].price).div(assets['WETH'].price);

    if (buyAssets[i].tradeNumber.gt(0) && tradeSizeInEth.lte(newEthBalance)) {
      buyAssets[i].notionalInToken = buyAssets[i].notionalInToken.sub(tradeSize);
      buyAssets[i].tradeNumber = buyAssets[i].tradeNumber.sub(1);
      newEthBalance = newEthBalance.sub(tradeSizeInEth);
      tradeOrder = tradeOrder.concat(asset.concat(","));
    }
  }
  return [buyAssets, newEthBalance];
}

function cleanupTrades(buyAssets: RebalanceSummary[]) {
  for (let i = 0; i < buyAssets.length; i++) {
    if (buyAssets[i].tradeNumber.gt(0)) {
      tradeOrder = tradeOrder.concat(buyAssets[i].asset.concat(","));
    }
  }
}

async function generateReports(
  rebalanceData: RebalanceSummary[],
  dpi: SetToken,
  indexModule: SingleIndexModule
): Promise<RebalanceReport> {
  // Generate trade order for backend and new components params for rebalance()
  let newComponents: Address[] = [];
  let newComponentsTargetUnits: string[] = [];
  let oldComponentsTargetUnits: string[] = [];
  for (let i = 0; i < rebalanceData.length; i++) {
    const asset = rebalanceData[i].asset;
    tradeOrder = tradeOrder.replace(new RegExp(asset, 'g'), assets[asset].id);

    if (rebalanceData[i].currentUnit == ZERO) {
      newComponents.push(assets[rebalanceData[i].asset].address);
      newComponentsTargetUnits.push(rebalanceData[i].newUnit.toString());
    }
  }

  // Generate old component rebalance() params
  const components = await dpi.getComponents();
  for (let j = 0; j < components.length; j++) {
    const [[asset,]] = Object.entries(assets).filter(([key, obj]) => obj.address == components[j]);
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
    const info: any = await indexModule.assetInfo(address);

    if (info.maxSize.toString() != obj.maxTradeSize.toString()) {
      tradeSizeComponents.push(address);
      tradeSizeValue.push(obj.maxTradeSize.toString());
    }
    if (info.exchange.toString() != obj.exchange.toString()) {
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
    rebalanceData[k].tradeNumber = rebalanceData[k].notionalInToken.div(
      strategyInfo[rebalanceData[k].asset].maxTradeSize
    ).abs().add(1);
  }

  const positionMultiplier = (await dpi.positionMultiplier()).toString();

  return {
    summary: rebalanceData,
    maxTradeSizeParams: {
      components: tradeSizeComponents,
      values: tradeSizeValue
    },
    exchangeParams: {
      components: exchangeComponents,
      values: exchangeValue
    },
    coolOffPeriodParams: {
      components: coolOffComponents,
      values: coolOffValue
    },
    rebalanceParams: {
      newComponents,
      newComponentUnits: newComponentsTargetUnits,
      oldComponentUnits: oldComponentsTargetUnits,
      positionMultiplier: positionMultiplier,
    },
    tradeOrder
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