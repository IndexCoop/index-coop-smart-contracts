import { Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "../types";
import {
  IndexPowah,
  IndexToken,
  MerkleDistributor,
  OtcEscrow,
  Vesting,
  FTCVesting,
} from "../contracts";

import { IndexToken__factory } from "../../typechain/factories/IndexToken__factory";
import { MerkleDistributor__factory } from "../../typechain/factories/MerkleDistributor__factory";
import { Vesting__factory } from "../../typechain/factories/Vesting__factory";
import { OtcEscrow__factory } from "../../typechain/factories/OtcEscrow__factory";
import { FTCVesting__factory } from "../../typechain/factories/FTCVesting__factory";
import { IndexPowah__factory } from "@typechain/factories/IndexPowah__factory";
import { Prt } from "@typechain/Prt";
import { Prt__factory } from "@typechain/factories/Prt__factory";

export default class DeployToken {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployIndexToken(initialAccount: Address): Promise<IndexToken> {
    return await new IndexToken__factory(this._deployerSigner).deploy(initialAccount);
  }

  public async deployMerkleDistributor(
    token: Address,
    merkleRoot: string,
  ): Promise<MerkleDistributor> {
    return await new MerkleDistributor__factory(this._deployerSigner).deploy(token, merkleRoot);
  }

  public async deployVesting(
    token: Address,
    recipient: Address,
    vestingAmount: BigNumber,
    vestingBegin: BigNumber,
    vestingCliff: BigNumber,
    vestingEnd: BigNumber,
  ): Promise<Vesting> {
    return await new Vesting__factory(this._deployerSigner).deploy(
      token,
      recipient,
      vestingAmount,
      vestingBegin,
      vestingCliff,
      vestingEnd,
    );
  }

  public async deployOtcEscrow(
    beneficiary: Address,
    indexGov: Address,
    vestingStart: BigNumber,
    vestingCliff: BigNumber,
    vestingEnd: BigNumber,
    usdcAmount: BigNumber,
    indexAmount: BigNumber,
    usdcAddress: Address,
    indexAddress: Address,
  ): Promise<OtcEscrow> {
    return await new OtcEscrow__factory(this._deployerSigner).deploy(
      beneficiary,
      indexGov,
      vestingStart,
      vestingCliff,
      vestingEnd,
      usdcAmount,
      indexAmount,
      usdcAddress,
      indexAddress,
    );
  }

  public async deployFtcVesting(
    index: Address,
    recipient: Address,
    treasury: Address,
    vestingAmount: BigNumber,
    vestingBegin: BigNumber,
    vestingCliff: BigNumber,
    vestingEnd: BigNumber,
  ): Promise<FTCVesting> {
    return await new FTCVesting__factory(this._deployerSigner).deploy(
      index,
      recipient,
      treasury,
      vestingAmount,
      vestingBegin,
      vestingCliff,
      vestingEnd,
    );
  }

  public async deployIndexPowah(
    owner: Address,
    indexToken: Address,
    uniPair: Address,
    sushiPair: Address,
    masterChef: Address,
    masterChefId: BigNumber,
    farms: Address[],
    vesting: Address[],
  ): Promise<IndexPowah> {
    return await new IndexPowah__factory(this._deployerSigner).deploy(
      owner,
      indexToken,
      uniPair,
      sushiPair,
      masterChef,
      masterChefId,
      farms,
      vesting,
    );
  }

  public async deployPrt(
    name: Address,
    symbol: Address,
    setToken: Address,
    distributor: Address,
    totalSupply: BigNumber,
  ): Promise<Prt> {
    return await new Prt__factory(this._deployerSigner).deploy(
      name,
      symbol,
      setToken,
      distributor,
      totalSupply,
    );
  }
}
