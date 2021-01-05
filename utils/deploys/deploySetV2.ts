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
import { Weth9 } from "../contracts/index";
import { ether } from "../common";
import { ControllerFactory } from "../../typechain/ControllerFactory";
import { BasicIssuanceModuleFactory } from "../../typechain/BasicIssuanceModuleFactory";
import { SingleIndexModuleFactory } from "../../typechain/SingleIndexModuleFactory";
import { StreamingFeeModuleFactory } from "../../typechain/StreamingFeeModuleFactory";
import { SetTokenFactory } from "../../typechain/SetTokenFactory";
import { SetTokenCreatorFactory } from "../../typechain/SetTokenCreatorFactory";
import { StandardTokenMockFactory } from "../../typechain/StandardTokenMockFactory";
import { Weth9Factory } from "../../typechain/Weth9Factory";

export default class DeploySetV2 {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployController(feeRecipient: Address): Promise<Controller> {
    return await new ControllerFactory(this._deployerSigner).deploy(feeRecipient);
  }

  public async deploySetTokenCreator(controller: Address): Promise<SetTokenCreator> {
    return await new SetTokenCreatorFactory(this._deployerSigner).deploy(controller);
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
    return await new SetTokenFactory(this._deployerSigner).deploy(
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
    return await new BasicIssuanceModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deployStreamingFeeModule(controller: Address): Promise<StreamingFeeModule> {
    return await new StreamingFeeModuleFactory(this._deployerSigner).deploy(controller);
  }

  public async deploySingleIndexModule(
    controller: Address,
    weth: Address,
    uniswapRouter: Address,
    sushiswapRouter: Address,
    balancerProxy: Address
  ): Promise<SingleIndexModule> {
    return await new SingleIndexModuleFactory(this._deployerSigner).deploy(
      controller,
      weth,
      uniswapRouter,
      sushiswapRouter,
      balancerProxy
    );
  }

  public async deployWETH(): Promise<Weth9> {
    return await new Weth9Factory(this._deployerSigner).deploy();
  }

  public async deployTokenMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    decimals: BigNumberish = 18,
    name: string = "Token",
    symbol: string = "Symbol"
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMockFactory(this._deployerSigner)
      .deploy(initialAccount, initialBalance, name, symbol, decimals);
  }

  public async getTokenMock(token: Address): Promise<StandardTokenMock> {
    return await new StandardTokenMockFactory(this._deployerSigner).attach(token);
  }
}