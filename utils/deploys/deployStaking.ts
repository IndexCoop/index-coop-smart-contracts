import { Signer, BigNumberish } from "ethers";
import { Address } from "../types";
import { StakingRewardsV2 } from "../contracts/index";

import { StakingRewardsV2__factory } from "../../typechain/factories/StakingRewardsV2__factory";

export default class DeployStaking {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployStakingRewardsV2(
    owner: Address,
    rewardToken: Address,
    stakingToken: Address,
    duration: BigNumberish
  ): Promise<StakingRewardsV2> {
    return await new StakingRewardsV2__factory(this._deployerSigner).deploy(
      owner,
      rewardToken,
      stakingToken,
      duration
    );
  }
}
