import { Signer, BigNumber } from "ethers";
import { Address } from "../types";
import {
  BaseExtensionMock,
  FLIStrategyExtensionMock,
  GovernanceAdapterMock,
  MutualUpgradeMock,
  StandardTokenMock,
  StringArrayUtilsMock,
  TradeAdapterMock,
  WrapAdapterMock
} from "../contracts/index";

import { BaseExtensionMock__factory } from "../../typechain/factories/BaseExtensionMock__factory";
import { ChainlinkAggregatorV3Mock__factory  } from "../../typechain/factories/ChainlinkAggregatorV3Mock__factory";
import { FLIStrategyExtensionMock__factory } from "../../typechain/factories/FLIStrategyExtensionMock__factory";
import { GovernanceAdapterMock__factory  } from "../../typechain/factories/GovernanceAdapterMock__factory";
import { MasterChefMock__factory } from "../../typechain/factories/MasterChefMock__factory";
import { MutualUpgradeMock__factory } from "../../typechain/factories/MutualUpgradeMock__factory";
import { TradeAdapterMock__factory } from "../../typechain/factories/TradeAdapterMock__factory";
import { StandardTokenMock__factory  } from "../../typechain/factories/StandardTokenMock__factory";
import { StringArrayUtilsMock__factory  } from "../../typechain/factories/StringArrayUtilsMock__factory";
import { WrapAdapterMock__factory } from "../../typechain/factories/WrapAdapterMock__factory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBaseExtensionMock(manager: Address): Promise<BaseExtensionMock> {
    return await new BaseExtensionMock__factory(this._deployerSigner).deploy(manager);
  }

  public async deployTradeAdapterMock(): Promise<TradeAdapterMock> {
    return await new TradeAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployGovernanceAdapterMock(initialProposal: BigNumber): Promise<GovernanceAdapterMock> {
    return await new GovernanceAdapterMock__factory(this._deployerSigner).deploy(initialProposal);
  }

  public async deployMutualUpgradeMock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMock__factory(this._deployerSigner).deploy(owner, methodologist);
  }

  public async deployStandardTokenMock(owner: Address, decimals: number): Promise<StandardTokenMock> {
    return await new StandardTokenMock__factory(this._deployerSigner).deploy(owner, BigNumber.from(1000000).mul(BigNumber.from(10).pow(decimals)), "USDCoin", "USDC", decimals);
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

  public async deployWrapAdapterMock(owner: Address, initAmount: BigNumber): Promise<WrapAdapterMock> {
    return await new WrapAdapterMock__factory(this._deployerSigner).deploy(owner, initAmount);
  }
}
