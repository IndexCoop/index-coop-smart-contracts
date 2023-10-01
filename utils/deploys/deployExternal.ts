import { Signer } from "ethers";
import { ether } from "@utils/common";
import { BigNumberish, BigNumber } from "@ethersproject/bignumber";

import {
  CompoundPriceOracleMock,
  Comp,
  CompoundGovernorAlpha,
  CompoundTimelock,
  Comptroller,
  CERc20,
  CEther,
  PriceOracleProxy,
  Unitroller,
  WhitePaperInterestRateModel
} from "./../contracts/compound";

import {
  Uni,
  UniswapTimelock,
  UniswapV2Factory,
  UniswapV2Pair,
  UniswapV2Router02
} from "../contracts/uniswap";

import {
  SwapRouter,
  UniswapV3Factory,
  NonfungiblePositionManager,
  Quoter,
  NFTDescriptor
} from "../contracts/uniswapV3";

import {
  AaveGovernanceV2,
  AaveTokenV2Mintable,
  AaveV2AToken,
  AaveV2StakedTokenIncentivesController,
  AaveV2StableDebtToken,
  AaveV2VariableDebtToken,
  AaveV2ProtocolDataProvider,
  AaveV2LendingPool,
  AaveV2LendingPoolAddressesProvider,
  AaveV2LendingPoolConfigurator,
  AaveV2LendingPoolCollateralManager,
  AaveV2DefaultReserveInterestRateStrategy,
  AaveV2LendingRateOracle,
  AaveV2Oracle,
  AaveV2PriceOracle,
  Executor,
  GovernanceStrategy,
  GenericLogic,
  ReserveLogic,
  ValidationLogic
} from "../contracts/aaveV2";

import { Address } from "./../types";

import { AaveTokenV2Mintable__factory } from "../../typechain/factories/AaveTokenV2Mintable__factory";
import { AaveV2LendingPool__factory } from "../../typechain/factories/AaveV2LendingPool__factory";
import { AaveV2LendingPoolAddressesProvider__factory } from "../../typechain/factories/AaveV2LendingPoolAddressesProvider__factory";
import { AaveV2ProtocolDataProvider__factory } from "../../typechain/factories/AaveV2ProtocolDataProvider__factory";
import { AaveV2LendingPoolConfigurator__factory } from "../../typechain/factories/AaveV2LendingPoolConfigurator__factory";
import { AaveV2LendingPoolCollateralManager__factory } from "../../typechain/factories/AaveV2LendingPoolCollateralManager__factory";
import { AaveV2DefaultReserveInterestRateStrategy__factory } from "../../typechain/factories/AaveV2DefaultReserveInterestRateStrategy__factory";
import { AaveV2AToken__factory } from "../../typechain/factories/AaveV2AToken__factory";
import { AaveV2StableDebtToken__factory } from "../../typechain/factories/AaveV2StableDebtToken__factory";
import { AaveV2VariableDebtToken__factory } from "../../typechain/factories/AaveV2VariableDebtToken__factory";
import { AaveV2StakedTokenIncentivesController__factory } from "../../typechain/factories/AaveV2StakedTokenIncentivesController__factory";
import { GenericLogic__factory } from "../../typechain/factories/GenericLogic__factory";
import { ValidationLogic__factory } from "../../typechain/factories/ValidationLogic__factory";
import { ReserveLogic__factory } from "../../typechain/factories/ReserveLogic__factory";
import { AaveV2LendingRateOracle__factory } from "../../typechain/factories/AaveV2LendingRateOracle__factory";
import { AaveV2Oracle__factory } from "../../typechain/factories/AaveV2Oracle__factory";
import { AaveV2PriceOracle__factory } from "../../typechain/factories/AaveV2PriceOracle__factory";
import { AaveGovernanceV2__factory } from "../../typechain/factories/AaveGovernanceV2__factory";
import { Executor__factory } from "../../typechain/factories/Executor__factory";
import { GovernanceStrategy__factory } from "../../typechain/factories/GovernanceStrategy__factory";
import { CERc20__factory } from "../../typechain/factories/CERc20__factory";
import { CEther__factory } from "../../typechain/factories/CEther__factory";
import { CompoundPriceOracleMock__factory } from "../../typechain/factories/CompoundPriceOracleMock__factory";
import { Comp__factory } from "../../typechain/factories/Comp__factory";
import { CompoundGovernorAlpha__factory } from "../../typechain/factories/CompoundGovernorAlpha__factory";
import { CompoundTimelock__factory } from "../../typechain/factories/CompoundTimelock__factory";
import { Comptroller__factory } from "../../typechain/factories/Comptroller__factory";
import { PriceOracleProxy__factory } from "../../typechain/factories/PriceOracleProxy__factory";
import { Unitroller__factory } from "../../typechain/factories/Unitroller__factory";
import { WhitePaperInterestRateModel__factory } from "../../typechain/factories/WhitePaperInterestRateModel__factory";
import { Uni__factory } from "../../typechain/factories/Uni__factory";
import { UniswapTimelock__factory } from "../../typechain/factories/UniswapTimelock__factory";
import { UniswapV2Factory__factory } from "../../typechain/factories/UniswapV2Factory__factory";
import { UniswapV2Pair__factory } from "../../typechain/factories/UniswapV2Pair__factory";
import { UniswapV2Router02__factory } from "../../typechain/factories/UniswapV2Router02__factory";
import { UniswapV3Factory__factory } from "../../typechain/factories/UniswapV3Factory__factory";
import { SwapRouter__factory } from "../../typechain/factories/SwapRouter__factory";
import { NonfungiblePositionManager__factory } from "../../typechain/factories/NonfungiblePositionManager__factory";
import { Quoter__factory } from "../../typechain/factories/Quoter__factory";
import { NFTDescriptor__factory } from "../../typechain/factories/NFTDescriptor__factory";
import { SwapRouter02 } from "../../typechain/SwapRouter02";
import { SwapRouter02__factory } from "../../typechain/factories/SwapRouter02__factory";


