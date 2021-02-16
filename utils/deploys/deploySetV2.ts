import { Signer } from "ethers";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Address } from "../types";
import {
  CompoundLeverageModule,
  Controller,
  ComptrollerMock,
  ContractCallerMock,
  DebtIssuanceModule,
  BasicIssuanceModule,
  IntegrationRegistry,
  StreamingFeeModule,
  SetToken,
  SetTokenCreator,
  SingleIndexModule
} from "../contracts/setV2";
import { WETH9, StandardTokenMock } from "../contracts/index";
import { ether } from "../common";
import { Controller__factory } from "../../typechain/factories/Controller__factory";
import { CompoundLeverageModule__factory } from "../../typechain/factories/CompoundLeverageModule__factory";
import { ComptrollerMock__factory } from "../../typechain/factories/ComptrollerMock__factory";
import { ContractCallerMock__factory } from "../../typechain/factories/ContractCallerMock__factory";
import { DebtIssuanceModule__factory } from "../../typechain/factories/DebtIssuanceModule__factory";
import { IntegrationRegistry__factory } from "../../typechain/factories/IntegrationRegistry__factory";
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

  public async deployContractCallerMock(): Promise<ContractCallerMock> {
    return await new ContractCallerMock__factory(this._deployerSigner).deploy();
  }

  public async deployComptrollerMock(
    comp: Address,
    compAmount: BigNumber,
    cToken: Address
  ): Promise<ComptrollerMock> {
    return await new ComptrollerMock__factory(this._deployerSigner).deploy(
      comp,
      compAmount,
      cToken
    );
  }

  public async deployDebtIssuanceModule(controller: Address): Promise<DebtIssuanceModule> {
    return await new DebtIssuanceModule__factory(this._deployerSigner).deploy(controller);
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

  public async deployIntegrationRegistry(controller: Address): Promise<IntegrationRegistry> {
    return await new IntegrationRegistry__factory(this._deployerSigner).deploy(controller);
  }

  public async deployCompoundLeverageModule(
    controller: Address,
    compToken: Address,
    comptroller: Address,
    cEther: Address,
    weth: Address
  ): Promise<CompoundLeverageModule> {
    return await new CompoundLeverageModule__factory(this._deployerSigner).deploy(
      controller,
      compToken,
      comptroller,
      cEther,
      weth
    );
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