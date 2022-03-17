import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import { ethers } from "hardhat";
import { utils } from "ethers";
import { ExchangeIssuanceLeveraged } from "@utils/contracts/index";
import { SetFixture } from "@utils/fixtures";
import addresses from "./addresses";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceLeveraged - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setV2Setup: SetFixture;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      setV2Setup = getSetFixture(owner.address);
      await setV2Setup.initialize();
    });

    it("can get lending pool from address provider", async () => {
      const addressProvider = await ethers.getContractAt(
        "ILendingPoolAddressesProviderV2",
        addresses.lending.aave.addressProvider,
      );
      const lendingPool = await addressProvider.getLendingPool();
      expect(lendingPool).to.eq("0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9");
    });

    context("When exchange issuance is deployed", () => {
      let exchangeIssuance: ExchangeIssuanceLeveraged;
      before(async () => {
        exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.set.controller,
          addresses.set.debtIssuanceModuleV2,
          addresses.set.aaveLeverageModule,
          addresses.lending.aave.addressProvider,
          addresses.dexes.curve.calculator,
          addresses.dexes.curve.addressProvider,
        );
      });

      it("weth address is set correctly", async () => {
        expect(await exchangeIssuance.WETH()).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        expect(await exchangeIssuance.sushiRouter()).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        // TODO: Review / Fix misleading name quick vs. uniV2
        expect(await exchangeIssuance.quickRouter()).to.eq(
          utils.getAddress(addresses.dexes.uniV2.router),
        );
      });

      it("uniV3 router address is set correctly", async () => {
        expect(await exchangeIssuance.uniV3Router()).to.eq(
          utils.getAddress(addresses.dexes.uniV3.router),
        );
      });

      it("controller address is set correctly", async () => {
        expect(await exchangeIssuance.setController()).to.eq(
          utils.getAddress(addresses.set.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await exchangeIssuance.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.set.debtIssuanceModuleV2),
        );
      });
    });
  });
}
