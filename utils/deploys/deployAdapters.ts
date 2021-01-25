import { Signer } from "ethers";
import { Bytes } from "../types";
import { FlexibleLeverageStrategyAdapter } from "../contracts/index";

import { FlexibleLeverageStrategyAdapter__factory } from "../../typechain/factories/FlexibleLeverageStrategyAdapter__factory";

export default class DeployAdapters {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFlexibleLeverageStrategyAdapter(
    instances: any,
    assetDecimals: any,
    methodologyParams: any,
    executionParams: any,
    incentiveParams: any,
    initialExchangeName: string,
    initialExchangeData: Bytes
  ): Promise<FlexibleLeverageStrategyAdapter> {
    return await new FlexibleLeverageStrategyAdapter__factory(this._deployerSigner).deploy(
      instances,
      assetDecimals,
      methodologyParams,
      executionParams,
      incentiveParams,
      initialExchangeName,
      initialExchangeData
    );
  }
}