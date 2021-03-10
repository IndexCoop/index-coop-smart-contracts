import { Signer } from "ethers";
import { Address } from "../types";
import { FLIRebalanceViewer } from "../contracts/index";

import { FLIRebalanceViewer__factory } from "../../typechain/factories/FLIRebalanceViewer__factory";

export default class DeployViewers {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFLIRebalanceViewer(
    uniswapRouter: Address,
    strategyAdapter: Address,
    cEther: Address
  ): Promise<FLIRebalanceViewer> {
    return await new FLIRebalanceViewer__factory(this._deployerSigner).deploy(uniswapRouter, strategyAdapter, cEther);
  }
}