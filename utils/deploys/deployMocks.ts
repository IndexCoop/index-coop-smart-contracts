import { Signer } from "ethers";
import { Address } from "../types";
import { MutualUpgradeMock } from "../contracts/index";

import { MutualUpgradeMockFactory } from "../../typechain/MutualUpgradeMockFactory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployMutualUpgradeMock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMockFactory(this._deployerSigner).deploy(owner, methodologist);
  }
}
