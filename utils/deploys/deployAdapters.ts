import { Signer } from "ethers";
import { Address, Bytes } from "../types";
import { FlexibleLeverageStrategyAdapter } from "../contracts/index";

import { FlexibleLeverageStrategyAdapterFactory } from "../../typechain/FlexibleLeverageStrategyAdapterFactory";

export default class DeployAdapters {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFlexibleLeverageStrategyAdapter(
    instances: Address[],
    assetDecimals: string[],
    methodologyParams: Address[],
    executionParams: Address[],
    initialExchangeName: string,
    initialExchangeData: Bytes
  ): Promise<FlexibleLeverageStrategyAdapter> {
    return await new FlexibleLeverageStrategyAdapterFactory(this._deployerSigner).deploy(
      instances,
      assetDecimals,
      methodologyParams,
      executionParams,
      initialExchangeName,
      initialExchangeData
    );
  }
}