export default class DeployExternalContracts {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  // COMPOUND
  public async deployComp(_account: Address): Promise<Comp> {
    return await new Comp__factory(this._deployerSigner).deploy(_account);
  }

  public async deployCompoundTimelock(_admin: Address, _delay: BigNumber): Promise<CompoundTimelock> {
    return await new CompoundTimelock__factory(this._deployerSigner).deploy(_admin, _delay);
  }

  public async deployCompoundGovernorAlpha(_timelock: Address, _comp: Address, _guardian: Address): Promise<CompoundGovernorAlpha> {
    return await new CompoundGovernorAlpha__factory(this._deployerSigner).deploy(_timelock, _comp, _guardian);
  }

  public async deployCERc20(
    underlying: Address,
    comptroller: Address,
    interestRateModel: Address,
    initialExchangeRateMantissa: BigNumberish,
    name: string,
    symbol: string,
    decimals: BigNumberish
  ): Promise<CERc20> {
    return await new CERc20__factory(this._deployerSigner).deploy(
      underlying,
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );
  }

  public async deployCEther(
    comptroller: Address,
    interestRateModel: Address,
    initialExchangeRateMantissa: BigNumberish,
    name: string,
    symbol: string,
    decimals: BigNumberish
  ): Promise<CEther> {
    return await new CEther__factory(this._deployerSigner).deploy(
      comptroller,
      interestRateModel,
      initialExchangeRateMantissa,
      name,
      symbol,
      decimals,
    );
  }

  public async deployCompoundPriceOracleMock(): Promise<CompoundPriceOracleMock> {
    return await new CompoundPriceOracleMock__factory(this._deployerSigner).deploy();
  }

  public async deployPriceOracleProxy(
    guardian: Address,
    v1PriceOracle: Address,
    cEthAddress: Address,
    cUsdcAddress: Address,
    cSaiAddress: Address,
    cDaiAddress: Address,
    cUsdtAddress: Address,
  ): Promise<PriceOracleProxy> {
    return await new PriceOracleProxy__factory(this._deployerSigner).deploy(
      guardian,
      v1PriceOracle,
      cEthAddress,
      cUsdcAddress,
      cSaiAddress,
      cDaiAddress,
      cUsdtAddress,
    );
  }

  public async deployComptroller(): Promise<Comptroller> {
    return await new Comptroller__factory(this._deployerSigner).deploy();
  }

