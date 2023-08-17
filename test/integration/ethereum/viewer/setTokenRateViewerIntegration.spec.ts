import "module-alias/register";
import { ethers, network } from "hardhat";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, ether } from "@utils/index";

import { IERC20, ISetToken, SetTokenRateViewer } from "../../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "../addresses";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("SetTokenRateViewer - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let snapshotId: number;
    let viewer: SetTokenRateViewer;
    let setToken: ISetToken;
    let component: IERC20;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
    });

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
    });

    async function subject() {
      viewer = await deployer.viewers.deploySetTokenRateViewer(setToken.address, component.address);
    }

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    context("wsEth2", async () => {
      it("should get the amount of sETH2 per wsETH2 token", async () => {
        setToken = (await ethers.getContractAt("ISetToken", addresses.tokens.wsETH2)) as ISetToken;
        component = (await ethers.getContractAt("IERC20", addresses.tokens.sETH2)) as IERC20;

        await subject();

        const rate = await viewer.getRate();
        expect(rate).to.eq(ether(1));
      });

      it("should get the amount of rETH2 per wsETh2 token", async () => {
        setToken = (await ethers.getContractAt("ISetToken", addresses.tokens.wsETH2)) as ISetToken;
        component = (await ethers.getContractAt("IERC20", addresses.tokens.rETH2)) as IERC20;

        await subject();

        const rate = await viewer.getRate();
        expect(rate).to.eq(0);
      });
    });

    context("iceth", async () => {
      it("should revert on weth debt", async () => {
        setToken = (await ethers.getContractAt("ISetToken", addresses.tokens.icEth)) as ISetToken;

        component = (await ethers.getContractAt("IERC20", addresses.tokens.weth)) as IERC20;

        await subject();

        await expect(viewer.getRate()).to.be.revertedWith("SafeCast: value must be positive");
      });

      it("should get the amount of aSTETH per token", async () => {
        setToken = (await ethers.getContractAt("ISetToken", addresses.tokens.icEth)) as ISetToken;

        component = (await ethers.getContractAt("IERC20", addresses.tokens.aSTETH)) as IERC20;

        await subject();

        const rate = await viewer.getRate();
        expect(rate).to.gt(ether(2.7));
        expect(rate).to.lt(ether(2.809));
      });
    });
  });
}
