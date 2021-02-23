import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { ContractTransaction, Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

import {
  BasicIssuanceModule,
  CompoundLeverageModule,
  Controller,
  DebtIssuanceModule,
  IntegrationRegistry,
  SetToken,
  SetTokenCreator,
  StreamingFeeModule
} from "../contracts/setV2";
import { WETH9, StandardTokenMock } from "../contracts/index";
import DeployHelper from "../deploys";
import {
  ether,
  ProtocolUtils,
} from "../common";
import {
  Address,
} from "../types";
import {
  MAX_UINT_256,
} from "../constants";

import { SetToken__factory } from "../../typechain/factories/SetToken__factory";

export class SetFixture {
  private _provider: Web3Provider | JsonRpcProvider;
  private _ownerAddress: Address;
  private _ownerSigner: Signer;
  private _deployer: DeployHelper;

  public feeRecipient: Address;

  public controller: Controller;
  public factory: SetTokenCreator;

  public issuanceModule: BasicIssuanceModule;
  public debtIssuanceModule: DebtIssuanceModule;
  public streamingFeeModule: StreamingFeeModule;
  public integrationRegistry: IntegrationRegistry;
  public compoundLeverageModule: CompoundLeverageModule;

  public weth: WETH9;
  public usdc: StandardTokenMock;
  public wbtc: StandardTokenMock;
  public dai: StandardTokenMock;

  constructor(provider: Web3Provider | JsonRpcProvider, ownerAddress: Address) {
    this._provider = provider;
    this._ownerAddress = ownerAddress;
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public async initialize(): Promise<void> {
    // Choose an arbitrary address as fee recipient
    [, , , this.feeRecipient] = await this._provider.listAccounts();

    this.controller = await this._deployer.setV2.deployController(this.feeRecipient);
    this.debtIssuanceModule = await this._deployer.setV2.deployDebtIssuanceModule(this.controller.address);
    this.issuanceModule = await this._deployer.setV2.deployBasicIssuanceModule(this.controller.address);

    await this.initializeStandardComponents();

    this.factory = await this._deployer.setV2.deploySetTokenCreator(this.controller.address);

    this.integrationRegistry = await this._deployer.setV2.deployIntegrationRegistry(this.controller.address);
    this.streamingFeeModule = await this._deployer.setV2.deployStreamingFeeModule(this.controller.address);

    await this.controller.initialize(
      [this.factory.address], // Factories
      [this.issuanceModule.address, this.streamingFeeModule.address, this.debtIssuanceModule.address], // Modules
      [this.integrationRegistry.address], // Resources
      [0]
    );
  }

  public async initializeStandardComponents(): Promise<void> {
    this.weth = await this._deployer.setV2.deployWETH();
    this.usdc = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(10000), 6);
    this.wbtc = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(10000), 8);
    this.dai = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(1000000), 18);

    await this.weth.deposit({ value: ether(5000) });
    await this.weth.approve(this.issuanceModule.address, ether(10000));
    await this.usdc.approve(this.issuanceModule.address, ether(10000));
    await this.wbtc.approve(this.issuanceModule.address, ether(10000));
    await this.dai.approve(this.issuanceModule.address, ether(10000));
  }

  public async createSetToken(
    components: Address[],
    units: BigNumber[],
    modules: Address[],
    manager: Address = this._ownerAddress,
    name: string = "SetToken",
    symbol: string = "SET",
  ): Promise<SetToken> {
    const txHash: ContractTransaction = await this.factory.create(
      components,
      units,
      modules,
      manager,
      name,
      symbol,
    );

    const retrievedSetAddress = await new ProtocolUtils(this._provider).getCreatedSetTokenAddress(txHash.hash);

    return new SetToken__factory(this._ownerSigner).attach(retrievedSetAddress);
  }

  public async approveAndIssueSetToken(
    setToken: SetToken,
    issueQuantity: BigNumber,
    to: Address = this._ownerAddress
  ): Promise<any> {
    const positions = await setToken.getPositions();
    for (let i = 0; i < positions.length; i++) {
      const { component } = positions[i];
      const componentInstance = await this._deployer.setV2.getTokenMock(component);
      await componentInstance.approve(this.issuanceModule.address, MAX_UINT_256);
    }

    await this.issuanceModule.issue(setToken.address, issueQuantity, to);
  }
}