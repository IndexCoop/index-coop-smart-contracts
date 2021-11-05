import DeployHelper from "../deploys";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { Signer } from "ethers";
import { Address } from "../types";

import {
  ZeroEx,
  InitialMigration,
  OwnableFeature,
  UniswapV3Feature,
  SimpleFunctionRegistryFeature,
} from "../contracts/zeroEx";

export class ZeroExFixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public zeroEx: ZeroEx;
  public migrator: InitialMigration;
  public registryFeature: SimpleFunctionRegistryFeature;
  public ownableFeature: OwnableFeature;
  public uniswapV3Feature: UniswapV3Feature;

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
   * Deploys exchange proxy and adds bootstrap features
   *
   */
  public async initialize(ownerAddress: Address): Promise<void> {
    this.migrator = await this._deployer.external.deployInitialMigration(ownerAddress);
    this.zeroEx = await this._deployer.external.deployZeroEx(this.migrator.address);
    this.registryFeature = await this._deployer.external.deploySimpleFunctionRegistryFeature();
    this.ownableFeature = await this._deployer.external.deployOwnableFeature();
    const features = {
      registry: this.registryFeature.address,
      ownable: this.ownableFeature.address,
    };
    await this.zeroEx.deployed();
    await this.migrator.deployed();
    await this.registryFeature.deployed();
    await this.ownableFeature.deployed();
    await this.migrator.initializeZeroEx(ownerAddress, this.zeroEx.address, features);
  }

  public async registerUniswapV3Feature(
    weth: Address,
    uniFactory: Address,
    poolInitCodeHash: string,
  ): Promise<void> {
    this.uniswapV3Feature = await this._deployer.external.deployUniswapV3Feature(
      weth,
      uniFactory,
      poolInitCodeHash,
    );
    const registry = this.registryFeature.attach(this.zeroEx.address);
    const selector = this.uniswapV3Feature.interface.getSighash("sellTokenForTokenToUniswapV3");
    await registry.extend(selector, this.uniswapV3Feature.address);
  }
}
