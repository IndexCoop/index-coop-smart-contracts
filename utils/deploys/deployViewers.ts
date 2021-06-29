import { Signer } from "ethers";
import { Address } from "../types";
import { FLIRebalanceViewer } from "../contracts";

import { FLIRebalanceViewer__factory } from "../../typechain/factories/FLIRebalanceViewer__factory";

export default class DeployViewers {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFLIRebalanceViewer(
    fliStrategyExtension: Address,
    uniswapV3Quoter: Address,
    uniswapV2Router: Address,
    uniswapV3Name: string,
    uniswapV2Name: string
  ): Promise<FLIRebalanceViewer> {
    return await new FLIRebalanceViewer__factory(this._deployerSigner).deploy(
      fliStrategyExtension,
      uniswapV3Quoter,
      uniswapV2Router,
      uniswapV3Name,
      uniswapV2Name
    );
  }
}
