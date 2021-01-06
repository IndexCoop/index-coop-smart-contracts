import { Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "../types";
import { ICManager } from "../contracts/index";

import { ICManager__factory } from "../../typechain/factories/ICManager__factory";

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
  ): Promise<ICManager> {
    return await new ICManager__factory(this._deployerSigner).deploy(
      set,
      indexModule,
      feeModule,
      operator,
      methodologist,
      coopFeeSplit
    );
  }
}