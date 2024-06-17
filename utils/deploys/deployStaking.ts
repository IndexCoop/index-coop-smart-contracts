import { Signer, BigNumberish } from "ethers";
import { Address } from "../types";
import { StakingRewardsV2 } from "../contracts/index";

import { StakingRewardsV2__factory } from "../../typechain/factories/StakingRewardsV2__factory";
import { PrtStakingPool } from "../contracts/index";
import { PrtStakingPool__factory } from "../../typechain/factories/PrtStakingPool__factory";

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

  public async deployPrtStakingPool(
    eip712Name: string,
    eip712Version: string,
    message: string,
    name: string,
    symbol: string,
    prt: Address,
    feeSplitExtension: Address,
    snapshotDelay: BigNumberish
  ): Promise<PrtStakingPool> {
    return await new PrtStakingPool__factory(this._deployerSigner).deploy(
      eip712Name,
      eip712Version,
      message,
      name,
      symbol,
      prt,
      feeSplitExtension,
      snapshotDelay
    );
  }
}
