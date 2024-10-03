import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";
import { ContractTransaction, Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

import {
  AirdropModule,
  AuctionRebalanceModuleV1,
  BasicIssuanceModule,
  CompoundLeverageModule,
  Controller,
  CustomOracleNavIssuanceModule,
  DebtIssuanceModule,
  DebtIssuanceModuleV3,
  GeneralIndexModule,
  GovernanceModule,
  IntegrationRegistry,
  OracleMock,
  PriceOracle,
  RebasingComponentModule,
  SetToken,
  SetTokenCreator,
  SetValuer,
  SlippageIssuanceModule,
  StreamingFeeModule,
  WrapModule,
  WrapModuleV2,
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
  public priceOracle: PriceOracle;
  public integrationRegistry: IntegrationRegistry;
  public setValuer: SetValuer;

  public auctionModule: AuctionRebalanceModuleV1;
  public issuanceModule: BasicIssuanceModule;
  public navIssuanceModule: CustomOracleNavIssuanceModule;
  public debtIssuanceModule: DebtIssuanceModule;
  public debtIssuanceModuleV3: DebtIssuanceModuleV3;
  public streamingFeeModule: StreamingFeeModule;
  public compoundLeverageModule: CompoundLeverageModule;
  public governanceModule: GovernanceModule;
  public generalIndexModule: GeneralIndexModule;
  public airdropModule: AirdropModule;
  public wrapModule: WrapModule;
  public wrapModuleV2: WrapModuleV2;
  public slippageIssuanceModule: SlippageIssuanceModule;
  public rebasingComponentModule: RebasingComponentModule;

  public weth: WETH9;
  public usdc: StandardTokenMock;
  public wbtc: StandardTokenMock;
  public dai: StandardTokenMock;
  public usdt: StandardTokenMock;

  public ETH_USD_Oracle: OracleMock;
  public USD_USD_Oracle: OracleMock;
  public BTC_USD_Oracle: OracleMock;
  public DAI_USD_Oracle: OracleMock;

  public component1Price: BigNumber;
  public component2Price: BigNumber;
  public component3Price: BigNumber;
  public component4Price: BigNumber;

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

    this.auctionModule = await this._deployer.setV2.deployAuctionRebalanceModuleV1(this.controller.address);
    this.issuanceModule = await this._deployer.setV2.deployBasicIssuanceModule(this.controller.address);
    this.streamingFeeModule = await this._deployer.setV2.deployStreamingFeeModule(this.controller.address);
    this.debtIssuanceModule = await this._deployer.setV2.deployDebtIssuanceModule(this.controller.address);
    this.governanceModule = await this._deployer.setV2.deployGovernanceModule(this.controller.address);
    this.airdropModule = await this._deployer.setV2.deployAirdropModule(this.controller.address);
    this.slippageIssuanceModule = await this._deployer.setV2.deploySlippageIssuanceModule(this.controller.address);
    this.debtIssuanceModuleV3 = await this._deployer.setV2.deployDebtIssuanceModuleV3(this.controller.address, 10);
    this.rebasingComponentModule = await this._deployer.setV2.deployRebasingComponentModule(this.controller.address);


    await this.initializeStandardComponents();

    this.priceOracle = await this._deployer.setV2.deployPriceOracle(
      this.controller.address,
      this.usdc.address,
      [],
      [this.weth.address, this.usdc.address, this.wbtc.address, this.dai.address],
      [this.usdc.address, this.usdc.address, this.usdc.address, this.usdc.address],
      [
        this.ETH_USD_Oracle.address,
        this.USD_USD_Oracle.address,
        this.BTC_USD_Oracle.address,
        this.DAI_USD_Oracle.address,
      ]
    );
    this.setValuer = await this._deployer.setV2.deploySetValuer(this.controller.address);
    this.navIssuanceModule = await this._deployer.setV2.deployCustomOracleNavIssuanceModule(this.controller.address, this.weth.address);

    this.generalIndexModule = await this._deployer.setV2.deployGeneralIndexModule(
      this.controller.address,
      this.weth.address
    );

    this.wrapModule = await this._deployer.setV2.deployWrapModule(
      this.controller.address,
      this.weth.address
    );

    this.wrapModuleV2 = await this._deployer.setV2.deployWrapModuleV2(
      this.controller.address,
      this.weth.address
    );

    const modules = [
      this.auctionModule.address,
      this.issuanceModule.address,
      this.streamingFeeModule.address,
      this.debtIssuanceModule.address,
      this.governanceModule.address,
      this.generalIndexModule.address,
      this.airdropModule.address,
      this.wrapModule.address,
      this.wrapModuleV2.address,
      this.slippageIssuanceModule.address,
      this.navIssuanceModule.address,
      this.debtIssuanceModuleV3.address,
      this.rebasingComponentModule.address,
    ];

    await this.controller.initialize(
      [this.factory.address], // Factories
      modules, // Modules
      [this.integrationRegistry.address, this.priceOracle.address, this.setValuer.address], // Resources
      [0, 1, 2]  // Resource IDs where IntegrationRegistry is 0, PriceOracle is 1, SetValuer is 2
    );
  }

  public async initializeStandardComponents(): Promise<void> {
    this.weth = await this._deployer.setV2.deployWETH();
    this.usdc = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(100000), 6);
    this.wbtc = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(100000), 8);
    this.dai = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(1000000), 18);
    this.usdt = await this._deployer.setV2.deployTokenMock(this._ownerAddress, ether(100000), 6);

    this.component1Price = ether(230);
    this.component2Price = ether(1);
    this.component3Price = ether(9000);
    this.component4Price = ether(1);

    this.ETH_USD_Oracle = await this._deployer.setV2.deployOracleMock(this.component1Price);
    this.USD_USD_Oracle = await this._deployer.setV2.deployOracleMock(this.component2Price);
    this.BTC_USD_Oracle = await this._deployer.setV2.deployOracleMock(this.component3Price);
    this.DAI_USD_Oracle = await this._deployer.setV2.deployOracleMock(this.component4Price);

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
