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
  AuctionRebalanceExtension,
  DEXAdapter,
  DEXAdapterV2,
  ExchangeIssuance,
  ExchangeIssuanceV2,
  ExchangeIssuanceLeveraged,
  FlashMintNotional,
  FlashMintLeveragedForCompound,
  ExchangeIssuanceZeroEx,
  FlashMintPerp,
  FlexibleLeverageStrategyExtension,
  FeeSplitExtension,
  PrtFeeSplitExtension,
  GIMExtension,
  GovernanceExtension,
  MigrationExtension,
  OptimisticAuctionRebalanceExtensionV1,
  StreamingFeeSplitExtension,
  WrapExtension,
  TargetWeightWrapExtension,
} from "../contracts/index";
import { convertLibraryNameToLinkId } from "../common";

import { AaveLeverageStrategyExtension__factory } from "../../typechain/factories/AaveLeverageStrategyExtension__factory";
import {
  AaveV3LeverageStrategyExtension,
  AaveV3LeverageStrategyExtension__factory,
  FlashMintLeveragedExtended__factory,
  MorphoLeverageStrategyExtension,
  MorphoLeverageStrategyExtension__factory,
} from "../../typechain";
import { AirdropExtension__factory } from "../../typechain/factories/AirdropExtension__factory";
import { AuctionRebalanceExtension__factory } from "../../typechain/factories/AuctionRebalanceExtension__factory";
import { DEXAdapter__factory } from "../../typechain/factories/DEXAdapter__factory";
import { DEXAdapterV2__factory } from "../../typechain/factories/DEXAdapterV2__factory";
import { ExchangeIssuance__factory } from "../../typechain/factories/ExchangeIssuance__factory";
import { ExchangeIssuanceV2__factory } from "../../typechain/factories/ExchangeIssuanceV2__factory";
import { ExchangeIssuanceLeveraged__factory } from "../../typechain/factories/ExchangeIssuanceLeveraged__factory";
import { FlashMintHyETH__factory } from "../../typechain/factories/FlashMintHyETH__factory";
import { FlashMintHyETHV2__factory } from "../../typechain/factories/FlashMintHyETHV2__factory";
import { FlashMintLeveraged__factory } from "../../typechain/factories/FlashMintLeveraged__factory";
import { FlashMintNotional__factory } from "../../typechain/factories/FlashMintNotional__factory";
import { FlashMintLeveragedForCompound__factory } from "../../typechain/factories/FlashMintLeveragedForCompound__factory";
import { FlashMintWrapped } from "../../typechain/FlashMintWrapped";
import { FlashMintWrapped__factory } from "../../typechain/factories/FlashMintWrapped__factory";
import { ExchangeIssuanceZeroEx__factory } from "../../typechain/factories/ExchangeIssuanceZeroEx__factory";
import { FlashMintDex__factory } from "../../typechain/factories/FlashMintDex__factory";
import { FlashMintNAV__factory } from "../../typechain/factories/FlashMintNAV__factory";
import { FlashMintPerp__factory } from "../../typechain/factories/FlashMintPerp__factory";
import { FeeSplitExtension__factory } from "../../typechain/factories/FeeSplitExtension__factory";
import { PrtFeeSplitExtension__factory } from "../../typechain/factories/PrtFeeSplitExtension__factory";
import { FlexibleLeverageStrategyExtension__factory } from "../../typechain/factories/FlexibleLeverageStrategyExtension__factory";
import { GIMExtension__factory } from "../../typechain/factories/GIMExtension__factory";
import { GovernanceExtension__factory } from "../../typechain/factories/GovernanceExtension__factory";
import { FixedRebalanceExtension__factory } from "../../typechain/factories/FixedRebalanceExtension__factory";
import { MigrationExtension__factory } from "../../typechain/factories/MigrationExtension__factory";
import { OptimisticAuctionRebalanceExtensionV1__factory } from "../../typechain/factories/OptimisticAuctionRebalanceExtensionV1__factory";
import { StakeWiseReinvestmentExtension__factory } from "../../typechain/factories/StakeWiseReinvestmentExtension__factory";
import { StreamingFeeSplitExtension__factory } from "../../typechain/factories/StreamingFeeSplitExtension__factory";
import { WrapExtension__factory } from "../../typechain/factories/WrapExtension__factory";
import { TargetWeightWrapExtension__factory } from "../../typechain/factories/TargetWeightWrapExtension__factory";

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

  public async deployPrtFeeSplitExtension(
    manager: Address,
    streamingFeeModule: Address,
    debtIssuanceModule: Address,
    operatorFeeSplit: BigNumber,
    operatorFeeRecipient: Address,
    prt: Address,
  ): Promise<PrtFeeSplitExtension> {
    return await new PrtFeeSplitExtension__factory(this._deployerSigner).deploy(
      manager,
      streamingFeeModule,
      debtIssuanceModule,
      operatorFeeSplit,
      operatorFeeRecipient,
      prt,
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

  public async deployDEXAdapterV2(): Promise<DEXAdapterV2> {
    return await new DEXAdapterV2__factory(this._deployerSigner).deploy();
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

  public async deployFlashMintLeveragedExtended(
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
    BalancerV2VaultAddress: Address,
  ) {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new FlashMintLeveragedExtended__factory(
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
      BalancerV2VaultAddress,
    );
  }
  public async deployFlashMintLeveraged(
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
    BalancerV2VaultAddress: Address,
  ) {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new FlashMintLeveraged__factory(
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
      BalancerV2VaultAddress,
    );
  }

  public async deployFlashMintHyETHV2(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
    setControllerAddress: Address,
    debtIssuanceModuleAddress: Address,
    stETHAddress: Address,
    curveStEthEthPoolAddress: Address,
  ) {
    const dexAdapter = await this.deployDEXAdapterV2();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapterV2.sol:DEXAdapterV2",
    );

    return await new FlashMintHyETHV2__factory(
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
      debtIssuanceModuleAddress,
      stETHAddress,
      curveStEthEthPoolAddress,
    );
  }

  public async deployFlashMintHyETH(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
    setControllerAddress: Address,
    debtIssuanceModuleAddress: Address,
    stETHAddress: Address,
    curveStEthEthPoolAddress: Address,
  ) {
    const dexAdapter = await this.deployDEXAdapterV2();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapterV2.sol:DEXAdapterV2",
    );

    return await new FlashMintHyETH__factory(
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
      debtIssuanceModuleAddress,
      stETHAddress,
      curveStEthEthPoolAddress,
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

  public async deployFlashMintDex(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
    dexAdapterV2Address: Address,
    setControllerAddress: Address,
    indexControllerAddress: Address,
  ) {
    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapterV2.sol:DEXAdapterV2",
    );

    return await new FlashMintDex__factory(
      // @ts-ignore
      {
        [linkId]: dexAdapterV2Address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(setControllerAddress, indexControllerAddress, {
      quickRouter: quickRouterAddress,
      sushiRouter: sushiRouterAddress,
      uniV3Router: uniV3RouterAddress,
      uniV3Quoter: uniswapV3QuoterAddress,
      curveAddressProvider: curveAddressProviderAddress,
      curveCalculator: curveCalculatorAddress,
      weth: wethAddress,
    });
  }

  public async deployFlashMintNAV(
    wethAddress: Address,
    quickRouterAddress: Address,
    sushiRouterAddress: Address,
    uniV3RouterAddress: Address,
    uniswapV3QuoterAddress: Address,
    curveCalculatorAddress: Address,
    curveAddressProviderAddress: Address,
    dexAdapterV2Address: Address,
    indexControllerAddress: Address,
    navIssuanceModuleAddress: Address
  ) {
    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapterV2.sol:DEXAdapterV2",
    );

    return await new FlashMintNAV__factory(
      // @ts-ignore
      {
        [linkId]: dexAdapterV2Address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(
      indexControllerAddress,
      navIssuanceModuleAddress,
      {
        quickRouter: quickRouterAddress,
        sushiRouter: sushiRouterAddress,
        uniV3Router: uniV3RouterAddress,
        uniV3Quoter: uniswapV3QuoterAddress,
        curveAddressProvider: curveAddressProviderAddress,
        curveCalculator: curveCalculatorAddress,
        weth: wethAddress,
      },
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

  public async deployAuctionRebalanceExtension(
    manager: Address,
    auctionModule: Address,
  ): Promise<AuctionRebalanceExtension> {
    return await new AuctionRebalanceExtension__factory(this._deployerSigner).deploy(
      manager,
      auctionModule,
    );
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
    lendingPoolAddressesProvider: Address,
  ): Promise<AaveV3LeverageStrategyExtension> {
    return await new AaveV3LeverageStrategyExtension__factory(this._deployerSigner).deploy(
      manager,
      contractSettings,
      methdologySettings,
      executionSettings,
      incentiveSettings,
      exchangeNames,
      exchangeSettings,
      lendingPoolAddressesProvider,
    );
  }

  public async deployMorphoLeverageStrategyExtension(
    manager: Address,
    contractSettings: AaveContractSettings,
    methdologySettings: MethodologySettings,
    executionSettings: ExecutionSettings,
    incentiveSettings: IncentiveSettings,
    exchangeNames: string[],
    exchangeSettings: ExchangeSettings[],
  ): Promise<MorphoLeverageStrategyExtension> {
    return await new MorphoLeverageStrategyExtension__factory(this._deployerSigner).deploy(
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

  public async deployTargetWeightWrapExtension(manager: Address, wrapModule: Address, setValuer: Address, isAnyoneAllowedToRebalance: boolean): Promise<TargetWeightWrapExtension> {
    return await new TargetWeightWrapExtension__factory(this._deployerSigner).deploy(manager, wrapModule, setValuer, isAnyoneAllowedToRebalance);
  }

  public async deployMigrationExtension(
    manager: Address,
    underlyingToken: Address,
    aaveToken: Address,
    wrappedSetToken: Address,
    tradeModule: Address,
    issuanceModule: Address,
    nonfungiblePositionManager: Address,
    addressProvider: Address,
    morpho: Address,
    balancer: Address,
  ): Promise<MigrationExtension> {
    return await new MigrationExtension__factory(this._deployerSigner).deploy(
      manager,
      underlyingToken,
      aaveToken,
      wrappedSetToken,
      tradeModule,
      issuanceModule,
      nonfungiblePositionManager,
      addressProvider,
      morpho,
      balancer,
    );
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

  public async deployOptimisticAuctionRebalanceExtensionV1(
    baseManager: Address,
    auctionModule: Address,
    useAssetAllowlist: boolean,
    allowedAssets: Address[],
  ): Promise<OptimisticAuctionRebalanceExtensionV1> {
    return await new OptimisticAuctionRebalanceExtensionV1__factory(this._deployerSigner).deploy({
      baseManager,
      auctionModule,
      useAssetAllowlist,
      allowedAssets,
    });
  }
}
