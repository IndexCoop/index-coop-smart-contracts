import "module-alias/register";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { setBlockNumber, setBalance } from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import { PRODUCTION_ADDRESSES } from "./addresses";
import {
  IWETH,
  IERC20__factory,
  IDebtIssuanceModule,
  IDebtIssuanceModule__factory,
  ExchangeIssuanceIcEth,
} from "../../../typechain";

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

// Run only if integration testing is enabled
if (process.env.INTEGRATIONTEST) {
  describe.only("ExchangeIssuanceIcEth - Redeem deleveraged icETH for ETH (Curve)", () => {
    const addresses = PRODUCTION_ADDRESSES;

    let owner: Account;
    let deployer: DeployHelper;
    let operator: Signer;

    let flashMint: ExchangeIssuanceIcEth;

    const icEthHolder = "0x37e6365d4f6aE378467b0e24c9065Ce5f06D70bF"; // Index deployer

    // Use a recent mainnet block where icETH is deleveraged with stETH aToken + WETH dust
    setBlockNumber(23673905, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      console.log("Deploying ExchangeIssuanceIcEth...");

      // Deploy FlashMint contract variant with Curve support
      // Use Aave V2 address provider since icETH has Aave V2 aTokens
      flashMint = await deployer.extensions.deployExchangeIssuanceIcEth(
        addresses.tokens.weth,
        addresses.dexes.uniV2.router,
        addresses.dexes.sushiswap.router,
        addresses.dexes.uniV3.router,
        addresses.dexes.uniV3.quoter,
        addresses.set.controller,
        addresses.set.debtIssuanceModuleV2,
        addresses.set.aaveLeverageModule,
        addresses.lending.aave.addressProvider,
        addresses.dexes.curve.calculator,
        addresses.dexes.curve.addressProvider,
      );

      console.log("Deployed ExchangeIssuanceIcEth to:", flashMint.address);

      // Impersonate icETH deployer/holder and fund with ETH for gas
      operator = await impersonateAccount(icEthHolder);
      await setBalance(icEthHolder, ethers.utils.parseEther("5"));
      flashMint = flashMint.connect(operator);

      // Approve the SetToken for the flashMint contract
      console.log("Approving SetToken for FlashMint contract...");
      await flashMint.approveSetToken(addresses.tokens.icEth);
    });

    it("has two equity components (aSTETH + WETH) and no debt", async () => {
      const debtIssuance: IDebtIssuanceModule = IDebtIssuanceModule__factory.connect(
        addresses.set.debtIssuanceModuleV2,
        owner.wallet,
      );
      const oneIcEth = ethers.utils.parseEther("1");
      console.log("Fetching required components for 1 icETH...");
      const [components, equityPositions, debtPositions] = await debtIssuance.getRequiredComponentRedemptionUnits(
        addresses.tokens.icEth,
        oneIcEth,
      );
      console.log("Components:", components);
      console.log("Equity Positions:", equityPositions);
      console.log("Debt Positions:", debtPositions);

      expect(components.length).to.eq(2);
      // Expect aSTETH and WETH as components
      const hasASteth = components.map(addr => addr.toLowerCase()).includes(addresses.tokens.aSTETH.toLowerCase());
      const hasWeth = components.map(addr => addr.toLowerCase()).includes(addresses.tokens.weth.toLowerCase());
      expect(hasASteth).to.eq(true);
      expect(hasWeth).to.eq(true);

      // Both equity components should be positive, with no debt
      expect(equityPositions[0].gt(0)).to.eq(true);
      expect(equityPositions[1].gt(0)).to.eq(true);
      expect(debtPositions[0].eq(0)).to.eq(true);
      expect(debtPositions[1].eq(0)).to.eq(true);
    });

    it("redeems current deleveraged icETH for ETH (Curve stETH-ETH + WETH unwrap)", async () => {
      const icEth = IERC20__factory.connect(addresses.tokens.icEth, operator);
      const weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;

      const holderAddress = await operator.getAddress();
      const startEth = await ethers.provider.getBalance(holderAddress);
      const icEthBal = await icEth.balanceOf(holderAddress);

      expect(icEthBal.gt(0)).to.eq(true);

      const redeemAmount = icEthBal; // redeem full balance held by deployer

      // Approve FlashMint to transfer icETH
      await icEth.connect(operator).approve(flashMint.address, redeemAmount);

      // SwapData for dust: WETH -> WETH (no-op) so we can unwrap to ETH
      const dustSwapData: SwapData = {
        path: [addresses.tokens.weth, addresses.tokens.weth],
        fees: [],
        pool: ethers.constants.AddressZero,
        exchange: Exchange.None,
      };

      // SwapData for collateral: stETH -> ETH via Curve stETH-ETH pool
      const collateralSwapData: SwapData = {
        path: [addresses.tokens.stEth, addresses.dexes.curve.ethAddress],
        fees: [],
        pool: addresses.dexes.curve.pools.stEthEth,
        exchange: Exchange.Curve,
      };

      // Redeem for ETH (minAmountOutputToken set to 0 for flexibility in test env)
      const tx = await flashMint.redeemExactSetForETH(
        addresses.tokens.icEth,
        redeemAmount,
        0,
        dustSwapData,
        collateralSwapData,
      );

      await tx.wait();

      const endEth = await ethers.provider.getBalance(holderAddress);
      const endIcEth = await icEth.balanceOf(holderAddress);

      const endFlashMintWethBal = await weth.balanceOf(flashMint.address);
      expect(endFlashMintWethBal.eq(0)).to.eq(true);

      // icETH balance should decrease to near zero (allow minimal dust)
      expect(endIcEth.lte(1)).to.eq(true);
      expect(endEth.gt(startEth)).to.eq(true);
    });
  });
}
