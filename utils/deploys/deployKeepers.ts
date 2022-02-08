import { FliRebalanceKeeper } from "../../typechain/FliRebalanceKeeper";
import { FliRebalanceKeeper__factory } from "../../typechain/factories/FliRebalanceKeeper__factory";
import { Address } from "../types";
import { Signer } from "ethers";

export default class DeployKeepers {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFliRebalanceKeeper(
    fliExtension: Address,
    registry: Address,
  ): Promise<FliRebalanceKeeper> {
    return new FliRebalanceKeeper__factory(this._deployerSigner).deploy(fliExtension, registry);
  }
}
