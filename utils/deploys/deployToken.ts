import { Signer } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "../types";
import { IndexToken, MerkleDistributor, Vesting } from "../contracts";

import { IndexTokenFactory } from "../../typechain/IndexTokenFactory";
import { MerkleDistributorFactory } from "../../typechain/MerkleDistributorFactory";
import { VestingFactory } from "../../typechain/VestingFactory";

export default class DeployToken {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployIndexToken(initialAccount: Address): Promise<IndexToken> {
    return await new IndexTokenFactory(this._deployerSigner).deploy(initialAccount);
  }

  public async deployMerkleDistributor(token: Address, merkleRoot: string): Promise<MerkleDistributor> {
    return await new MerkleDistributorFactory(this._deployerSigner).deploy(token, merkleRoot);
  }

  public async deployVesting(
    token: Address,
    recipient: Address,
    vestingAmount: BigNumber,
    vestingBegin: BigNumber,
    vestingCliff: BigNumber,
    vestingEnd: BigNumber
  ): Promise<Vesting> {
    return await new VestingFactory(this._deployerSigner).deploy(
      token,
      recipient,
      vestingAmount,
      vestingBegin,
      vestingCliff,
      vestingEnd
    );
  }
}
