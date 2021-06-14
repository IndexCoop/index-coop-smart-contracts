import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { Address, Account } from "../types";
import { BigNumber } from "@ethersproject/bignumber";

import {
  Uni,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";

import { UniswapV2ExchangeAdapter } from "../contracts/setV2";
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

  public wethUsdcPool: UniswapV2Pair;
  public wethWbtcPool: UniswapV2Pair;
  public wbtcUsdcPool: UniswapV2Pair;

  public uniswapTradeAdapter: UniswapV2ExchangeAdapter;
  public uniWethPool: UniswapV2Pair;

  public weth: Address;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._provider = provider;
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(_owner: Account, _weth: Address, _wbtc: Address, _usdc: Address, minimumInit = false): Promise<void> {
    this.owner = _owner;
    this.factory = await this._deployer.external.deployUniswapV2Factory(this.owner.address);
    this.router = await this._deployer.external.deployUniswapV2Router02(this.factory.address, _weth);

    this.uniswapTradeAdapter = await this._deployer.setV2.deployUniswapV2ExchangeAdapter(this.router.address);

    // If we only want strict control over what pools are created, exit here.
    if (minimumInit) return;

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
