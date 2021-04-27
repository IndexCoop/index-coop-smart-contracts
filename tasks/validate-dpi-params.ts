// @ts-nocheck
import * as _ from "lodash";
import * as fs from "fs";

import { task } from 'hardhat/config';
import { RebalanceReport } from "../index-rebalances/types";
import { strategyInfo } from "../index-rebalances/dpi/strategyInfo";
import { BigNumber } from 'ethers';
import DEPENDENCY from "../index-rebalances/dependencies"

const {
  DPI,
  GENERAL_INDEX_MODULE,
} = DEPENDENCY;

task("validate-dpi-params", "Validates on-chain params match generated params")
.addParam('rebalance', "Rebalance month")
.setAction(async ({rebalance}, hre) => {
  const { SetToken } = await import("../typechain/SetToken");
  const { GeneralIndexModule } = await  import("../typechain/GeneralIndexModule");
  const { SetToken__factory } = await import("../typechain/factories/SetToken__factory");
  const { GeneralIndexModule__factory } = await import("../typechain/factories/GeneralIndexModule__factory");

  const [owner] = await hre.ethers.getSigners();
  const dpi: SetToken = await new SetToken__factory(owner).attach(DPI);
  const indexModule: GeneralIndexModule = await new GeneralIndexModule__factory(owner).attach(GENERAL_INDEX_MODULE);

  const filepath = `index-rebalances/dpi/rebalances/rebalance-${rebalance}.json`;
  const expectedParams: RebalanceReport = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  const positionMultiplier: BigNumber = await dpi.positionMultiplier();

  if (!positionMultiplier.eq(BigNumber.from(expectedParams.rebalanceParams.positionMultiplier))) {
    console.log(positionMultiplier.toString(), expectedParams.rebalanceParams.positionMultiplier.toString());
    throw Error("Different position multiplier used!")
  }

  await Promise.all(expectedParams.summary.map(async (obj, i) => {
    const address = strategyInfo[obj.asset].address;

    const info: any = await indexModule.executionInfo(DPI, address);

    if (!BigNumber.from(obj.newUnit).eq(info.targetUnit)) {
      throw Error(`Target unit for ${obj.asset} is wrong should be ${obj.newUnit.toString()} instead of ${info.targetUnit}`);
    }

    if (!strategyInfo[obj.asset].maxTradeSize.eq(info.maxSize)) {
      throw Error(
        `Max trade size for ${obj.asset} is wrong should be ${strategyInfo[obj.asset].maxTradeSize.toString()} instead of ${info.maxSize}`
      );
    }

    if (strategyInfo[obj.asset].exchange != info.exchangeName) {
      throw Error(
        `Exchange for ${obj.asset} is wrong should be ${strategyInfo[obj.asset].exchange} instead of ${info.exchange}`
      );
    }

    if (!strategyInfo[obj.asset].coolOffPeriod.eq(info.coolOffPeriod)) {
      throw Error(
        `Cool off period for ${obj.asset} is wrong should be ${strategyInfo[obj.asset].coolOffPeriod.toString()} instead of ${info.coolOffPeriod}`
      );
    }
  }));
  console.log("All parameters verified!");
});