import { Signer } from "ethers";
import { Address } from "../types";
import {
  GlobalBatchTradeExtension,
  GlobalClaimExtension,
  GlobalIssuanceExtension,
  GlobalStreamingFeeSplitExtension,
  GlobalTradeExtension,
  GlobalWrapExtension,
  GlobalAuctionRebalanceExtension
} from "../contracts/index";

import { GlobalBatchTradeExtension__factory } from "../../typechain/factories/GlobalBatchTradeExtension__factory";
import { GlobalClaimExtension__factory } from "../../typechain/factories/GlobalClaimExtension__factory";
import { GlobalIssuanceExtension__factory } from "../../typechain/factories/GlobalIssuanceExtension__factory";
import { GlobalStreamingFeeSplitExtension__factory } from "../../typechain/factories/GlobalStreamingFeeSplitExtension__factory";
import { GlobalTradeExtension__factory } from "../../typechain/factories/GlobalTradeExtension__factory";
import { GlobalWrapExtension__factory } from "../../typechain/factories/GlobalWrapExtension__factory";
import { GlobalAuctionRebalanceExtension__factory } from "../../typechain/factories/GlobalAuctionRebalanceExtension__factory";
import { GlobalOptimisticAuctionRebalanceExtension__factory } from "../../typechain/factories/GlobalOptimisticAuctionRebalanceExtension__factory";

export default class DeployGlobalExtensions {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployGlobalBatchTradeExtension(
    managerCore: Address,
    tradeModule: Address,
    integrations: string[]
  ): Promise<GlobalBatchTradeExtension> {
    return await new GlobalBatchTradeExtension__factory(this._deployerSigner).deploy(
      managerCore,
      tradeModule,
      integrations
    );
  }

  public async deployGlobalClaimExtension(
    managerCore: Address,
    airdropModule: Address,
    claimModule: Address,
    integrationRegistry: Address
  ): Promise<GlobalClaimExtension> {
    return await new GlobalClaimExtension__factory(this._deployerSigner).deploy(
      managerCore,
      airdropModule,
      claimModule,
      integrationRegistry
    );
  }

  public async deployGlobalIssuanceExtension(
    managerCore: Address,
    basicIssuanceModule: Address
  ): Promise<GlobalIssuanceExtension> {
    return await new GlobalIssuanceExtension__factory(this._deployerSigner).deploy(
      managerCore,
      basicIssuanceModule,
    );
  }

  public async deployGlobalStreamingFeeSplitExtension(
    managerCore: Address,
    streamingFeeModule: Address
  ): Promise<GlobalStreamingFeeSplitExtension> {
    return await new GlobalStreamingFeeSplitExtension__factory(this._deployerSigner).deploy(
      managerCore,
      streamingFeeModule,
    );
  }

  public async deployGlobalTradeExtension(
    managerCore: Address,
    tradeModule: Address
  ): Promise<GlobalTradeExtension> {
    return await new GlobalTradeExtension__factory(this._deployerSigner).deploy(
      managerCore,
      tradeModule,
    );
  }

  public async deployGlobalWrapExtension(
    managerCore: Address,
    wrapModule: Address
  ): Promise<GlobalWrapExtension> {
    return await new GlobalWrapExtension__factory(this._deployerSigner).deploy(
      managerCore,
      wrapModule,
    );
  }

  public async deployGlobalAuctionRebalanceExtension(
    managerCore: Address,
    auctionModule: Address
  ): Promise<GlobalAuctionRebalanceExtension> {
    return await new GlobalAuctionRebalanceExtension__factory(this._deployerSigner).deploy(
      managerCore,
      auctionModule,
    );
  }

  public async deployGlobalOptimisticAuctionRebalanceExtension(
    managerCore: Address,
    auctionModule: Address
  ) {
    return await new GlobalOptimisticAuctionRebalanceExtension__factory(this._deployerSigner).deploy(
      { managerCore: managerCore, auctionModule: auctionModule }
    );
  }

}
