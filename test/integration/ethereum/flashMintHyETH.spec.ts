import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { cacheBeforeEach } from "@utils/test";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import {
  IWETH,
  StandardTokenMock,
  IDebtIssuanceModule,
  IERC20__factory,
  AaveV3LeverageStrategyExtension__factory,
  FlashMintHyETH,
  FlashMintHyETH__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("FlashMintHyETH - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let rEth: StandardTokenMock;
    let setToken: StandardTokenMock;
    let weth: IWETH;

    // const collateralTokenAddress = addresses.tokens.stEth;
    setBlockNumber(17665622);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
    });

    context("When exchange issuance is deployed", () => {
      let flashMintHyETH: FlashMintHyETH;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintHyETH(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.dexes.curve.calculator,
          addresses.dexes.curve.addressProvider,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2,
          addresses.tokens.steth,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("controller address is set correctly", async () => {
        expect(await flashMintLeveraged.setController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintLeveraged.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.setFork.debtIssuanceModuleV2),
        );
      });
    });
  });
}
