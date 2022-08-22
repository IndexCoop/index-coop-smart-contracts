import { Signer, BigNumber } from "ethers";
import {
  Address,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings,
  AaveContractSettings,
} from "../types";
import {
  AaveLeverageStrategyExtension,
  AirdropExtension,
  DEXAdapter,
  ExchangeIssuance,
  ExchangeIssuanceV2,
  ExchangeIssuanceLeveraged,
  ExchangeIssuanceLeveragedForCompound,
  ExchangeIssuanceZeroEx,
  FlashMintPerp,
  FlexibleLeverageStrategyExtension,
  FeeSplitExtension,
  GIMExtension,
  GovernanceExtension,
  StreamingFeeSplitExtension,
  WrapExtension,
} from "../contracts/index";
import { convertLibraryNameToLinkId } from "../common";

import { AaveLeverageStrategyExtension__factory } from "../../typechain/factories/AaveLeverageStrategyExtension__factory";
import { AirdropExtension__factory } from "../../typechain/factories/AirdropExtension__factory";
import { DEXAdapter__factory } from "../../typechain/factories/DEXAdapter__factory";
import { ExchangeIssuance__factory } from "../../typechain/factories/ExchangeIssuance__factory";
import { ExchangeIssuanceV2__factory } from "../../typechain/factories/ExchangeIssuanceV2__factory";
import { ExchangeIssuanceLeveraged__factory } from "../../typechain/factories/ExchangeIssuanceLeveraged__factory";
import { ExchangeIssuanceLeveragedForCompound__factory } from "../../typechain/factories/ExchangeIssuanceLeveragedForCompound__factory";
import { ExchangeIssuanceZeroEx__factory } from "../../typechain/factories/ExchangeIssuanceZeroEx__factory";
import { FlashMintPerp__factory } from "../../typechain/factories/FlashMintPerp__factory";
import { FeeSplitExtension__factory } from "../../typechain/factories/FeeSplitExtension__factory";
import { FlexibleLeverageStrategyExtension__factory } from "../../typechain/factories/FlexibleLeverageStrategyExtension__factory";
import { GIMExtension__factory } from "../../typechain/factories/GIMExtension__factory";
import { GovernanceExtension__factory } from "../../typechain/factories/GovernanceExtension__factory";
import { StreamingFeeSplitExtension__factory } from "../../typechain/factories/StreamingFeeSplitExtension__factory";
import { WrapExtension__factory } from "../../typechain/factories/WrapExtension__factory";

