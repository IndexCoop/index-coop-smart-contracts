import DeployHelper from "../deploys";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import {  Signer } from "ethers";
import { Address } from "../types";

import { ZeroEx } from "../contracts/zeroEx";


export class ZeroExFixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public zeroEx: ZeroEx;

  /**
   * Instantiates a new ZeroExFixture
   *
   * @param provider      the ethers web3 provider to use
   * @param ownerAddress  the address of the owner
   */
  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  /**
   * Deploys contracts and creates weth-dai and weth-wbtc pools
   *
   * @param _owner  the owner of the deployed Uniswap V3 system
   * @param _weth   weth address
   * @param _wbtc   wbtc address
   * @param _dai    dai address
   */
  public async initialize(
  ): Promise<void> {
      this.zeroEx = await this._deployer.external.deployZeroEx();
  }
}
