import { Signer } from "ethers";
import { BigNumberish, BigNumber } from "@ethersproject/bignumber";

import {
  StakingRewardsV2
} from "./../contracts/index";

import { Address } from "./../types";
import { StakingRewardsV2__factory } from "../../typechain/factories/StakingRewardsV2__factory";

export default class DeployStakingContracts {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployStakingRewardsV2(
    rewardsDistribution: Address,
    rewardsToken: Address,
    stakingToken: Address,
    rewardsDuration: BigNumber,
  ): Promise<StakingRewardsV2> {
    return await new StakingRewardsV2__factory(this._deployerSigner).deploy(
      rewardsDistribution,
      rewardsToken,
      stakingToken,
      rewardsDuration
    );
  }
}
