import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { Address } from "../types";

import {
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";

import { UniswapV2ExchangeAdapter } from "../contracts/setV2";
import { UniswapV2Pair__factory } from "../../typechain/factories/UniswapV2Pair__factory";

export class UniswapFixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public owner: Address;
  public factory: UniswapV2Factory;
  public pair: UniswapV2Pair;
  public router: UniswapV2Router02;

  public wethUsdcPool: UniswapV2Pair;
  public wethWbtcPool: UniswapV2Pair;
  public wbtcUsdcPool: UniswapV2Pair;

  public uniswapTradeAdapter: UniswapV2ExchangeAdapter;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Address, _weth: Address, _wbtc: Address, _usdc: Address): Promise<void> {
    this.owner = _owner;
    this.factory = await this._deployer.external.deployUniswapV2Factory(this.owner);
    this.router = await this._deployer.external.deployUniswapV2Router02(this.factory.address, _weth);

    this.wethUsdcPool = await this.createNewPair(_weth, _usdc);
    this.wethWbtcPool = await this.createNewPair(_weth, _wbtc);
    this.wbtcUsdcPool = await this.createNewPair(_wbtc, _usdc);

    this.uniswapTradeAdapter = await this._deployer.setV2.deployUniswapV2ExchangeAdapter(this.router.address);
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