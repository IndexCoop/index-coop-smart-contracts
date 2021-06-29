import { Signer, BigNumber } from "ethers";
import { Address, ContractSettings, MethodologySettings, ExecutionSettings, IncentiveSettings, ExchangeSettings } from "../types";
import {
  ExchangeIssuance,
  ExchangeIssuanceV2,
  FlexibleLeverageStrategyExtension,
  FeeSplitAdapter,
  GovernanceAdapter
} from "../contracts/index";

import { ExchangeIssuance__factory } from "../../typechain/factories/ExchangeIssuance__factory";
import { ExchangeIssuanceV2__factory } from "../../typechain/factories/ExchangeIssuanceV2__factory";
import { FeeSplitAdapter__factory } from "../../typechain/factories/FeeSplitAdapter__factory";
import { FlexibleLeverageStrategyExtension__factory } from "../../typechain/factories/FlexibleLeverageStrategyExtension__factory";
import { GovernanceAdapter__factory } from "../../typechain/factories/GovernanceAdapter__factory";

export default class DeployAdapters {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFeeSplitAdapter(
    manager: Address,
    streamingFeeModule: Address,
    debtIssuanceModule: Address,
    operatorFeeSplit: BigNumber,
  ): Promise<FeeSplitAdapter> {
    return await new FeeSplitAdapter__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      debtIssuanceModule,
      operatorFeeSplit
    );
  }

  public async deployGovernanceAdapter(
    manager: Address,
    governanceModule: Address,
  ): Promise<GovernanceAdapter> {
    return await new GovernanceAdapter__factory(this._deployerSigner).deploy(
      manager,
      governanceModule
    );
  }

  public async deployFlexibleLeverageStrategyExtension(
    manager: Address,
    contractSettings: ContractSettings,
    methdologySettings: MethodologySettings,
    executionSettings: ExecutionSettings,
    incentiveSettings: IncentiveSettings,
    exchangeNames: string[],
    exchangeSettings: ExchangeSettings[]
  ): Promise<FlexibleLeverageStrategyExtension> {
    return await new FlexibleLeverageStrategyExtension__factory(this._deployerSigner).deploy(
      manager,
      contractSettings,
      methdologySettings,
      executionSettings,
      incentiveSettings,
      exchangeNames,
      exchangeSettings,
    );
  }

  public async deployExchangeIssuance(
    wethAddress: Address,
    uniFactoryAddress: Address,
    uniRouterAddress: Address,
    sushiFactoryAddress: Address,
    sushiRouterAddress: Address,
    setControllerAddress: Address,
    basicIssuanceModuleAddress: Address,
  ): Promise<ExchangeIssuance> {
    return await new ExchangeIssuance__factory(this._deployerSigner).deploy(
      wethAddress,
      uniFactoryAddress,
      uniRouterAddress,
      sushiFactoryAddress,
      sushiRouterAddress,
      setControllerAddress,
      basicIssuanceModuleAddress
    );
  }

  public async deployExchangeIssuanceV2(
    wethAddress: Address,
    uniFactoryAddress: Address,
    uniRouterAddress: Address,
    sushiFactoryAddress: Address,
    sushiRouterAddress: Address,
    setControllerAddress: Address,
    basicIssuanceModuleAddress: Address,
  ): Promise<ExchangeIssuanceV2> {
    return await new ExchangeIssuanceV2__factory(this._deployerSigner).deploy(
      wethAddress,
      uniFactoryAddress,
      uniRouterAddress,
      sushiFactoryAddress,
      sushiRouterAddress,
      setControllerAddress,
      basicIssuanceModuleAddress
    );
  }
}