  public async deployUnitroller(): Promise<Unitroller> {
    return await new Unitroller__factory(this._deployerSigner).deploy();
  }

  public async deployWhitePaperInterestRateModel(
    baseRate: BigNumberish,
    multiplier: BigNumberish
  ): Promise<WhitePaperInterestRateModel> {
    return await new WhitePaperInterestRateModel__factory(this._deployerSigner).deploy(baseRate, multiplier);
  }

  // Uniswap V2
  public async deployUni(_account: Address, _minter: Address, _mintingAllowedAfter: BigNumber): Promise<Uni> {
    return await new Uni__factory(this._deployerSigner).deploy(_account, _minter, _mintingAllowedAfter);
  }

  public async deployUniswapTimelock(_admin: Address, _delay: BigNumber): Promise<UniswapTimelock> {
    return await new UniswapTimelock__factory(this._deployerSigner).deploy(_admin, _delay);
  }

  public async deployUniswapV2Factory(_feeToSetter: string): Promise<UniswapV2Factory> {
    return await new UniswapV2Factory__factory(this._deployerSigner).deploy(_feeToSetter);
  }

  public async deployUniswapV2Router02(_factory: Address, _weth: Address): Promise<UniswapV2Router02> {
    return await new UniswapV2Router02__factory(this._deployerSigner).deploy(_factory, _weth);
  }

  public async deployUniswapV2Pair(_factory: Address, _weth: Address): Promise<UniswapV2Pair> {
    return await new UniswapV2Pair__factory(this._deployerSigner).deploy();
  }

    // Uniswap V3
    public async deployUniswapV3Factory(): Promise<UniswapV3Factory> {
      return await new UniswapV3Factory__factory(this._deployerSigner).deploy();
    }

    public async deploySwapRouter(factory: Address, weth: Address): Promise<SwapRouter> {
      return await new SwapRouter__factory(this._deployerSigner).deploy(factory, weth);
    }

    public async deploySwapRouter02(factoryV2: Address, factoryV3: Address, positionManager: Address, weth: Address): Promise<SwapRouter02> {
      return await new SwapRouter02__factory(this._deployerSigner).deploy(factoryV2, factoryV3, positionManager, weth);
    }

    public async deployNftPositionManager(factory: Address, weth: Address, nftDesc: Address): Promise<NonfungiblePositionManager> {
      return await new NonfungiblePositionManager__factory(this._deployerSigner).deploy(factory, weth, nftDesc);
    }

    public async deployQuoter(factory: Address, weth: Address): Promise<Quoter> {
      return await new Quoter__factory(this._deployerSigner).deploy(factory, weth);
    }

    public async deployNFTDescriptor(): Promise<NFTDescriptor> {
      return await new NFTDescriptor__factory(this._deployerSigner).deploy();
    }

      // AAVE V2
  public async deployAaveV2LendingPoolAddressesProvider(marketId: string): Promise<AaveV2LendingPoolAddressesProvider> {
    return await new AaveV2LendingPoolAddressesProvider__factory(this._deployerSigner).deploy(marketId);
  }

  public async deployAaveV2LendingPool(validationLogicAddress: Address, reserveLogicAddress: Address): Promise<AaveV2LendingPool> {
    return await new AaveV2LendingPool__factory(
      {
        ["__$de8c0cf1a7d7c36c802af9a64fb9d86036$__"]: validationLogicAddress,
        ["__$22cd43a9dda9ce44e9b92ba393b88fb9ac$__"]: reserveLogicAddress,
      },
      this._deployerSigner
    ).deploy();
  }

