import { Signer } from "ethers";
import { Address } from "../types";
import { SimpleCompoundErc20FLIArb } from "../contracts/index";

import { SimpleCompoundErc20FLIArb__factory } from "../../typechain/factories/SimpleCompoundErc20FLIArb__factory";

export default class DeployBots {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deploySimpleCompoundErc20FLIArb(
    soloMargin: Address,
    router: Address,
    debtIssuanceModule: Address,
    weth: Address,
    factory: Address,
    indexCoopTreasury: Address
  ): Promise<SimpleCompoundErc20FLIArb> {
    return await new SimpleCompoundErc20FLIArb__factory(this._deployerSigner).deploy(
      soloMargin,
      router,
      debtIssuanceModule,
      weth,
      factory,
      indexCoopTreasury
    );
  }
}