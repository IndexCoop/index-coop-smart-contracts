import { Signer, BigNumber } from "ethers";
import { Address } from "../types";
import {
  BaseExtensionMock,
  FLIStrategyExtensionMock,
  FlexibleLeverageStrategyExtensionMock,
  GovernanceAdapterMock,
  MutualUpgradeMock,
  NotionalTradeModuleMock,
  StandardTokenMock,
  StringArrayUtilsMock,
  ManagerMock,
  BatchTradeAdapterMock,
  TradeAdapterMock,
  WrapAdapterMock,
  WrapV2AdapterMock,
  WrappedfCashMock,
  WrappedfCashFactoryMock,
  ZeroExExchangeProxyMock,
  DEXAdapter,
  ModuleMock,
  BaseGlobalExtensionMock,
  MutualUpgradeV2Mock,
  PrtStakingPoolMock,
} from "../contracts/index";

import { BaseExtensionMock__factory } from "../../typechain/factories/BaseExtensionMock__factory";
import { DEXAdapter__factory } from "../../typechain/factories/DEXAdapter__factory";
import { ModuleMock__factory } from "../../typechain/factories/ModuleMock__factory";
import { ManagerMock__factory } from "../../typechain/factories/ManagerMock__factory";
import { MutualUpgradeV2Mock__factory } from "../../typechain/factories/MutualUpgradeV2Mock__factory";
import { BaseGlobalExtensionMock__factory } from "../../typechain/factories/BaseGlobalExtensionMock__factory";
import { convertLibraryNameToLinkId } from "../common";
import { ChainlinkAggregatorV3Mock__factory } from "../../typechain/factories/ChainlinkAggregatorV3Mock__factory";
import { FLIStrategyExtensionMock__factory } from "../../typechain/factories/FLIStrategyExtensionMock__factory";
import { FlexibleLeverageStrategyExtensionMock__factory } from "../../typechain/factories/FlexibleLeverageStrategyExtensionMock__factory";
import { GovernanceAdapterMock__factory } from "../../typechain/factories/GovernanceAdapterMock__factory";
import { MasterChefMock__factory } from "../../typechain/factories/MasterChefMock__factory";
import { MutualUpgradeMock__factory } from "../../typechain/factories/MutualUpgradeMock__factory";
import { NotionalTradeModuleMock__factory } from "../../typechain/factories/NotionalTradeModuleMock__factory";
import { BatchTradeAdapterMock__factory } from "../../typechain/factories/BatchTradeAdapterMock__factory";
import { TradeAdapterMock__factory } from "../../typechain/factories/TradeAdapterMock__factory";
import { StandardTokenMock__factory } from "../../typechain/factories/StandardTokenMock__factory";
import { StringArrayUtilsMock__factory } from "../../typechain/factories/StringArrayUtilsMock__factory";
import { WrapAdapterMock__factory } from "../../typechain/factories/WrapAdapterMock__factory";
import { WrapV2AdapterMock__factory } from "../../typechain/factories/WrapV2AdapterMock__factory";
import { WrappedfCashMock__factory } from "../../typechain/factories/WrappedfCashMock__factory";
import { WrappedfCashFactoryMock__factory } from "../../typechain/factories/WrappedfCashFactoryMock__factory";
import { ZeroExExchangeProxyMock__factory  } from "../../typechain/factories/ZeroExExchangeProxyMock__factory";
import { AaveV2LendingPoolMock__factory } from "@typechain/factories/AaveV2LendingPoolMock__factory";
import { AaveV2LendingPoolMock } from "@typechain/AaveV2LendingPoolMock";
import { FlashMintLeveragedCompMock } from "@typechain/FlashMintLeveragedCompMock";
import { FlashMintLeveragedCompMock__factory } from "@typechain/factories/FlashMintLeveragedCompMock__factory";
import { OptimisticOracleV3Mock__factory } from "@typechain/factories/OptimisticOracleV3Mock__factory";
import { PrtStakingPoolMock__factory } from "@typechain/factories/PrtStakingPoolMock__factory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBaseExtensionMock(manager: Address): Promise<BaseExtensionMock> {
    return await new BaseExtensionMock__factory(this._deployerSigner).deploy(manager);
  }

  public async deployBaseGlobalExtensionMock(managerCore: Address, module: Address): Promise<BaseGlobalExtensionMock> {
    return await new BaseGlobalExtensionMock__factory(this._deployerSigner).deploy(managerCore, module);
  }

  public async deployTradeAdapterMock(): Promise<TradeAdapterMock> {
    return await new TradeAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployBatchTradeAdapterMock(): Promise<BatchTradeAdapterMock> {
    return await new BatchTradeAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployGovernanceAdapterMock(
    initialProposal: BigNumber,
  ): Promise<GovernanceAdapterMock> {
    return await new GovernanceAdapterMock__factory(this._deployerSigner).deploy(initialProposal);
  }

  public async deployMutualUpgradeMock(
    owner: Address,
    methodologist: string,
  ): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMock__factory(this._deployerSigner).deploy(owner, methodologist);
  }

  public async deployStandardTokenMock(
    owner: Address,
    decimals: number,
  ): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).deploy(
      owner,
      BigNumber.from(1000000).mul(BigNumber.from(10).pow(decimals)),
      "USDCoin",
      "USDC",
      decimals,
    );
  }

  public async deployChainlinkAggregatorMock() {
    return await new ChainlinkAggregatorV3Mock__factory(this._deployerSigner).deploy();
  }

  public async deployMasterChefMock() {
    return await new MasterChefMock__factory(this._deployerSigner).deploy();
  }

  public async deployStringArrayUtilsMock(): Promise<StringArrayUtilsMock> {
    return await new StringArrayUtilsMock__factory(this._deployerSigner).deploy();
  }

  public async deployFLIStrategyExtensionMock(): Promise<FLIStrategyExtensionMock> {
    return await new FLIStrategyExtensionMock__factory(this._deployerSigner).deploy();
  }

  public async deployFlexibleLeverageStrategyExtensionMock(
    manager: Address,
    leverageRatio: number,
    exchangeName: string,
  ): Promise<FlexibleLeverageStrategyExtensionMock> {
    return await new FlexibleLeverageStrategyExtensionMock__factory(this._deployerSigner).deploy(
      manager,
      leverageRatio,
      exchangeName,
    );
  }

  public async deployWrapAdapterMock(
    owner: Address,
    initAmount: BigNumber,
  ): Promise<WrapAdapterMock> {
    return await new WrapAdapterMock__factory(this._deployerSigner).deploy(owner, initAmount);
  }

  public async deployWrapV2AdapterMock(): Promise<WrapV2AdapterMock> {
    return await new WrapV2AdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployZeroExExchangeProxyMock(): Promise<ZeroExExchangeProxyMock> {
    return await new ZeroExExchangeProxyMock__factory(this._deployerSigner).deploy();
  }

  public async deployWrappedfCashMock(assetToken: Address, underlyingToken: Address, weth: Address): Promise<WrappedfCashMock> {
    return await new WrappedfCashMock__factory(this._deployerSigner).deploy(assetToken, underlyingToken, weth);
  }

  public async deployWrappedfCashFactoryMock(): Promise<WrappedfCashFactoryMock> {
    return await new WrappedfCashFactoryMock__factory(this._deployerSigner).deploy();
  }

  public async deployNotionalTradeModuleMock(): Promise<NotionalTradeModuleMock> {
    return await new NotionalTradeModuleMock__factory(this._deployerSigner).deploy();
  }


  public async deployAaveV2LendingPoolMock(
    validationLogicAddress: Address,
    reserveLogicAddress: Address,
  ): Promise<AaveV2LendingPoolMock> {
    return await new AaveV2LendingPoolMock__factory(
      {
        ["__$de8c0cf1a7d7c36c802af9a64fb9d86036$__"]: validationLogicAddress,
        ["__$22cd43a9dda9ce44e9b92ba393b88fb9ac$__"]: reserveLogicAddress,
      },
      this._deployerSigner,
    ).deploy();
  }

  public async deployDEXAdapter(): Promise<DEXAdapter> {
    return await new DEXAdapter__factory(this._deployerSigner).deploy();
  }

  public async deployModuleMock(controller: Address): Promise<ModuleMock> {
    return await new ModuleMock__factory(this._deployerSigner).deploy(controller);
  }

  public async deployMutualUpgradeV2Mock(owner: Address, methodologist: string): Promise<MutualUpgradeV2Mock> {
    return await new MutualUpgradeV2Mock__factory(this._deployerSigner).deploy(owner, methodologist);
  }

  public async deployFlashMintLeveragedCompMock(
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
  ): Promise<FlashMintLeveragedCompMock> {
    const dexAdapter = await this.deployDEXAdapter();

    const linkId = convertLibraryNameToLinkId(
      "contracts/exchangeIssuance/DEXAdapter.sol:DEXAdapter",
    );

    return await new FlashMintLeveragedCompMock__factory(
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

  public async deployManagerMock(setToken: Address): Promise<ManagerMock> {
    return await new ManagerMock__factory(this._deployerSigner).deploy(setToken);
  }

  public async deployOptimisticOracleV3Mock() {
    return await new OptimisticOracleV3Mock__factory(this._deployerSigner).deploy();
  }

  public async deployPrtStakingPoolMock(
    setToken: Address,
    prt: Address,
    feeSplitExtension: Address,
  ): Promise<PrtStakingPoolMock> {
    return await new PrtStakingPoolMock__factory(this._deployerSigner).deploy(
      setToken,
      prt,
      feeSplitExtension,
    );
  }
}
