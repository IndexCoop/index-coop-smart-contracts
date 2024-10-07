import { Signer } from "ethers";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Address } from "../types";
import { convertLibraryNameToLinkId } from "../common";
import {
  AaveLeverageModule,
  AaveV2,
  AaveV2WrapV2Adapter,
  AaveV3WrapV2Adapter,
  AirdropModule,
  AuctionRebalanceModuleV1,
  BasicIssuanceModule,
  Compound,
  CompoundLeverageModule,
  CompoundV3WrapV2Adapter,
  Controller,
  ConstantPriceAdapter,
  ComptrollerMock,
  ContractCallerMock,
  ClaimAdapterMock,
  ClaimModule,
  CustomOracleNavIssuanceModule,
  DebtIssuanceModule,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV3,
  ERC4626Oracle,
  ERC4626WrapV2Adapter,
  GeneralIndexModule,
  GovernanceModule,
  IntegrationRegistry,
  OracleMock,
  PreciseUnitOracle,
  PriceOracle,
  RebasingComponentModule,
  StreamingFeeModule,
  SetToken,
  TradeModule,
  SetTokenCreator,
  SetValuer,
  SingleIndexModule,
  UniswapV2ExchangeAdapter,
  WrapModule,
  WrapModuleV2,
  WrapV2AdapterMock,
  SlippageIssuanceModule,
} from "../contracts/setV2";
import {
  AaveV3LeverageModule,
  AaveV3LeverageModule__factory,
  AaveV3,
  AaveV3__factory,
  Morpho,
  Morpho__factory,
  MorphoLeverageModule,
  MorphoLeverageModule__factory,
} from "../../typechain";
import { WETH9, StandardTokenMock } from "../contracts/index";
import { ether } from "../common";
import { AaveLeverageModule__factory } from "../../typechain/factories/AaveLeverageModule__factory";
import { AaveV2__factory } from "../../typechain/factories/AaveV2__factory";
import { AaveV2WrapV2Adapter__factory } from "../../typechain/factories/AaveV2WrapV2Adapter__factory";
import { AaveV3WrapV2Adapter__factory } from "../../typechain/factories/AaveV3WrapV2Adapter__factory";
import { AirdropModule__factory } from "../../typechain/factories/AirdropModule__factory";
import { AuctionRebalanceModuleV1__factory } from "../../typechain/factories/AuctionRebalanceModuleV1__factory";
import { BasicIssuanceModule__factory } from "../../typechain/factories/BasicIssuanceModule__factory";
import { TradeModule__factory } from "../../typechain/factories/TradeModule__factory";
import { Controller__factory } from "../../typechain/factories/Controller__factory";
import { ConstantPriceAdapter__factory } from "../../typechain/factories/ConstantPriceAdapter__factory";
import { Compound__factory } from "../../typechain/factories/Compound__factory";
import { CompoundLeverageModule__factory } from "../../typechain/factories/CompoundLeverageModule__factory";
import { CompoundV3WrapV2Adapter__factory } from "../../typechain/factories/CompoundV3WrapV2Adapter__factory";
import { ComptrollerMock__factory } from "../../typechain/factories/ComptrollerMock__factory";
import { ContractCallerMock__factory } from "../../typechain/factories/ContractCallerMock__factory";
import { ClaimAdapterMock__factory } from "../../typechain/factories/ClaimAdapterMock__factory";
import { ClaimModule__factory } from "../../typechain/factories/ClaimModule__factory";
import { CustomOracleNavIssuanceModule__factory } from "../../typechain/factories/CustomOracleNavIssuanceModule__factory";
import { DebtIssuanceModule__factory } from "../../typechain/factories/DebtIssuanceModule__factory";
import { DebtIssuanceModuleV2__factory } from "../../typechain/factories/DebtIssuanceModuleV2__factory";
import { DebtIssuanceModuleV3__factory } from "../../typechain/factories/DebtIssuanceModuleV3__factory";
import { ERC4626Oracle__factory } from "../../typechain/factories/ERC4626Oracle__factory";
import { ERC4626WrapV2Adapter__factory } from "../../typechain/factories/ERC4626WrapV2Adapter__factory";
import { GeneralIndexModule__factory } from "../../typechain/factories/GeneralIndexModule__factory";
import { GovernanceModule__factory } from "../../typechain/factories/GovernanceModule__factory";
import { IntegrationRegistry__factory } from "../../typechain/factories/IntegrationRegistry__factory";
import { OracleMock__factory } from "../../typechain/factories/OracleMock__factory";
import { PreciseUnitOracle__factory } from "../../typechain/factories/PreciseUnitOracle__factory";
import { PriceOracle__factory } from "../../typechain/factories/PriceOracle__factory";
import { RebasingComponentModule__factory } from "../../typechain/factories/RebasingComponentModule__factory";
import { SingleIndexModule__factory } from "../../typechain/factories/SingleIndexModule__factory";
import { StreamingFeeModule__factory } from "../../typechain/factories/StreamingFeeModule__factory";
import { SetToken__factory } from "../../typechain/factories/SetToken__factory";
import { SetTokenCreator__factory } from "../../typechain/factories/SetTokenCreator__factory";
import { SetValuer__factory } from "../../typechain/factories/SetValuer__factory";
import { StandardTokenMock__factory } from "../../typechain/factories/StandardTokenMock__factory";
import { UniswapV2ExchangeAdapter__factory } from "../../typechain/factories/UniswapV2ExchangeAdapter__factory";
import { WETH9__factory } from "../../typechain/factories/WETH9__factory";
import { WrapModule__factory } from "../../typechain/factories/WrapModule__factory";
import { WrapModuleV2__factory } from "../../typechain/factories/WrapModuleV2__factory";
import { WrapV2AdapterMock__factory } from "../../typechain/factories/WrapV2AdapterMock__factory";
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

  public async getSetToken(setTokenAddress: Address): Promise<SetToken> {
    return await new SetToken__factory(this._deployerSigner).attach(setTokenAddress);
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

  public async deployDebtIssuanceModuleV2(controller: Address): Promise<DebtIssuanceModuleV2> {
    return await new DebtIssuanceModuleV2__factory(this._deployerSigner).deploy(controller);
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

  public async deployMorphoLib(): Promise<Morpho> {
    return await new Morpho__factory(this._deployerSigner).deploy();
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

  public async deployMorphoLeverageModule(
    controller: string,
    morpho: string,
  ): Promise<MorphoLeverageModule> {
    const morphoLib = await this.deployMorphoLib();

    const linkId = convertLibraryNameToLinkId(
      "contracts/protocol/integration/lib/Morpho.sol:Morpho",
    );

    return await new MorphoLeverageModule__factory(
      // @ts-ignore
      {
        [linkId]: morphoLib.address,
      },
      // @ts-ignore
      this._deployerSigner,
    ).deploy(controller, morpho);
  }

  public async deployAirdropModule(controller: Address): Promise<AirdropModule> {
    return await new AirdropModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployAuctionRebalanceModuleV1(
    controller: Address,
  ): Promise<AuctionRebalanceModuleV1> {
    return await new AuctionRebalanceModuleV1__factory(this._deployerSigner).deploy(controller);
  }

  public async deployWrapModule(controller: Address, weth: Address): Promise<WrapModule> {
    return await new WrapModule__factory(this._deployerSigner).deploy(controller, weth);
  }

  public async deployWrapModuleV2(controller: Address, weth: Address): Promise<WrapModuleV2> {
    return await new WrapModuleV2__factory(this._deployerSigner).deploy(controller, weth);
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

  public async deployConstantPriceAdapter(): Promise<ConstantPriceAdapter> {
    return await new ConstantPriceAdapter__factory(this._deployerSigner).deploy();
  }

  public async deployClaimAdapterMock(): Promise<ClaimAdapterMock> {
    return await new ClaimAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployWrapV2AdapterMock(): Promise<WrapV2AdapterMock> {
    return await new WrapV2AdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployClaimModule(controller: Address): Promise<ClaimModule> {
    return await new ClaimModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployTradeModule(controller: Address): Promise<TradeModule> {
    return await new TradeModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployCustomOracleNavIssuanceModule(
    controller: Address,
    weth: Address,
  ): Promise<CustomOracleNavIssuanceModule> {
    return await new CustomOracleNavIssuanceModule__factory(this._deployerSigner).deploy(
      controller,
      weth,
    );
  }

  public async deployDebtIssuanceModuleV3(
    controller: Address,
    tokenTransferBuffer: BigNumberish,
  ): Promise<DebtIssuanceModuleV3> {
    return await new DebtIssuanceModuleV3__factory(this._deployerSigner).deploy(
      controller,
      tokenTransferBuffer,
    );
  }

  public async deployERC4626Oracle(
    vault: Address,
    underlyingFullUnit: BigNumber,
    dataDescription: string,
  ): Promise<ERC4626Oracle> {
    return await new ERC4626Oracle__factory(this._deployerSigner).deploy(
      vault,
      underlyingFullUnit,
      dataDescription,
    );
  }

  public async deployOracleMock(initialValue: BigNumberish): Promise<OracleMock> {
    return await new OracleMock__factory(this._deployerSigner).deploy(initialValue);
  }

  public async deployPreciseUnitOracle(dataDescription: string): Promise<PreciseUnitOracle> {
    return await new PreciseUnitOracle__factory(this._deployerSigner).deploy(dataDescription);
  }

  public async deployRebasingComponentModule(
    controller: Address,
  ): Promise<RebasingComponentModule> {
    return await new RebasingComponentModule__factory(this._deployerSigner).deploy(controller);
  }

  public async deployPriceOracle(
    controller: Address,
    masterQuoteAsset: Address,
    adapters: Address[],
    assetOnes: Address[],
    assetTwos: Address[],
    oracles: Address[],
  ): Promise<PriceOracle> {
    return await new PriceOracle__factory(this._deployerSigner).deploy(
      controller,
      masterQuoteAsset,
      adapters,
      assetOnes,
      assetTwos,
      oracles,
    );
  }

  public async getPriceOracle(priceOracleAddress: Address): Promise<PriceOracle> {
    return await new PriceOracle__factory(this._deployerSigner).attach(priceOracleAddress);
  }

  public async deploySetValuer(controller: Address): Promise<SetValuer> {
    return await new SetValuer__factory(this._deployerSigner).deploy(controller);
  }

  public async deployCompoundV3WrapV2Adapter(comet: Address): Promise<CompoundV3WrapV2Adapter> {
    return await new CompoundV3WrapV2Adapter__factory(this._deployerSigner).deploy(comet);
  }

  public async deployAaveV2WrapV2Adapter(lendingPool: Address): Promise<AaveV2WrapV2Adapter> {
    return await new AaveV2WrapV2Adapter__factory(this._deployerSigner).deploy(lendingPool);
  }

  public async deployAaveV3WrapV2Adapter(pool: Address): Promise<AaveV3WrapV2Adapter> {
    return await new AaveV3WrapV2Adapter__factory(this._deployerSigner).deploy(pool);
  }

  public async deployERC4626WrapV2Adapter(): Promise<ERC4626WrapV2Adapter> {
    return await new ERC4626WrapV2Adapter__factory(this._deployerSigner).deploy();
  }
}
