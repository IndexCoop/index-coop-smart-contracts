import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { Address } from "../types";
import { Account } from "@utils/test/types";
import { BigNumber } from "@ethersproject/bignumber";

import {
  Uni,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";
import { UniswapV2Pair__factory } from "../../typechain/factories/UniswapV2Pair__factory";

export class UniswapFixture {
  private _deployer: DeployHelper;
  private _provider: Web3Provider | JsonRpcProvider;
  private _ownerSigner: Signer;

  public owner: Account;
  public uni: Uni;
  public factory: UniswapV2Factory;
  public pair: UniswapV2Pair;
  public router: UniswapV2Router02;

  public wethDaiPool: UniswapV2Pair;
  public wethWbtcPool: UniswapV2Pair;
  public uniWethPool: UniswapV2Pair;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._provider = provider;
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: Address, _wbtc: Address, _dai: Address): Promise<void> {
    this.owner = _owner;
    this.factory = await this._deployer.external.deployUniswapV2Factory(this.owner.address);
    this.router = await this._deployer.external.deployUniswapV2Router02(this.factory.address, _weth);

    const lastBlock = await this._provider.getBlock("latest");
    this.uni = await this._deployer.external.deployUni(
      this.owner.address,
      this.owner.address,
      BigNumber.from(lastBlock.timestamp).add(2)
    );

    this.uniWethPool = await this.createNewPair(_weth, this.uni.address);
  }

  public async createNewPair(_tokenOne: Address, _tokenTwo: Address): Promise<UniswapV2Pair> {
    await this.factory.createPair(_tokenOne, _tokenTwo);
    const poolAddress = await this.factory.allPairs((await this.factory.allPairsLength()).sub(1));
    return await new UniswapV2Pair__factory(this._ownerSigner).attach(poolAddress);
  }

  public getTokenOrder(_tokenOne: Address, _tokenTwo: Address): [Address, Address] {
    return _tokenOne.toLowerCase() < _tokenTwo.toLowerCase() ? [_tokenOne, _tokenTwo] : [_tokenTwo, _tokenOne];
  }
}