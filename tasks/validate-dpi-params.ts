import * as _ from "lodash";
import * as fs from "fs";
const handlebars = require("handlebars");

import { task } from 'hardhat/config';
import { SetToken } from "../typechain/SetToken";
import { SingleIndexModule } from "../typechain/SingleIndexModule";
import { SetToken__factory } from "../typechain/factories/SetToken__factory";
import { SingleIndexModule__factory } from "../typechain/factories/SingleIndexModule__factory";
import { RebalanceReport } from "./calculate-new-position";
import { strategyInfo } from "../index-rebalances/dpi/strategyInfo";
import { BigNumber } from 'ethers';

require("@nomiclabs/hardhat-ethers");

const DPI_ADDRESS = "0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b";
const SINGLE_INDEX_MODULE_ADDRESS = "0x25100726b25a6ddb8f8e68988272e1883733966e";

task("validate-dpi-params", "Validates on-chain params match generated params")
.addParam('rebalance', "Rebalance month")
.setAction(async ({rebalance}, hre) => {
  const [owner] = await hre.ethers.getSigners();
  const dpi: SetToken = await new SetToken__factory(owner).attach(DPI_ADDRESS);
  const indexModule: SingleIndexModule = await new SingleIndexModule__factory(owner).attach(SINGLE_INDEX_MODULE_ADDRESS);

  const filepath = `index-rebalances/dpi/rebalances/rebalance-${rebalance}.json`;
  const expectedParams: RebalanceReport = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  const positionMultiplier: BigNumber = await dpi.positionMultiplier();

  // if (positionMultiplier.eq(BigNumber.from(expectedParams.rebalanceParams.positionMultiplier))) {
  //   console.log(positionMultiplier.toString(), expectedParams.rebalanceParams.positionMultiplier.toString());
  //   throw Error("Different position multiplier used!")
  // }

  await Promise.all(expectedParams.summary.map(async (obj, i) => {
    const address = strategyInfo[obj.asset].address;

    const info: any = await indexModule.assetInfo(address);

    if (!BigNumber.from(obj.newUnit).eq(info.targetUnit)) {
      throw Error(`Target unit for ${obj.asset} is wrong should be ${obj.newUnit.toString()} instead of ${info.targetUnit}`);
    }

    if (!strategyInfo[obj.asset].maxTradeSize.eq(info.maxSize)) {
      throw Error(
        `Max trade size for ${obj.asset} is wrong should be ${strategyInfo[obj.asset].maxTradeSize.toString()} instead of ${info.maxSize}`
      );
    }

    if (!BigNumber.from(strategyInfo[obj.asset].exchange).eq(info.exchange)) {
      throw Error(
        `Exchange for ${obj.asset} is wrong should be ${strategyInfo[obj.asset].exchange.toString()} instead of ${info.exchange}`
      );
    }

    if (!strategyInfo[obj.asset].coolOffPeriod.eq(info.coolOffPeriod)) {
      throw Error(
        `Exchange for ${obj.asset} is wrong should be ${strategyInfo[obj.asset].coolOffPeriod.toString()} instead of ${info.coolOffPeriod}`
      );
    }
  }));
  console.log("All parameters verified!");
});