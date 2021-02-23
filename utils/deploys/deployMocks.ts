import { Signer } from "ethers";
import { Address } from "../types";
import { BaseAdapterMock, MutualUpgradeMock, TradeAdapterMock } from "../contracts/index";

import { MutualUpgradeMock__factory } from "../../typechain/factories/MutualUpgradeMock__factory";
import { BaseAdapterMock__factory } from "../../typechain/factories/BaseAdapterMock__factory";
import { TradeAdapterMock__factory } from "../../typechain/factories/TradeAdapterMock__factory";

export default class DeployMocks {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployBaseAdapterMock(manager: Address): Promise<BaseAdapterMock> {
    return await new BaseAdapterMock__factory(this._deployerSigner).deploy(manager);
  }

  public async deployTradeAdapterMock(): Promise<TradeAdapterMock> {
    return await new TradeAdapterMock__factory(this._deployerSigner).deploy();
  }

  public async deployMutualUpgradeMock(owner: Address, methodologist: string): Promise<MutualUpgradeMock> {
    return await new MutualUpgradeMock__factory(this._deployerSigner).deploy(owner, methodologist);
  }
}
