import { Signer } from "ethers";
import { Address } from "../types";
import { MutualUpgradeMock } from "../contracts/index";

import { MutualUpgradeMock__factory } from "../../typechain/factories/MutualUpgradeMock__factory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployMutualUpgradeMock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMock__factory(this._deployerSigner).deploy(owner, methodologist);
  }
}
