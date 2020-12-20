import { Signer } from "ethers";
import { BigNumber } from "ethers/utils";
import { Address } from "../types";
import { IcManager } from "../contracts/index";

import { IcManagerFactory } from "../../typechain/IcManagerFactory";

export default class DeployToken {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployICManager(
    set: Address,
    indexModule: Address,
    feeModule: Address,
    operator: Address,
    methodologist: Address,
    coopFeeSplit: BigNumber
  ): Promise<IcManager> {
    return await new IcManagerFactory(this._deployerSigner).deploy(
      set,
      indexModule,
      feeModule,
      operator,
      methodologist,
      coopFeeSplit
    );
  }
}