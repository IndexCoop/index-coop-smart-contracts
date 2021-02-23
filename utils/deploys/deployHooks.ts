import { Signer, BigNumber } from "ethers";
import { Address } from "../types";
import { SupplyCapIssuanceHook } from "../contracts/index";

import { SupplyCapIssuanceHook__factory } from "../../typechain/factories/SupplyCapIssuanceHook__factory";

export default class DeployHooks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deploySupplyCapIssuanceHook(
    initialOwner: Address,
    supplyCap: BigNumber
  ): Promise<SupplyCapIssuanceHook> {
    return await new SupplyCapIssuanceHook__factory(this._deployerSigner).deploy(initialOwner, supplyCap);
  }
}