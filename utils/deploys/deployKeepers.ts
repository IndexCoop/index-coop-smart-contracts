import { Signer } from "ethers";

import { FeeClaimKeeper } from "../contracts/index";

import { FeeClaimKeeper__factory } from "../../typechain/factories/FeeClaimKeeper__factory";

export default class DeployKeepers {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFeeClaimKeeper(): Promise<FeeClaimKeeper> {
    return await new FeeClaimKeeper__factory(this._deployerSigner).deploy();
  }
}