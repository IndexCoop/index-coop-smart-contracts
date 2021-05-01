import { BigNumber } from "ethers";
import { Address } from "../../utils/types";

import DeployHelper from "../../utils/deploys";
import { StandardTokenMock } from "../../utils/contracts/index";

export async function getTokenDecimals(
  deployHelper: DeployHelper,
  component: Address,
): Promise<BigNumber> {
  const componentInstance: StandardTokenMock = await deployHelper.setV2.getTokenMock(component);
  return BigNumber.from(10).pow(await componentInstance.decimals());
}