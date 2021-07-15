import * as _ from "lodash";

import { BigNumber, Signer } from "ethers";
import { task } from "hardhat/config";
import {
  getBalancerV1Quote,
  getKyberDMMQuote,
  getSushiswapQuote,
  getUniswapV2Quote,
  getUniswapV3Quote
} from "../../index-rebalances/utils";
import { indices } from "../../index-rebalances/indices";
import { ExchangeQuote, StrategyInfo } from "../../index-rebalances/types";

import DeployHelper from "../../utils/deploys";
import { ether } from "../../utils/common";

const FIFTY_BPS_IN_PERCENT = ether(.5);
const FORTY_BPS_IN_PERCENT = ether(.4);

task("calculate-params", "Calculates new rebalance details for an index")
  .addParam("index", "Index having new positions calculated")
  .setAction(async ({index}, hre) => {
    const owner: Signer = (await hre.ethers.getSigners())[0];
    const deployHelper: DeployHelper = new DeployHelper(owner);

    const info: StrategyInfo = indices[index].strategyInfo;
    const assets: string[] = Object.keys(info);
    for (let i = 0; i < assets.length; i++) {
      console.log(assets[i]);
      const quotes: ExchangeQuote[] = [
        await getSushiswapQuote(deployHelper, info[assets[i]].address, FIFTY_BPS_IN_PERCENT),
        await getUniswapV2Quote(info[assets[i]].address, FIFTY_BPS_IN_PERCENT),
        await getUniswapV3Quote(deployHelper, info[assets[i]].address, FORTY_BPS_IN_PERCENT),
        await getKyberDMMQuote(info[assets[i]].address, FIFTY_BPS_IN_PERCENT),
        await getBalancerV1Quote(hre.ethers.provider, info[assets[i]].address, FIFTY_BPS_IN_PERCENT),
      ];
      console.log(quotes.reduce((p, c) => BigNumber.from(p.size).gt(BigNumber.from(c.size)) ? p : c));
    }
  });

module.exports = {};