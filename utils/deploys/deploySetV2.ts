import { Signer } from "ethers";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Address } from "../types";
import { convertLibraryNameToLinkId } from "../common";
import {
  AaveLeverageModule,
  AaveV2,
  AirdropModule,
  BasicIssuanceModule,
  Compound,
  CompoundLeverageModule,
  Controller,
  ComptrollerMock,
  ContractCallerMock,
  DebtIssuanceModule,
  GeneralIndexModule,
  GovernanceModule,
  IntegrationRegistry,
  StreamingFeeModule,
  SetToken,
  SetTokenCreator,
  SingleIndexModule,
  UniswapV2ExchangeAdapter,
  WrapModule,
  SlippageIssuanceModule,
} from "../contracts/setV2";
import {
  AaveV3LeverageModule,
  AaveV3LeverageModule__factory,
  AaveV3,
  AaveV3__factory,
} from "../../typechain";
import { WETH9, StandardTokenMock } from "../contracts/index";
import { ether } from "../common";
import { AaveLeverageModule__factory } from "../../typechain/factories/AaveLeverageModule__factory";
import { AaveV2__factory } from "../../typechain/factories/AaveV2__factory";
import { AirdropModule__factory } from "../../typechain/factories/AirdropModule__factory";
import { BasicIssuanceModule__factory } from "../../typechain/factories/BasicIssuanceModule__factory";
import { Controller__factory } from "../../typechain/factories/Controller__factory";
import { Compound__factory } from "../../typechain/factories/Compound__factory";
import { CompoundLeverageModule__factory } from "../../typechain/factories/CompoundLeverageModule__factory";
import { ComptrollerMock__factory } from "../../typechain/factories/ComptrollerMock__factory";
import { ContractCallerMock__factory } from "../../typechain/factories/ContractCallerMock__factory";
import { DebtIssuanceModule__factory } from "../../typechain/factories/DebtIssuanceModule__factory";
import { GeneralIndexModule__factory } from "../../typechain/factories/GeneralIndexModule__factory";
import { GovernanceModule__factory } from "../../typechain/factories/GovernanceModule__factory";
import { IntegrationRegistry__factory } from "../../typechain/factories/IntegrationRegistry__factory";
import { SingleIndexModule__factory } from "../../typechain/factories/SingleIndexModule__factory";
import { StreamingFeeModule__factory } from "../../typechain/factories/StreamingFeeModule__factory";
import { SetToken__factory } from "../../typechain/factories/SetToken__factory";
import { SetTokenCreator__factory } from "../../typechain/factories/SetTokenCreator__factory";
import { StandardTokenMock__factory } from "../../typechain/factories/StandardTokenMock__factory";
import { UniswapV2ExchangeAdapter__factory } from "../../typechain/factories/UniswapV2ExchangeAdapter__factory";
import { WETH9__factory } from "../../typechain/factories/WETH9__factory";
import { WrapModule__factory } from "../../typechain/factories/WrapModule__factory";
import { SlippageIssuanceModule__factory } from "../../typechain/factories/SlippageIssuanceModule__factory";
import { CompoundWrapV2Adapter__factory } from "@typechain/factories/CompoundWrapV2Adapter__factory";

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

  public async deployCompoundLib(): Promise<Compound> {
    return await new Compound__factory(this._deployerSigner).deploy();
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
    cToken: Address,
  ): Promise<ComptrollerMock> {
    return await new ComptrollerMock__factory(this._deployerSigner).deploy(
      comp,
      compAmount,
      cToken,
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
    balancerProxy: Address,
  ): Promise<SingleIndexModule> {
    return await new SingleIndexModule__factory(this._deployerSigner).deploy(
      controller,
      weth,
      uniswapRouter,
      sushiswapRouter,
      balancerProxy,
    );
  }

  public async deployGeneralIndexModule(
    controller: Address,
    weth: Address,
  ): Promise<GeneralIndexModule> {
    return await new GeneralIndexModule__factory(this._deployerSigner).deploy(controller, weth);
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
    weth: Address,
  ): Promise<CompoundLeverageModule> {
    const compoundLib = await this.deployCompoundLib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/Compound.sol:Compound",
    );

    return await new CompoundLeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: compoundLib.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(controller, compToken, comptroller, cEther, weth);
  }

  public async deployGovernanceModule(controller: Address): Promise<GovernanceModule> {
    return await new GovernanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployUniswapV2ExchangeAdapter(router: Address): Promise<UniswapV2ExchangeAdapter> {
    return await new UniswapV2ExchangeAdapter__factory(this._deployerSigner).deploy(router);
  }

  public async deployTokenMock(
    initialAccount: Address,
    initialBalance: BigNumberish = ether(1000000000),
    decimals: BigNumberish = 18,
    name: string = "Token",
    symbol: string = "Symbol",
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).deploy(
      initialAccount,
      initialBalance,
      name,
      symbol,
      decimals,
    );
  }

  public async getTokenMock(token: Address): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).attach(token);
  }

  public async deployAaveV2Lib(): Promise<AaveV2> {
    return await new AaveV2__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV3Lib(): Promise<AaveV3> {
    return await new AaveV3__factory(this._deployerSigner).deploy();
  }

  public async deployAaveLeverageModule(
    controller: string,
    lendingPoolAddressesProvider: string,
    protocolDataProvider: string,
  ): Promise<AaveLeverageModule> {
    const aaveV2Lib = await this.deployAaveV2Lib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
    );

    return await new AaveLeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: aaveV2Lib.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(controller, lendingPoolAddressesProvider, protocolDataProvider);
  }

  public async deployAaveV3LeverageModule(
    controller: string,
    lendingPoolAddressesProvider: string,
  ): Promise<AaveV3LeverageModule> {
    const aaveV3Lib = await this.deployAaveV3Lib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/AaveV3.sol:AaveV3",
    );

    return await new AaveV3LeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: aaveV3Lib.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(controller, lendingPoolAddressesProvider);
  }

  public async deployAirdropModule(controller: Address): Promise<AirdropModule> {
    return await new AirdropModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployWrapModule(controller: Address, weth: Address): Promise<WrapModule> {
    return await new WrapModule__factory(this._deployerSigner).deploy(controller, weth);
  }

  public async deploySlippageIssuanceModule(controller: Address): Promise<SlippageIssuanceModule> {
    return await new SlippageIssuanceModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployCompoundWrapV2Adapter(): Promise<any> {
    const compoundLibrary = await new Compound__factory(this._deployerSigner).deploy();
    return await new CompoundWrapV2Adapter__factory(
      {
        ["__$059b1e3c35e6526bf44b3e0b6a2a76e329$__"]: compoundLibrary.address,
      },
      this._deployerSigner,
    ).deploy();
  }
}
