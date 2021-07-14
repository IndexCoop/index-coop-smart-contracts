import * as _ from "lodash";

import { Signer } from "ethers";
import { task } from 'hardhat/config';
import {
  getBalancerV1Quote,
  getBestQuote,
  getKyberDMMQuote,
  getSushiswapQuote,
  getUniswapV2Quote,
  getUniswapV3Quote
} from "../../index-rebalances/utils";
import { indices } from "../../index-rebalances/indices";
import { ExchangeQuote, StrategyInfo } from "../../index-rebalances/types";

import DeployHelper from "../../utils/deploys";

task("calculate-params", "Calculates new rebalance details for an index")
  .addParam('index', "Index having new positions calculated")
  .setAction(async ({index}, hre) => {
    const owner: Signer = (await hre.ethers.getSigners())[0];
    let deployHelper: DeployHelper = new DeployHelper(owner);

    const info: StrategyInfo = indices[index].strategyInfo;
    const assets: string[] = Object.keys(info);
    for (let i = 0; i < assets.length; i++) {
      console.log(assets[i]);
      const quotes: ExchangeQuote[] = [
        await getSushiswapQuote(deployHelper, info[assets[i]].address),
        await getUniswapV2Quote(info[assets[i]].address),
        await getUniswapV3Quote(deployHelper, info[assets[i]].address),
        await getKyberDMMQuote(info[assets[i]].address),
        await getBalancerV1Quote(hre.ethers.provider, info[assets[i]].address)
      ];
      console.log(getBestQuote(quotes));
    }
  });

module.exports = {};