export default class DeployExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployFeeSplitExtension(
    manager: Address,
    streamingFeeModule: Address,
    debtIssuanceModule: Address,
    operatorFeeSplit: BigNumber,
    operatorFeeRecipient: Address,
  ): Promise<FeeSplitExtension> {
    return await new FeeSplitExtension__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      debtIssuanceModule,
      operatorFeeSplit,
      operatorFeeRecipient,
    );
  }

  public async deployStreamingFeeSplitExtension(
    manager: Address,
    streamingFeeModule: Address,
    operatorFeeSplit: BigNumber,
    operatorFeeRecipient: Address,
  ): Promise<StreamingFeeSplitExtension> {
    return await new StreamingFeeSplitExtension__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      operatorFeeSplit,
      operatorFeeRecipient,
    );
  }

  public async deployGovernanceExtension(
    manager: Address,
    governanceModule: Address,
  ): Promise<GovernanceExtension> {
    return await new GovernanceExtension__factory(this._deployerSigner).deploy(
      manager,
      governanceModule,
    );
  }

  public async deployGIMExtension(
    manager: Address,
    generalIndexModule: Address,
  ): Promise<GIMExtension> {
    return await new GIMExtension__factory(this._deployerSigner).deploy(
      manager,
      generalIndexModule,
    );
  }

  public async deployFlexibleLeverageStrategyExtension(
    manager: Address,
    contractSettings: ContractSettings,
    methdologySettings: MethodologySettings,
    executionSettings: ExecutionSettings,
    incentiveSettings: IncentiveSettings,
    exchangeNames: string[],
    exchangeSettings: ExchangeSettings[],
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
      basicIssuanceModuleAddress,
    );
  }

  public async deployExchangeIssuanceV2(
    wethAddress: Address,
    quickSwapFactoryAddress: Address,
    quickSwapRouterAddress: Address,
    sushiFactoryAddress: Address,
    sushiRouterAddress: Address,
    setControllerAddress: Address,
    basicIssuanceModuleAddress: Address,
  ): Promise<ExchangeIssuanceV2> {
    return await new ExchangeIssuanceV2__factory(this._deployerSigner).deploy(
      wethAddress,
      quickSwapFactoryAddress,
      quickSwapRouterAddress,
      sushiFactoryAddress,
      sushiRouterAddress,
      setControllerAddress,
      basicIssuanceModuleAddress,
    );
  }

  public async deployDEXAdapter(): Promise<DEXAdapter> {
    return await new DEXAdapter__factory(this._deployerSigner).deploy();
  }

  public async deployExchangeIssuanceLeveraged(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    setControllerAddress: Address,
    basicIssuanceModuleAddress: Address,
    aaveLeveragedModuleAddress: Address,
    aaveAddressProviderAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
  ): Promise<ExchangeIssuanceLeveraged> {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new ExchangeIssuanceLeveraged__factory(
      // @ts-ignore
      {
        [linkId]: dexAdapter.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(
      wethAddress,
      quickRouterAddress,
      sushiRouterAddress,
      uniV3RouterAddress,
      uniswapV3QuoterAddress,
      setControllerAddress,
      basicIssuanceModuleAddress,
      aaveLeveragedModuleAddress,
      aaveAddressProviderAddress,
      curveCalculatorAddress,
      curveAddressProviderAddress,
    );
  }

  public async deployExchangeIssuanceLeveragedForCompound(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    setControllerAddress: Address,
    basicIssuanceModuleAddress: Address,
    aaveLeveragedModuleAddress: Address,
    aaveAddressProviderAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
  ): Promise<ExchangeIssuanceLeveragedForCompound> {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new ExchangeIssuanceLeveragedForCompound__factory(
      // @ts-ignore
      {
        [linkId]: dexAdapter.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(
      wethAddress,
      quickRouterAddress,
      sushiRouterAddress,
      uniV3RouterAddress,
      uniswapV3QuoterAddress,
      setControllerAddress,
      basicIssuanceModuleAddress,
      aaveLeveragedModuleAddress,
      aaveAddressProviderAddress,
      curveCalculatorAddress,
      curveAddressProviderAddress,
    );
  }

  public async deployExchangeIssuanceZeroEx(
    wethAddress: Address,
    setControllerAddress: Address,
    swapTarget: Address,
  ): Promise<ExchangeIssuanceZeroEx> {
    return await new ExchangeIssuanceZeroEx__factory(this._deployerSigner).deploy(
      wethAddress,
      setControllerAddress,
      swapTarget,
    );
  }

  public async deployFlashMintPerp(
    uniV3Router: Address,
    uniV3Quoter: Address,
    slippageIssuanceModule: Address,
    usdcAddress: Address,
  ): Promise<FlashMintPerp> {
    return await new FlashMintPerp__factory(this._deployerSigner).deploy(
      uniV3Router,
      uniV3Quoter,
      slippageIssuanceModule,
      usdcAddress,
    );
  }

  public async deployAirdropExtension(
    manager: Address,
    airdropModule: Address,
  ): Promise<AirdropExtension> {
    return await new AirdropExtension__factory(this._deployerSigner).deploy(manager, airdropModule);
  }

  public async deployAaveLeverageStrategyExtension(
    manager: Address,
    contractSettings: AaveContractSettings,
    methdologySettings: MethodologySettings,
    executionSettings: ExecutionSettings,
    incentiveSettings: IncentiveSettings,
    exchangeNames: string[],
    exchangeSettings: ExchangeSettings[],
  ): Promise<AaveLeverageStrategyExtension> {
    return await new AaveLeverageStrategyExtension__factory(this._deployerSigner).deploy(
      manager,
      contractSettings,
      methdologySettings,
      executionSettings,
      incentiveSettings,
      exchangeNames,
      exchangeSettings,
    );
  }

  public async deployWrapExtension(manager: Address, wrapModule: Address): Promise<WrapExtension> {
    return await new WrapExtension__factory(this._deployerSigner).deploy(manager, wrapModule);
  }
}
