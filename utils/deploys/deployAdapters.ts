import { Signer } from "ethers";
import { LeverageTokenSettings } from "../types";
import { FlexibleLeverageStrategyAdapter } from "../contracts/index";

import { FlexibleLeverageStrategyAdapter__factory } from "../../typechain/factories/FlexibleLeverageStrategyAdapter__factory";

export default class DeployAdapters {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFlexibleLeverageStrategyAdapter(
    leverageTokenSettings: LeverageTokenSettings
  ): Promise<FlexibleLeverageStrategyAdapter> {
    return await new FlexibleLeverageStrategyAdapter__factory(this._deployerSigner).deploy(
      leverageTokenSettings
    );
  }
}