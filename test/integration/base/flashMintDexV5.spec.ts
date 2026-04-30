import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";
import { FlashMintDexV5 } from "../../../typechain";
import { IERC20, IWETH } from "../../../typechain";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/index";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
  Curve,
  BalancerV2,
  Aerodrome,
  AerodromeSlipstream,
}

type SwapData = {
  path: Address[];
  fees: number[];
  tickSpacing: number[];
  pool: Address;
  poolIds: BytesLike[];
  exchange: Exchange;
};

const noopSwap: SwapData = {
  path: [],
  fees: [],
  tickSpacing: [],
  pool: ADDRESS_ZERO,
  poolIds: [],
  exchange: Exchange.None,
};

// Base mainnet addresses
const wethAddress = "0x4200000000000000000000000000000000000006";
const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const debtIssuanceModuleAddress = "0xa30E87311407dDcF1741901A8F359b6005252F22";
// Set Protocol legacy + Index Coop fork controllers — only the index controller is used
// for the delevered Morpho products on Base, but the constructor takes both.
const setControllerAddress = "0x1246553a53Cd2897EB26beE87a0dB0Fb456F39d1";
const indexControllerAddress = "0x1246553a53Cd2897EB26beE87a0dB0Fb456F39d1";

// DEXAdapterV5 addresses (Base)
const sushiRouterAddress = "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891";
const uniV3RouterAddress = "0x2626664c2603336E57B271c5C0b26F421741e481";
const uniV3QuoterAddress = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const curveAddressProvider = "0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98";
const curveCalculator = "0xEfadDdE5B43917CcC738AdE6962295A0B343f7CE";
const balV2Vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const aerodromeRouterAddress = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const aerodromeFactoryAddress = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const aerodromeSlipstreamRouterAddress = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const aerodromeSlipstreamQuoterAddress = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";

// Delevered Morpho leverage tokens (post-disengage on Base)
const uSOL = "0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55";
const uSUI = "0xb0505e5a99abd03d94a1169e638B78EDfEd26ea4";
const uSOL2x = "0x0A0Fbd86d2dEB53D7C65fecF8622c2Fa0DCdc9c6";
const uSUI2x = "0x2F67e4bE7fBF53dB88881324AAc99e9D85208d40";
const uSOL3x = "0x16c469F88979e19A53ea522f0c77aFAD9A043571";

// WETH whale on Base — Aerodrome SlipStream uSOL/WETH pool, ~50 WETH
const wethWhale = "0x0225Ba893D5f8Ecd6d2022f9dEC59b34F61098A1";

