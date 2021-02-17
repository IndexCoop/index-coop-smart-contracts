import { Signer, BigNumber } from "ethers";
import { LeverageTokenSettings } from "../types";
import { FeeSplitAdapter, FlexibleLeverageStrategyAdapter } from "../contracts/index";

import { FeeSplitAdapter__factory } from "../../typechain/factories/FeeSplitAdapter__factory";
import { FlexibleLeverageStrategyAdapter__factory } from "../../typechain/factories/FlexibleLeverageStrategyAdapter__factory";
import { Address } from "hardhat-deploy/dist/types";

export default class DeployAdapters {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFeeSplitAdapter(
    manager: Address,
    streamingFeeModule: Address,
    debtIssuanceModule: Address,
    operatorFeeSplit: BigNumber,
  ): Promise<FeeSplitAdapter> {
    return await new FeeSplitAdapter__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      debtIssuanceModule,
      operatorFeeSplit
    );
  }

  public async deployFlexibleLeverageStrategyAdapter(
    leverageTokenSettings: LeverageTokenSettings
  ): Promise<FlexibleLeverageStrategyAdapter> {
    return await new FlexibleLeverageStrategyAdapter__factory(this._deployerSigner).deploy(
      leverageTokenSettings
    );
  }
}