  public async deployAaveV2LendingPoolConfigurator(): Promise<AaveV2LendingPoolConfigurator> {
    return await new AaveV2LendingPoolConfigurator__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2LendingPoolCollateralManager(): Promise<AaveV2LendingPoolCollateralManager> {
    return await new AaveV2LendingPoolCollateralManager__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2LendingRateOracle(): Promise<AaveV2LendingRateOracle> {
    return await new AaveV2LendingRateOracle__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2Oracle(
    assets: string[],
    sources: [],
    fallBackOracle: Address,
    weth: Address): Promise<AaveV2Oracle> {
    return await new AaveV2Oracle__factory(this._deployerSigner).deploy(assets, sources, fallBackOracle, weth);
  }

  public async deployAaveV2PriceOracle(): Promise<AaveV2PriceOracle> {
    return await new AaveV2PriceOracle__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2DefaultReserveInterestRateStrategy(
    _AddressesProvider: Address,
    _optimalUtilizationRate: BigNumberish = ether(1),
    _baseVariableBorrowRate: BigNumberish = ether(1),
    _variableRateSlope1: BigNumberish = ether(1),
    _variableRateSlope2: BigNumberish = ether(1),
    _stableRateSlope1: BigNumberish = ether(1),
    _stableRateSlope2: BigNumberish = ether(1),
  ): Promise<AaveV2DefaultReserveInterestRateStrategy> {
    return await new AaveV2DefaultReserveInterestRateStrategy__factory(this._deployerSigner).deploy(
      _AddressesProvider,
      _optimalUtilizationRate,
      _baseVariableBorrowRate,
      _variableRateSlope1,
      _variableRateSlope2,
      _stableRateSlope1,
      _stableRateSlope2,
    );
  }

  public async deployAaveV2ProtocolDataProvider(addressProvider: Address): Promise<AaveV2ProtocolDataProvider> {
    return await new AaveV2ProtocolDataProvider__factory(this._deployerSigner).deploy(addressProvider);
  }

  public async deployAaveV2AToken(): Promise<AaveV2AToken> {
    return await new AaveV2AToken__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2StableDebtToken(): Promise<AaveV2StableDebtToken> {
    return await new AaveV2StableDebtToken__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2VariableDebtToken(): Promise<AaveV2VariableDebtToken> {
    return await new AaveV2VariableDebtToken__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2StakedTokenIncentivesController(
    stakeToken: Address,
    emissionManager: Address
  ): Promise<AaveV2StakedTokenIncentivesController> {
    return await new AaveV2StakedTokenIncentivesController__factory(this._deployerSigner).deploy(
      stakeToken,
      emissionManager
    );
  }

  // AAVE V2 LIBRARIES
  public async deployGeneralLogic(): Promise<GenericLogic> {
    return await new GenericLogic__factory(this._deployerSigner).deploy();
  }

  public async deployValidationLogic(genericLogicLibraryAddress: Address): Promise<ValidationLogic> {
    return await new ValidationLogic__factory(
      {
        ["__$52a8a86ab43135662ff256bbc95497e8e3$__"]: genericLogicLibraryAddress,
      },
      this._deployerSigner).deploy();
  }

  public async deployReserveLogic(): Promise<ReserveLogic> {
    return await new ReserveLogic__factory(this._deployerSigner).deploy();
  }

  // AAVE V2 GOVERNANCE
  public async deployAaveGovernanceV2(
    _governanceStrategy: Address,
    _votingDelay: BigNumber,
    _guardian: Address,
    _executors: Address[]
  ): Promise<AaveGovernanceV2> {
    return await new AaveGovernanceV2__factory(this._deployerSigner).deploy(_governanceStrategy, _votingDelay, _guardian, _executors);
  }

  public async deployExecutor(
    _admin: Address,
    _delay: BigNumber,
    _gracePeriod: BigNumber,
    _minimumDelay: BigNumber,
    _maximumDelay: BigNumber,
    _propositionThreshold: BigNumber,
    _voteDuration: BigNumber,
    _voteDifferential: BigNumber,
    _minmumQuorum: BigNumber
  ): Promise<Executor> {
    return await new Executor__factory(this._deployerSigner).deploy(
      _admin,
      _delay,
      _gracePeriod,
      _minimumDelay,
      _maximumDelay,
      _propositionThreshold,
      _voteDuration,
      _voteDifferential,
      _minmumQuorum,
    );
  }

  public async deployGovernanceStrategy(_aave: Address, _stkaave: Address): Promise<GovernanceStrategy> {
    return await new GovernanceStrategy__factory(this._deployerSigner).deploy(_aave, _stkaave);
  }

  public async deployAaveTokenV2Mintable(): Promise<AaveTokenV2Mintable> {
    return await new AaveTokenV2Mintable__factory(this._deployerSigner).deploy();
  }
}