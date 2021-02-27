import { Signer, BigNumber } from "ethers";
import { Address, ContractSettings, MethodologySettings, ExecutionSettings, IncentiveSettings } from "../types";
import { FlexibleLeverageStrategyAdapter, FeeSplitAdapter, ExchangeIssuance } from "../contracts/index";

import { FeeSplitAdapter__factory } from "../../typechain/factories/FeeSplitAdapter__factory";
import { FlexibleLeverageStrategyAdapter__factory } from "../../typechain/factories/FlexibleLeverageStrategyAdapter__factory";
import { ExchangeIssuance__factory } from "../../typechain/factories/ExchangeIssuance__factory";

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

  public async deployFlexibleLeverageStrategyAdapter(
    manager: Address,
    contractSettings: ContractSettings,
    methdologySettings: MethodologySettings,
    executionSettings: ExecutionSettings,
    incentiveSettings: IncentiveSettings
  ): Promise<FlexibleLeverageStrategyAdapter> {
    return await new FlexibleLeverageStrategyAdapter__factory(this._deployerSigner).deploy(
      manager,
      contractSettings,
      methdologySettings,
      executionSettings,
      incentiveSettings
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
}