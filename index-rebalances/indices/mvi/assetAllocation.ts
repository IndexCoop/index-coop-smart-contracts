import { ZERO, PRECISE_UNIT } from "../../../utils/constants";
import { ether, preciseDiv, preciseMul } from "../../../utils/common/index";
import { BigNumber, Signer } from 'ethers';

import { RebalanceSummary, StrategyObject } from "../../types";
import { SetToken } from "../../../utils/contracts/setV2";
import { StandardTokenMock } from "../../../utils/contracts/index";
import DeployHelper from "../../../utils/deploys";

export async function calculateNewAllocations(
  owner: Signer,
  setToken: SetToken,
  strategyConstants: StrategyObject,
  setValue: BigNumber,
): Promise<RebalanceSummary[]> {
  let rebalanceData: RebalanceSummary[] = [];

  let deployHelper: DeployHelper = new DeployHelper(owner);

  const totalSupply = await setToken.totalSupply();
  for (let i = 0; i < Object.keys(strategyConstants).length; i++) {
    const key = Object.keys(strategyConstants)[i];
    const assetObj = strategyConstants[key];
    const component: StandardTokenMock = await deployHelper.setV2.getTokenMock(assetObj.address);

    const componentDecimals = BigNumber.from(10**(await component.decimals()));
    const componentValue = preciseMul(setValue, assetObj.allocation);
    const newUnit = componentDecimals.mul(componentValue).div(assetObj.price);
    console.log(newUnit.toString());
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
      coolOffPeriod:assetObj.coolOffPeriod,
    });
  }
  return rebalanceData;
}