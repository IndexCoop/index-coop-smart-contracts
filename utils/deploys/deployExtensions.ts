import { Signer, BigNumber, BigNumberish } from "ethers";
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
  FlashMintNotional,
  FlashMintLeveragedForCompound,
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
import { AaveV3LeverageStrategyExtension, AaveV3LeverageStrategyExtension__factory } from "../../typechain";
import { AirdropExtension__factory } from "../../typechain/factories/AirdropExtension__factory";
import { DEXAdapter__factory } from "../../typechain/factories/DEXAdapter__factory";
import { ExchangeIssuance__factory } from "../../typechain/factories/ExchangeIssuance__factory";
import { ExchangeIssuanceV2__factory } from "../../typechain/factories/ExchangeIssuanceV2__factory";
import { ExchangeIssuanceLeveraged__factory } from "../../typechain/factories/ExchangeIssuanceLeveraged__factory";
import { FlashMintNotional__factory } from "../../typechain/factories/FlashMintNotional__factory";
import { FlashMintLeveragedForCompound__factory } from "../../typechain/factories/FlashMintLeveragedForCompound__factory";
import { FlashMintWrapped } from "../../typechain/FlashMintWrapped";
import { FlashMintWrapped__factory } from "../../typechain/factories/FlashMintWrapped__factory";
import { ExchangeIssuanceZeroEx__factory } from "../../typechain/factories/ExchangeIssuanceZeroEx__factory";
import { FlashMintPerp__factory } from "../../typechain/factories/FlashMintPerp__factory";
import { FeeSplitExtension__factory } from "../../typechain/factories/FeeSplitExtension__factory";
import { FlexibleLeverageStrategyExtension__factory } from "../../typechain/factories/FlexibleLeverageStrategyExtension__factory";
import { GIMExtension__factory } from "../../typechain/factories/GIMExtension__factory";
import { GovernanceExtension__factory } from "../../typechain/factories/GovernanceExtension__factory";
import { FixedRebalanceExtension__factory } from "../../typechain/factories/FixedRebalanceExtension__factory";
import { StakeWiseReinvestmentExtension__factory } from "../../typechain/factories/StakeWiseReinvestmentExtension__factory";
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
    cEtherAddress: Address,
  ): Promise<FlashMintLeveragedForCompound> {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new FlashMintLeveragedForCompound__factory(
      // @ts-ignore
      {
        [linkId]: dexAdapter.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(
      {
        quickRouter: quickRouterAddress,
        sushiRouter: sushiRouterAddress,
        uniV3Router: uniV3RouterAddress,
        uniV3Quoter: uniswapV3QuoterAddress,
        curveAddressProvider: curveAddressProviderAddress,
        curveCalculator: curveCalculatorAddress,
        weth: wethAddress,
      },
      setControllerAddress,
      basicIssuanceModuleAddress,
      aaveLeveragedModuleAddress,
      aaveAddressProviderAddress,
      cEtherAddress,
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

  public async deployFlashMintNotional(
    wethAddress: Address,
    setControllerAddress: Address,
    wrappedfCashFactory: Address,
    notionalTradeModule: Address,
    quickRouter: Address,
    sushiRouter: Address,
    uniV3Router: Address,
    uniV3Quoter: Address,
    curveAddressProvider: Address,
    curveCalculator: Address,
    decodedIdGasLimit: BigNumber,
  ): Promise<FlashMintNotional> {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new FlashMintNotional__factory( // @ts-ignore
      {
        [linkId]: dexAdapter.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(
      wethAddress,
      setControllerAddress,
      wrappedfCashFactory,
      notionalTradeModule,
      quickRouter,
      sushiRouter,
      uniV3Router,
      uniV3Quoter,
      curveAddressProvider,
      curveCalculator,
      decodedIdGasLimit,
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

  public async deployStakeWiseReinvestmentExtension(
    manager: Address,
    airdropModule: Address,
    tradeModule: Address,
    settings: { exchangeName: string; exchangeCallData: string },
  ) {
    return await new StakeWiseReinvestmentExtension__factory(this._deployerSigner).deploy(
      manager,
      airdropModule,
      tradeModule,
      settings,
    );
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

  public async deployAaveV3LeverageStrategyExtension(
    manager: Address,
    contractSettings: AaveContractSettings,
    methdologySettings: MethodologySettings,
    executionSettings: ExecutionSettings,
    incentiveSettings: IncentiveSettings,
    exchangeNames: string[],
    exchangeSettings: ExchangeSettings[],
  ): Promise<AaveV3LeverageStrategyExtension> {
    return await new AaveV3LeverageStrategyExtension__factory(this._deployerSigner).deploy(
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

  public async deployFlashMintWrappedExtension(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
    setControllerAddress: Address,
    issuanceModuleAddress: Address,
    wrapModuleAddress: Address,
  ): Promise<FlashMintWrapped> {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new FlashMintWrapped__factory(
      // @ts-ignore
      {
        [linkId]: dexAdapter.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(
      {
        quickRouter: quickRouterAddress,
        sushiRouter: sushiRouterAddress,
        uniV3Router: uniV3RouterAddress,
        uniV3Quoter: uniswapV3QuoterAddress,
        curveAddressProvider: curveAddressProviderAddress,
        curveCalculator: curveCalculatorAddress,
        weth: wethAddress,
      },
      setControllerAddress,
      issuanceModuleAddress,
      wrapModuleAddress,
    );
  }

  public deployFixedRebalanceExtension(
    manager: Address,
    setToken: Address,
    notionalTradeModule: Address,
    notionalV2: Address,
    wrappedfCashFactory: Address,
    underlyingToken: Address,
    assetToken: Address,
    maturities: BigNumberish[],
    allocations: BigNumberish[],
    minPositions: BigNumberish[],
  ) {
    return new FixedRebalanceExtension__factory(this._deployerSigner).deploy(
      manager,
      setToken,
      notionalTradeModule,
      notionalV2,
      wrappedfCashFactory,
      underlyingToken,
      assetToken,
      maturities,
      allocations,
      minPositions,
    );
  }
}
