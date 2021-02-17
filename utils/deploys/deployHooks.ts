import { Signer, BigNumber } from "ethers";
import { FLIIssuanceHook } from "../contracts/index";

import { FLIIssuanceHook__factory } from "../../typechain/factories/FLIIssuanceHook__factory";

export default class DeployHooks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFLIIssuanceHook(supplyCap: BigNumber): Promise<FLIIssuanceHook> {
    return await new FLIIssuanceHook__factory(this._deployerSigner).deploy(supplyCap);
  }
}