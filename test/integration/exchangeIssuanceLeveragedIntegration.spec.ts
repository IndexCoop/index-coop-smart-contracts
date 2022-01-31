import "module-alias/register";
import { Address, Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { SetToken } from "@utils/contracts/setV2";
import { ethers } from "hardhat";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceLeveraged - Integration Test", async () => {
    const eth2xFliPAddress: Address = "0x3ad707da309f3845cd602059901e39c4dcd66473";
    const wethAmAddress: Address = "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390";
    const usdcAddress: Address = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    let owner: Account;
    let eth2xFli: SetToken;
    let deployer: DeployHelper;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      eth2xFli = (await ethers.getContractAt("ISetToken", eth2xFliPAddress)) as SetToken;
    });

    it("should return correct components", async () => {
      console.log(deployer.extensions);
      const components = await eth2xFli.getComponents();
      expect(components[0]).to.equal(wethAmAddress);
      expect(components[1]).to.equal(usdcAddress);
    });
  });
}
