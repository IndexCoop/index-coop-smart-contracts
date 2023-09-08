import { Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "../types";
import { ICManager, BaseManager, BaseManagerV2, DelegatedManager } from "../contracts/index";

import { ICManager__factory } from "../../typechain/factories/ICManager__factory";
import { BaseManager__factory } from "../../typechain/factories/BaseManager__factory";
import { BaseManagerV2__factory } from "../../typechain/factories/BaseManagerV2__factory";
import { DelegatedManager__factory } from "../../typechain/factories/DelegatedManager__factory";

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

  public async deployBaseManager(
    set: Address,
    operator: Address,
    methodologist: Address
  ): Promise<BaseManager> {
    return await new BaseManager__factory(this._deployerSigner).deploy(
      set,
      operator,
      methodologist
    );
  }

  public async deployBaseManagerV2(
    set: Address,
    operator: Address,
    methodologist: Address
  ): Promise<BaseManagerV2> {
    return await new BaseManagerV2__factory(this._deployerSigner).deploy(
      set,
      operator,
      methodologist
    );
  }

  public async deployDelegatedManager(
    setToken: Address,
    factory: Address,
    methodologist: Address,
    extensions: Address[],
    operators: Address[],
    allowedAssets: Address[],
    useAssetAllowlist: boolean
  ): Promise<DelegatedManager> {
    return await new DelegatedManager__factory(this._deployerSigner).deploy(
      setToken,
      factory,
      methodologist,
      extensions,
      operators,
      allowedAssets,
      useAssetAllowlist
    );
  }

  /* GETTERS */

  public async getDelegatedManager(managerAddress: Address): Promise<DelegatedManager> {
    return await new DelegatedManager__factory(this._deployerSigner).attach(managerAddress);
  }
}