// AerodromeSlipstream pools for the collateral assets all use tickSpacing=200 (verified
// on-chain via cast).
const slipstreamTickSpacing = 200;

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintDexV5 - Base Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let weth: IWETH;
    let flashMintDexV5: FlashMintDexV5;

    // Recent post-disengage state. Pinned to a block where the SetToken's
    // component balances have drifted from their stored default position units
    // (e.g. via subsequent mint/redeem activity), which is the state the
    // production FlashMintDexV5 sees and which surfaces a 1-wei-per-set
    // rounding gap between the issuance module's external view and its
    // internal pull (see the regression spec below).
    setBlockNumber(45340000, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      weth = (await ethers.getContractAt("IWETH", wethAddress)) as IWETH;

      flashMintDexV5 = await deployer.extensions.deployFlashMintDexV5(
        wethAddress,
        ADDRESS_ZERO, // quickRouter — n/a on Base
        sushiRouterAddress,
        uniV3RouterAddress,
        uniV3QuoterAddress,
        curveCalculator,
        curveAddressProvider,
        balV2Vault,
        aerodromeRouterAddress,
        aerodromeFactoryAddress,
        aerodromeSlipstreamRouterAddress,
        aerodromeSlipstreamQuoterAddress,
        setControllerAddress,
        indexControllerAddress,
      );
    });

    it("constructor wires DEXAdapterV5.Addresses (V5 fields included)", async () => {
      const a = await flashMintDexV5.dexAdapter();
      expect(a.weth).to.eq(wethAddress);
      expect(a.uniV3Router).to.eq(uniV3RouterAddress);
      expect(a.aerodromeRouter).to.eq(aerodromeRouterAddress);
      expect(a.aerodromeFactory).to.eq(aerodromeFactoryAddress);
      expect(a.aerodromeSlipstreamRouter).to.eq(aerodromeSlipstreamRouterAddress);
      expect(a.aerodromeSlipstreamQuoter).to.eq(aerodromeSlipstreamQuoterAddress);
    });

    // Helper: take WETH from a known LP, hand it to `recipient`.
    async function fundWeth(recipient: Address, amount: BigNumber) {
      const whaleSigner = await impersonateAccount(wethWhale);
      // Top up ETH on the whale so it can pay gas.
      await ethers.provider.send("hardhat_setBalance", [
        wethWhale,
        "0x56BC75E2D63100000",
      ]);
      await weth.connect(whaleSigner).transfer(recipient, amount);
    }

    // For each product we want to verify that the contract can issue and redeem with WETH input.
    // The two specs below cover the two structurally interesting cases:
    //   - uSUI2x: Aerodrome-only collateral, 1 component (no Uniswap V3 liquidity exists for uSUI on Base)
    //   - uSOL3x: Aerodrome collateral + USDC dust as a second component (multi-component path)
    describe("uSUI2x — Aerodrome-only single-component delevered token", () => {
      const setAmount = ether(0.001);
      let setToken: IERC20;

      const componentSwapData: SwapData[] = [
        {
          // WETH → uSUI on Aerodrome SlipStream (tickSpacing 200)
          path: [wethAddress, uSUI],
          fees: [],
          tickSpacing: [slipstreamTickSpacing],
          pool: ADDRESS_ZERO,
          poolIds: [],
          exchange: Exchange.AerodromeSlipstream,
        },
      ];

      before(async () => {
        setToken = (await ethers.getContractAt("IERC20", uSUI2x)) as IERC20;
        await flashMintDexV5.approveSetToken(uSUI2x, debtIssuanceModuleAddress);
      });

      it("issues uSUI2x from WETH and redeems back", async () => {
        // Get an estimate of how much WETH the issuance needs, then add a small buffer.
        const wethEstimate = await flashMintDexV5.callStatic.getIssueExactSet(
          {
            setToken: uSUI2x,
            amountSetToken: setAmount,
            componentSwapData,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          noopSwap,
        );
        const maxWeth = wethEstimate.mul(105).div(100); // 5% buffer

        await fundWeth(owner.address, maxWeth);
        await weth.approve(flashMintDexV5.address, maxWeth);

        const setBefore = await setToken.balanceOf(owner.address);
        await flashMintDexV5.issueExactSetFromERC20(
          {
            setToken: uSUI2x,
            amountSetToken: setAmount,
            componentSwapData,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          {
            token: wethAddress,
            limitAmt: maxWeth,
            swapDataTokenToWeth: noopSwap,
            swapDataWethToToken: noopSwap,
          },
          0,
        );
        const setAfter = await setToken.balanceOf(owner.address);
        expect(setAfter.sub(setBefore)).to.eq(setAmount);

        // Redeem the just-issued amount back to WETH
        const redeemSwap: SwapData = {
          path: [uSUI, wethAddress],
          fees: [],
          tickSpacing: [slipstreamTickSpacing],
          pool: ADDRESS_ZERO,
          poolIds: [],
          exchange: Exchange.AerodromeSlipstream,
        };
        await setToken.connect(owner.wallet).approve(flashMintDexV5.address, setAmount);

        const wethBefore = await weth.balanceOf(owner.address);
        await flashMintDexV5.redeemExactSetForERC20(
          {
            setToken: uSUI2x,
            amountSetToken: setAmount,
            componentSwapData: [redeemSwap],
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          {
            token: wethAddress,
            limitAmt: 1, // minimum we'll accept
            swapDataTokenToWeth: noopSwap,
            swapDataWethToToken: noopSwap,
          },
        );
        const wethAfter = await weth.balanceOf(owner.address);
        expect(wethAfter).to.be.gt(wethBefore);
      });
    });

    describe("uSOL3x — multi-component (collateral + USDC dust)", () => {
      // Needs to be large enough that the 11-wei-per-set USDC component isn't
      // below Uniswap V3 quoter precision. At 1 setToken the USDC side is
      // ~11000 wei (0.011 USDC) which the pool prices cleanly.
      const setAmount = ether(1);
      let setToken: IERC20;

      // Component order on uSOL3x is [uSOL, USDC]; build swap data in matching order.
      const componentSwapData: SwapData[] = [
        {
          path: [wethAddress, uSOL],
          fees: [],
          tickSpacing: [slipstreamTickSpacing],
          pool: ADDRESS_ZERO,
          poolIds: [],
          exchange: Exchange.AerodromeSlipstream,
        },
        {
          // WETH → USDC on Uniswap V3 0.05% (well-known liquid pool on Base)
          path: [wethAddress, usdcAddress],
          fees: [500],
          tickSpacing: [],
          pool: ADDRESS_ZERO,
          poolIds: [],
          exchange: Exchange.UniV3,
        },
      ];

      before(async () => {
        setToken = (await ethers.getContractAt("IERC20", uSOL3x)) as IERC20;
        await flashMintDexV5.approveSetToken(uSOL3x, debtIssuanceModuleAddress);
      });

      it("issues uSOL3x from WETH and redeems back", async () => {
        const wethEstimate = await flashMintDexV5.callStatic.getIssueExactSet(
          {
            setToken: uSOL3x,
            amountSetToken: setAmount,
            componentSwapData,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          noopSwap,
        );
        const maxWeth = wethEstimate.mul(105).div(100);

        await fundWeth(owner.address, maxWeth);
        await weth.approve(flashMintDexV5.address, maxWeth);

        const setBefore = await setToken.balanceOf(owner.address);
        await flashMintDexV5.issueExactSetFromERC20(
          {
            setToken: uSOL3x,
            amountSetToken: setAmount,
            componentSwapData,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          {
            token: wethAddress,
            limitAmt: maxWeth,
            swapDataTokenToWeth: noopSwap,
            swapDataWethToToken: noopSwap,
          },
          0,
        );
        const setAfter = await setToken.balanceOf(owner.address);
        expect(setAfter.sub(setBefore)).to.eq(setAmount);

        const redeemSwap: SwapData[] = [
          {
            path: [uSOL, wethAddress],
            fees: [],
            tickSpacing: [slipstreamTickSpacing],
            pool: ADDRESS_ZERO,
            poolIds: [],
            exchange: Exchange.AerodromeSlipstream,
          },
          {
            path: [usdcAddress, wethAddress],
            fees: [500],
            tickSpacing: [],
            pool: ADDRESS_ZERO,
            poolIds: [],
            exchange: Exchange.UniV3,
          },
        ];
        await setToken.connect(owner.wallet).approve(flashMintDexV5.address, setAmount);
        const wethBefore = await weth.balanceOf(owner.address);
        await flashMintDexV5.redeemExactSetForERC20(
          {
            setToken: uSOL3x,
            amountSetToken: setAmount,
            componentSwapData: redeemSwap,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          {
            token: wethAddress,
            limitAmt: 1,
            swapDataTokenToWeth: noopSwap,
            swapDataWethToToken: noopSwap,
          },
        );
        const wethAfter = await weth.balanceOf(owner.address);
        expect(wethAfter).to.be.gt(wethBefore);
      });
    });

    // Regression: at non-trivial setAmounts the issue path used to revert with
    // ERC20InsufficientBalance because _buyComponentsWithWeth swapped for the
    // amount returned by DebtIssuanceModuleV3.getRequiredComponentIssuanceUnits
    // (balance-derived equity units via _getTotalIssuanceUnitsFromBalances)
    // while issue() internally pulls equity units derived from stored position
    // units (_getTotalIssuanceUnits) — these can disagree by 1 wei per set
    // when the SetToken's component balance has been rounded relative to its
    // stored default position. At setAmount=10e18 that's a 10-wei deficit on
    // the swap output, which trips the SafeERC20 transferFrom inside the V3
    // _resolveEquityPositions hook.
    describe("regression: 10-set issuance survives position/balance rounding gap", () => {
      const setAmount = ether(10);
      let setToken: IERC20;

      const componentSwapData: SwapData[] = [
        {
          path: [wethAddress, uSOL],
          fees: [],
          tickSpacing: [slipstreamTickSpacing],
          pool: ADDRESS_ZERO,
          poolIds: [],
          exchange: Exchange.AerodromeSlipstream,
        },
      ];

      before(async () => {
        setToken = (await ethers.getContractAt("IERC20", uSOL2x)) as IERC20;
        await flashMintDexV5.approveSetToken(uSOL2x, debtIssuanceModuleAddress);
      });

      it("issues uSOL2x at setAmount=10 from WETH", async () => {
        const wethEstimate = await flashMintDexV5.callStatic.getIssueExactSet(
          {
            setToken: uSOL2x,
            amountSetToken: setAmount,
            componentSwapData,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          noopSwap,
        );
        const maxWeth = wethEstimate.mul(105).div(100);

        await fundWeth(owner.address, maxWeth);
        await weth.approve(flashMintDexV5.address, maxWeth);

        const setBefore = await setToken.balanceOf(owner.address);
        await flashMintDexV5.issueExactSetFromERC20(
          {
            setToken: uSOL2x,
            amountSetToken: setAmount,
            componentSwapData,
            issuanceModule: debtIssuanceModuleAddress,
            isDebtIssuance: true,
          },
          {
            token: wethAddress,
            limitAmt: maxWeth,
            swapDataTokenToWeth: noopSwap,
            swapDataWethToToken: noopSwap,
          },
          0,
        );
        const setAfter = await setToken.balanceOf(owner.address);
        expect(setAfter.sub(setBefore)).to.eq(setAmount);
      });
    });
  });
}
