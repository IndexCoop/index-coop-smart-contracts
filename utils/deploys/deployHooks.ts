import { Signer, BigNumber } from "ethers";
import { Address } from "../types";

import {
  AirdropIssuanceHook,
  SupplyCapAllowedCallerIssuanceHook,
  SupplyCapIssuanceHook
} from "../contracts/index";

import { AirdropIssuanceHook__factory } from "../../typechain/factories/AirdropIssuanceHook__factory";
import { SupplyCapAllowedCallerIssuanceHook__factory } from "../../typechain/factories/SupplyCapAllowedCallerIssuanceHook__factory";
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

  public async deploySupplyCapAllowedCallerIssuanceHook(
    initialOwner: Address,
    supplyCap: BigNumber
  ): Promise<SupplyCapAllowedCallerIssuanceHook> {
    return await new SupplyCapAllowedCallerIssuanceHook__factory(this._deployerSigner).deploy(initialOwner, supplyCap);
  }

  public async deployAirdropIssuanceHook(airdropModule: Address): Promise<AirdropIssuanceHook> {
    return await new AirdropIssuanceHook__factory(this._deployerSigner).deploy(airdropModule);
  }
}