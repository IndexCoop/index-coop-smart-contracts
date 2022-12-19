import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { ContractTransaction, Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

import {
  AirdropModule,
  BasicIssuanceModule,
  CompoundLeverageModule,
  Controller,
  DebtIssuanceModule,
  GeneralIndexModule,
  GovernanceModule,
  IntegrationRegistry,
  SetToken,
  SetTokenCreator,
  SlippageIssuanceModule,
  StreamingFeeModule,
  WrapModule
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
  public integrationRegistry: IntegrationRegistry;

  public issuanceModule: BasicIssuanceModule;
  public debtIssuanceModule: DebtIssuanceModule;
  public streamingFeeModule: StreamingFeeModule;
  public compoundLeverageModule: CompoundLeverageModule;
  public governanceModule: GovernanceModule;
  public generalIndexModule: GeneralIndexModule;
  public airdropModule: AirdropModule;
  public wrapModule: WrapModule;
  public slippageIssuanceModule: SlippageIssuanceModule;

  public weth: WETH9;
  public usdc: StandardTokenMock;
  public wbtc: StandardTokenMock;
  public dai: StandardTokenMock;
  public usdt: StandardTokenMock;

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
    this.integrationRegistry = await this._deployer.setV2.deployIntegrationRegistry(this.controller.address);
    this.factory = await this._deployer.setV2.deploySetTokenCreator(this.controller.address);

    this.issuanceModule = await this._deployer.setV2.deployBasicIssuanceModule(this.controller.address);
    this.streamingFeeModule = await this._deployer.setV2.deployStreamingFeeModule(this.controller.address);
    this.debtIssuanceModule = await this._deployer.setV2.deployDebtIssuanceModule(this.controller.address);
    this.governanceModule = await this._deployer.setV2.deployGovernanceModule(this.controller.address);
    this.airdropModule = await this._deployer.setV2.deployAirdropModule(this.controller.address);
    this.slippageIssuanceModule = await this._deployer.setV2.deploySlippageIssuanceModule(this.controller.address);

    await this.initializeStandardComponents();

    this.generalIndexModule = await this._deployer.setV2.deployGeneralIndexModule(
      this.controller.address,
      this.weth.address
    );

    this.wrapModule = await this._deployer.setV2.deployWrapModule(
      this.controller.address,
      this.weth.address
    );

    const modules = [
      this.issuanceModule.address,
      this.streamingFeeModule.address,
      this.debtIssuanceModule.address,
      this.governanceModule.address,
      this.generalIndexModule.address,
      this.airdropModule.address,
      this.wrapModule.address,
      this.slippageIssuanceModule.address,
    ];

    await this.controller.initialize(
      [this.factory.address], // Factories
      modules, // Modules
      [this.integrationRegistry.address], // Resources
      [0]
    );
  }

  public async initializeStandardComponents(): Promise<void> {
    this.weth = await this._deployer.setV2.deployWETH();
    this.usdc = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(100000), 6);
    this.wbtc = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(100000), 8);
    this.dai = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(1000000), 18);
    this.usdt = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(100000), 6);

    await this.weth.deposit({ value: ether(200000) });
    await this.weth.approve(this.issuanceModule.address, ether(10000));
    await this.usdc.approve(this.issuanceModule.address, ether(10000));
    await this.wbtc.approve(this.issuanceModule.address, ether(10000));
    await this.dai.approve(this.issuanceModule.address, ether(10000));
    await this.usdt.approve(this.issuanceModule.address, ether(10000));
    await this.weth.approve(this.debtIssuanceModule.address, ether(10000));
    await this.usdc.approve(this.debtIssuanceModule.address, ether(10000));
    await this.wbtc.approve(this.debtIssuanceModule.address, ether(10000));
    await this.dai.approve(this.debtIssuanceModule.address, ether(10000));
    await this.usdt.approve(this.debtIssuanceModule.address, ether(10000));
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
