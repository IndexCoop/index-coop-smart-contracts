import { Signer } from "ethers";

import { ManagerCore } from "../contracts/index";
import { ManagerCore__factory } from "../../typechain/factories/ManagerCore__factory";

export default class DeployFactories {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployManagerCore(): Promise<ManagerCore> {
    return await new ManagerCore__factory(this._deployerSigner).deploy();
  }
}
