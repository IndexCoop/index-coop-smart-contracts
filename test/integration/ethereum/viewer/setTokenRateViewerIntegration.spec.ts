import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { ethers } from "hardhat";
import {
  IERC20,
  ISetToken,
  SetTokenRateViewer,
} from "../../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "../addresses";
import { ether } from "@utils/index";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("SetTokenRateViewer - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let viewer: SetTokenRateViewer;
    let wseth2: ISetToken;
    let seth2: IERC20;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      wseth2 = (await ethers.getContractAt(
        "ISetToken",
        addresses.tokens.wsETH2,
      )) as ISetToken;

      seth2 = (await ethers.getContractAt(
        "IERC20",
        addresses.tokens.sETH2,
      )) as IERC20;

      viewer = await deployer.viewers.deploySetTokenRateViewer(wseth2.address, seth2.address);
    });

    it("should get the amount of sETH2 per wsETH2 token", async () => {
        const rate = await viewer.getRate();
        expect(rate).to.eq(ether(1));
    });
  });
}
