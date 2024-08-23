import "module-alias/register";
import { Account, Address, CustomOracleNAVIssuanceSettings } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { addSnapshotBeforeRestoreAfterEach, setBlockNumber } from "@utils/test/testingUtils";
// import { ProtocolUtils } from "@utils/common";
import { ethers } from "hardhat";
import { BigNumber } from "ethers";
import {
  SetToken,
  ERC4626Oracle,
  FlashMintNAV,
  IERC20,
  IERC20__factory,
  // INAVIssuanceModule__factory,
  // RebasingComponentModule,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";
import { impersonateAccount } from "./utils";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Sushiswap,
  Quickswap,
  UniV3,
  Curve,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

const addresses = PRODUCTION_ADDRESSES;

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  aEthUSDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  cUSDCv3: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  aUSDC: "0xBcca60bB61934080951369a648Fb03DF4F96263C",
  gtUSDC: "0xdd0f28e19C1780eb6396170735D45153D261490d",
};

const whales = {
  usdc: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  justin_sun: "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296", // aEthUSDC
  wan_liang: "0xCcb12611039c7CD321c0F23043c841F1d97287A5", // cUSDCv3
  mane_lee: "0xBF370B6E9d97D928497C2f2d72FD74f4D9ca5825", // aUSDC
  morpho_seeding: "0x6ABfd6139c7C3CC270ee2Ce132E309F59cAaF6a2", // gtUSDC
};

// const swapDataEmpty = {
//   exchange: Exchange.None,
//   fees: [],
//   path: [],
//   pool: ADDRESS_ZERO,
// };

const swapDataUsdcToWeth = {
  exchange: Exchange.UniV3,
  fees: [500],
  path: [addresses.tokens.USDC, addresses.tokens.weth],
  pool: ADDRESS_ZERO,
};

