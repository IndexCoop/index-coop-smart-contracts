import { Signer } from "ethers";
import { BigNumberish } from "@ethersproject/bignumber";
import { Address } from "../types";
import {
  Controller,
  BasicIssuanceModule,
  StreamingFeeModule,
  SetToken,
  SetTokenCreator,
  SingleIndexModule,
  StandardTokenMock
} from "../contracts/setV2";
import { WETH9 } from "../contracts/index";
import { ether } from "../common";
import { Controller__factory } from "../../typechain/factories/Controller__factory";
import { BasicIssuanceModule__factory } from "../../typechain/factories/BasicIssuanceModule__factory";
import { SingleIndexModule__factory } from "../../typechain/factories/SingleIndexModule__factory";
import { StreamingFeeModule__factory } from "../../typechain/factories/StreamingFeeModule__factory";
import { SetToken__factory } from "../../typechain/factories/SetToken__factory";
import { SetTokenCreator__factory } from "../../typechain/factories/SetTokenCreator__factory";
import { StandardTokenMock__factory } from "../../typechain/factories/StandardTokenMock__factory";
import { WETH9__factory } from "../../typechain/factories/WETH9__factory";

export default class DeploySetV2 {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployController(feeRecipient: Address): Promise<Controller> {
    return await new Controller__factory(this._deployerSigner).deploy(feeRecipient);
  }

  public async deploySetTokenCreator(controller: Address): Promise<SetTokenCreator> {
    return await new SetTokenCreator__factory(this._deployerSigner).deploy(controller);
  }

  public async deploySetToken(
    _components: Address[],
    _units: BigNumberish[],
    _modules: Address[],
    _controller: Address,
    _manager: Address,
    _name: string,
    _symbol: string,
  ): Promise<SetToken> {
    return await new SetToken__factory(this._deployerSigner).deploy(
      _components,
      _units,
      _modules,
      _controller,
      _manager,
      _name,
      _symbol,
    );
  }

  public async deployBasicIssuanceModule(controller: Address): Promise<BasicIssuanceModule> {
    return await new BasicIssuanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployStreamingFeeModule(controller: Address): Promise<StreamingFeeModule> {
    return await new StreamingFeeModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deploySingleIndexModule(
    controller: Address,
    weth: Address,
    uniswapRouter: Address,
    sushiswapRouter: Address,
    balancerProxy: Address
  ): Promise<SingleIndexModule> {
    return await new SingleIndexModule__factory(this._deployerSigner).deploy(
      controller,
      weth,
      uniswapRouter,
      sushiswapRouter,
      balancerProxy
    );
  }

  public async deployWETH(): Promise<WETH9> {
    return await new WETH9__factory(this._deployerSigner).deploy();
  }

  public async deployTokenMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    decimals: BigNumberish = 18,
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, decimals);
  }

  public async getTokenMock(token: Address): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).attach(token);
  }
}