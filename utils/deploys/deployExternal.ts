import { Signer } from "ethers";
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

import { Address } from "./../types";

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

    public async deployNftPositionManager(factory: Address, weth: Address, nftDesc: Address): Promise<NonfungiblePositionManager> {
      return await new NonfungiblePositionManager__factory(this._deployerSigner).deploy(factory, weth, nftDesc);
    }

    public async deployQuoter(factory: Address, weth: Address): Promise<Quoter> {
      return await new Quoter__factory(this._deployerSigner).deploy(factory, weth);
    }

    public async deployNFTDescriptor(): Promise<NFTDescriptor> {
      return await new NFTDescriptor__factory(this._deployerSigner).deploy();
    }
}