// const swapDataWethToUsdc = {
//   exchange: Exchange.UniV3,
//   fees: [500],
//   path: [addresses.tokens.weth, addresses.tokens.USDC],
//   pool: ADDRESS_ZERO,
// };

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintNAV - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setV2Setup: SetFixture;
    let erc4626Oracle: ERC4626Oracle;
    let setToken: SetToken;
    let flashMintNAV: FlashMintNAV;
    let usdc_erc20: IERC20;
    let aEthUSDC_erc20: IERC20;
    let cUSDCv3_erc20: IERC20;
    let aUSDC_erc20: IERC20;
    let gtUSDC_erc20: IERC20;

    setBlockNumber(20585756, true);

    before(async () => {
      [owner] = await getAccounts();

      // Sytem setup
      deployer = new DeployHelper(owner.wallet);
      setV2Setup = new SetFixture(ethers.provider, owner.address);
      setV2Setup.initialize();

      // Token setup
      usdc_erc20 = IERC20__factory.connect(addresses.tokens.USDC, owner.wallet);
      aEthUSDC_erc20 = IERC20__factory.connect(tokenAddresses.aEthUSDC, owner.wallet);
      cUSDCv3_erc20 = IERC20__factory.connect(tokenAddresses.cUSDCv3, owner.wallet);
      aUSDC_erc20 = IERC20__factory.connect(tokenAddresses.aUSDC, owner.wallet);
      gtUSDC_erc20 = IERC20__factory.connect(tokenAddresses.gtUSDC, owner.wallet);

      // Oracle setup
      await setV2Setup.priceOracle.editMasterQuoteAsset(tokenAddresses.usdc);

      const preciseUnitOracle = await deployer.setV2.deployPreciseUnitOracle("Rebasing USDC Oracle");
      await setV2Setup.priceOracle.addAdapter(preciseUnitOracle.address);
      await setV2Setup.priceOracle.addPair(tokenAddresses.usdc, tokenAddresses.usdc, preciseUnitOracle.address);
      await setV2Setup.priceOracle.addPair(tokenAddresses.aEthUSDC, tokenAddresses.usdc, preciseUnitOracle.address);
      await setV2Setup.priceOracle.addPair(tokenAddresses.cUSDCv3, tokenAddresses.usdc, preciseUnitOracle.address);
      await setV2Setup.priceOracle.addPair(tokenAddresses.aUSDC, tokenAddresses.usdc, preciseUnitOracle.address);
      erc4626Oracle = await deployer.setV2.deployERC4626Oracle(
        tokenAddresses.gtUSDC,
        usdc(1),
        "gtUSDC - USDC Calculated Oracle",
      );
      await setV2Setup.priceOracle.addAdapter(erc4626Oracle.address);
      await setV2Setup.priceOracle.addPair(tokenAddresses.gtUSDC, tokenAddresses.usdc, erc4626Oracle.address);

      // SetToken setup
      setToken = await setV2Setup.createSetToken(
        [
          tokenAddresses.usdc,
          tokenAddresses.aEthUSDC,
          tokenAddresses.cUSDCv3,
          tokenAddresses.aUSDC,
          tokenAddresses.gtUSDC,
        ],
        [
          usdc(20),
          usdc(20),
          usdc(20),
          usdc(20),
          ether(20),
        ],
        [
          setV2Setup.debtIssuanceModule.address,
          setV2Setup.rebasingComponentModule.address,
          setV2Setup.navIssuanceModule.address,
        ]
      );

      // Initialize Modules
      await setV2Setup.debtIssuanceModule.initialize(
        setToken.address,
        ZERO,
        ZERO,
        ZERO,
        owner.address,
        ADDRESS_ZERO
      );

      await setV2Setup.rebasingComponentModule.initialize(
        setToken.address,
        [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC]
      );

      const navIssuanceSettings = {
        managerIssuanceHook: setV2Setup.rebasingComponentModule.address,
        managerRedemptionHook: setV2Setup.rebasingComponentModule.address,
        setValuer: ADDRESS_ZERO,
        reserveAssets: [tokenAddresses.usdc],
        feeRecipient: owner.address,
        managerFees: [ether(0.001), ether(0.002)],
        maxManagerFee: ether(0.02),
        premiumPercentage: ether(0.01),
        maxPremiumPercentage: ether(0.1),
        minSetTokenSupply: ether(5),
      } as CustomOracleNAVIssuanceSettings;

      await setV2Setup.navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      // Issue initial units via the debt issuance module V3
      const justin_sun = await impersonateAccount(whales.justin_sun);
      const wan_liang = await impersonateAccount(whales.wan_liang);
      const mane_lee = await impersonateAccount(whales.mane_lee);
      const morpho_seeding = await impersonateAccount(whales.morpho_seeding);
      await usdc_erc20.connect(justin_sun).transfer(owner.address, usdc(1000));
      await aEthUSDC_erc20.connect(justin_sun).transfer(owner.address, usdc(10000));
      await cUSDCv3_erc20.connect(wan_liang).transfer(owner.address, usdc(10000));
      await aUSDC_erc20.connect(mane_lee).transfer(owner.address, usdc(10000));
      await gtUSDC_erc20.connect(morpho_seeding).transfer(owner.address, ether(10000));
      await usdc_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
      await aEthUSDC_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
      await cUSDCv3_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
      await aUSDC_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
      await gtUSDC_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModule.address, MAX_UINT_256);
      await setV2Setup.debtIssuanceModule.issue(setToken.address, ether(10), owner.address);

      // Deploy FlashMintNAV
      flashMintNAV = await deployer.extensions.deployFlashMintNAV(
        addresses.tokens.weth,
        addresses.dexes.uniV2.router,
        addresses.dexes.sushiswap.router,
        addresses.dexes.uniV3.router,
        addresses.dexes.uniV3.quoter,
        addresses.dexes.curve.calculator,
        addresses.dexes.curve.addressProvider,
        addresses.dexes.dexAdapterV2,
        addresses.setFork.controller,
        setV2Setup.navIssuanceModule.address,
      );
    });

    addSnapshotBeforeRestoreAfterEach();

    describe("#issue", () => {
      let subjectSetToken: SetToken;
      let subjectIssueQuantity: BigNumber;
      let subjectMinNav: BigNumber;
      let subjectSwapData: SwapData;

      beforeEach(async () => {
        subjectSetToken = setToken;
        subjectIssueQuantity = ether(1);
        subjectMinNav = ether(1);
        subjectSwapData = swapDataUsdcToWeth;
      });

      async function subject(): Promise<any> {
        return flashMintNAV.issue(subjectSetToken.address, subjectIssueQuantity, subjectMinNav, subjectSwapData);
      }

      it("should issue SetToken with USDC", async () => {
        const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
        await subject();
        const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
        expect(setTokenBalanceAfter).to.gte(setTokenBalanceBefore.add(subjectIssueQuantity));
      });
    });
  });
}
