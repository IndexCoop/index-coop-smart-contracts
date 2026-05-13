import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { ethers } from "hardhat";
import { BigNumber } from "ethers";
import { ether } from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { impersonateAccount, setBlockNumber, setBalance } from "@utils/test/testingUtils";
import { PRODUCTION_ADDRESSES } from "./addresses";
import {
  AaveV3DeleveredRedeemer,
  IAToken__factory,
  IDebtIssuanceModule__factory,
  IERC20__factory,
  IPool__factory,
} from "../../../typechain";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe.only("AaveV3DeleveredRedeemer - Arbitrum Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let recipient: Account;
    let deployer: DeployHelper;
    let redeemer: AaveV3DeleveredRedeemer;

    // Pin to a recent block where AAVE2x and LINK2x are in their fully-delevered
    // post-disengage state. After this block the components on-chain are
    // [aArbAAVE] (AAVE2x) and [aArbLINK, USDT-dust] (LINK2x). The disengage
    // tx referenced by the user landed at block 454_864_215, so anything later
    // works; pinned to a round number for reproducibility.
    setBlockNumber(459_500_000, false);

    // A fresh, mainnet-unused recipient. Hardhat's default mnemonic signers
    // (0xf39F…2266, 0x7099…79C8, etc.) all happen to have contract code on
    // Arbitrum mainnet at this fork block, so sending ETH to them via
    // `Address.sendValue` reverts. Use a deterministic burn-style address that
    // is guaranteed to be a fresh EOA on the fork.
    const FRESH_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

    before(async () => {
      [owner, recipient] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      redeemer = await deployer.extensions.deployAaveV3DeleveredRedeemer(
        addresses.lending.aaveV3.lendingPool,
        addresses.setFork.debtIssuanceModuleV3,
        addresses.tokens.weth,
        ADDRESS_ZERO,                   // quickRouter — n/a on Arbitrum
        addresses.dexes.sushiswap.router,
        addresses.dexes.uniV3.router,
        addresses.dexes.uniV3.quoter,
        ADDRESS_ZERO,                   // curveCalculator — unused for Arbitrum AAVE/LINK paths
        addresses.dexes.curve.addressProvider,
        addresses.dexes.balancerv2.vault,
      );
    });

    it("constructor wires immutables", async () => {
      expect(await redeemer.pool()).to.eq(addresses.lending.aaveV3.lendingPool);
      expect(await redeemer.issuanceModule()).to.eq(addresses.setFork.debtIssuanceModuleV3);
      const a = await redeemer.addresses();
      // The contract returns checksummed addresses; the test addresses file
      // mixes cases, so compare lower-cased.
      expect(a.weth.toLowerCase()).to.eq(addresses.tokens.weth.toLowerCase());
      expect(a.uniV3Router.toLowerCase()).to.eq(addresses.dexes.uniV3.router.toLowerCase());
      expect(a.uniV3Quoter.toLowerCase()).to.eq(addresses.dexes.uniV3.quoter.toLowerCase());
    });

    // Sanity check on the load-bearing assumption that aArbAAVE / aArbLINK
    // expose UNDERLYING_ASSET_ADDRESS() and that the returned address is the
    // canonical Arbitrum AAVE / LINK token. If this ever changes the redeemer's
    // try/catch fallback would silently transfer aTokens to the user — bad UX.
    describe("aToken interface assumption", () => {
      it("aArbAAVE.UNDERLYING_ASSET_ADDRESS() returns AAVE", async () => {
        const aAave = IAToken__factory.connect(addresses.tokens.aAave, ethers.provider);
        expect(await aAave.UNDERLYING_ASSET_ADDRESS()).to.eq(addresses.tokens.aave);
      });

      it("aArbLINK.UNDERLYING_ASSET_ADDRESS() returns LINK", async () => {
        const aLink = IAToken__factory.connect(addresses.tokens.aLink, ethers.provider);
        expect(await aLink.UNDERLYING_ASSET_ADDRESS()).to.eq(addresses.tokens.link);
      });

      it("USDT does NOT expose UNDERLYING_ASSET_ADDRESS() (so the catch fallback fires)", async () => {
        const usdtAsAToken = IAToken__factory.connect(addresses.tokens.usdt, ethers.provider);
        await expect(usdtAsAToken.UNDERLYING_ASSET_ADDRESS()).to.be.reverted;
      });
    });

    // Sanity check on the second load-bearing assumption: IPool.withdraw with
    // amount = type(uint256).max should burn the caller's full aToken balance
    // and return the actual underlying delivered.
    describe("IPool.withdraw(MaxUint256) semantics", () => {
      it("withdraws the full aToken balance and returns the actual amount", async () => {
        const pool = IPool__factory.connect(addresses.lending.aaveV3.lendingPool, ethers.provider);
        const aAave = IERC20__factory.connect(addresses.tokens.aAave, ethers.provider);
        const aave = IERC20__factory.connect(addresses.tokens.aave, ethers.provider);

        // Fund a fresh test account with aArbAAVE from the collector.
        await setBalance(addresses.whales.aaveV3ArbCollector, ether(100));
        const collector = await impersonateAccount(addresses.whales.aaveV3ArbCollector);
        const sample = ether(0.5);
        await aAave.connect(collector).transfer(recipient.address, sample);

        const aBefore = await aAave.balanceOf(recipient.address);
        const underBefore = await aave.balanceOf(recipient.address);
        expect(aBefore).to.be.gte(sample);

        // The recipient calls withdraw on its own aTokens.
        await (
          await pool
            .connect(recipient.wallet)
            .withdraw(addresses.tokens.aave, MAX_UINT_256, recipient.address)
        ).wait();

        const aAfter = await aAave.balanceOf(recipient.address);
        const underAfter = await aave.balanceOf(recipient.address);
        expect(aAfter).to.eq(ZERO); // entire aToken balance burned
        expect(underAfter.sub(underBefore)).to.be.gte(aBefore.sub(BigNumber.from(1))); // index round-down
      });
    });

    // Per-product end-to-end coverage: acquire aTokens (and USDT for LINK2x)
    // from the Aave V3 Arbitrum Collector, issue the SetToken via
    // DebtIssuanceModuleV3 directly, then redeem via the new redeemer and
    // assert the recipient gets the underlying.
    interface ProductCase {
      name: string;
      setToken: string;
      collateralAToken: string;
      collateralUnderlying: string;
      // Whether the SetToken also has a USDT component (LINK2x has 9150 wei dust).
      hasUsdtDust: boolean;
      // setAmount to test with — keep small relative to total supply so we can
      // exit the issued amount cleanly.
      setAmount: BigNumber;
    }

    const PRODUCTS: ProductCase[] = [
      {
        name: "AAVE2x",
        setToken: addresses.tokens.aave2x,
        collateralAToken: addresses.tokens.aAave,
        collateralUnderlying: addresses.tokens.aave,
        hasUsdtDust: false,
        setAmount: ether(0.01),
      },
      {
        name: "LINK2x",
        setToken: addresses.tokens.link2x,
        collateralAToken: addresses.tokens.aLink,
        collateralUnderlying: addresses.tokens.link,
        hasUsdtDust: true,
        setAmount: ether(0.05),
      },
    ];

    for (const product of PRODUCTS) {
      describe(`${product.name}`, () => {
        it("issues via V3 module then redeems via the new redeemer to recipient", async () => {
          const setTokenERC20 = IERC20__factory.connect(product.setToken, ethers.provider);
          const aToken = IERC20__factory.connect(product.collateralAToken, ethers.provider);
          const underlying = IERC20__factory.connect(product.collateralUnderlying, ethers.provider);
          const usdt = IERC20__factory.connect(addresses.tokens.usdt, ethers.provider);
          const issuanceModule = IDebtIssuanceModule__factory.connect(
            addresses.setFork.debtIssuanceModuleV3,
            ethers.provider,
          );

          // === Issue setup ===
          // Fund the owner with the components needed to issue `setAmount` of
          // the SetToken via the V3 module.
          const required = await issuanceModule.callStatic.getRequiredComponentIssuanceUnits(
            product.setToken,
            product.setAmount,
          );
          // Component[0] is the collateral aToken. For LINK2x component[1] is USDT.
          const aTokenNeeded = required[1][0];
          const usdtNeeded = product.hasUsdtDust ? required[1][1] : ZERO;

          await setBalance(addresses.whales.aaveV3ArbCollector, ether(100));
          const collector = await impersonateAccount(addresses.whales.aaveV3ArbCollector);

          // 10% buffer on the aToken side to absorb Aave index drift between the
          // view call and the issue call's internal sync.
          await aToken.connect(collector).transfer(owner.address, aTokenNeeded.mul(110).div(100));
          if (usdtNeeded.gt(ZERO)) {
            await usdt.connect(collector).transfer(owner.address, usdtNeeded.mul(110).div(100));
          }

          // Approve the V3 module then issue.
          await aToken.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
          if (usdtNeeded.gt(ZERO)) {
            await usdt.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
          }
          await issuanceModule
            .connect(owner.wallet)
            .issue(product.setToken, product.setAmount, owner.address);

          // V3 module charges a 0.2% issue fee on both AAVE2x and LINK2x — the
          // recipient's actual balance is `setAmount * (1 - feeBps/10000)`.
          // Use the actually-minted amount for the redeem step.
          const actualMinted = await setTokenERC20.balanceOf(owner.address);
          expect(actualMinted).to.be.gt(product.setAmount.mul(99).div(100));
          expect(actualMinted).to.be.lte(product.setAmount);

          // === Redeem via the new redeemer ===
          await setTokenERC20.connect(owner.wallet).approve(redeemer.address, MAX_UINT_256);

          const recipientUnderBefore = await underlying.balanceOf(recipient.address);
          const recipientUsdtBefore = await usdt.balanceOf(recipient.address);
          const setSupplyBefore = await setTokenERC20.totalSupply();
          const redeemerATokenBefore = await aToken.balanceOf(redeemer.address);
          const redeemerUnderBefore = await underlying.balanceOf(redeemer.address);

          // Read expected per-component redemption units BEFORE redeem (the V3
          // module's view returns the same per-share amount regardless of who
          // calls or when, modulo Aave index drift).
          const redeemRequired = await issuanceModule.callStatic.getRequiredComponentRedemptionUnits(
            product.setToken,
            actualMinted,
          );
          const expectedUnderlying = redeemRequired[1][0];
          const expectedUsdt = product.hasUsdtDust ? redeemRequired[1][1] : ZERO;

          await redeemer
            .connect(owner.wallet)
            .redeem(product.setToken, actualMinted, recipient.address);

          // SetToken supply burned by the redeemed amount (modulo redeem fee).
          // V3 charges 0.2% redeem fee — the supply burn equals actualMinted, but
          // the components delivered are computed against (actualMinted - fee).
          const supplyBurned = setSupplyBefore.sub(await setTokenERC20.totalSupply());
          expect(supplyBurned).to.be.gte(actualMinted.mul(99).div(100));
          expect(supplyBurned).to.be.lte(actualMinted);

          // Recipient received the underlying. Lower bound: at least the
          // expected per-set redemption unit minus 10 wei (Aave index rounding).
          // Upper bound: a small positive drift (10 bps over the expected) is
          // acceptable — aTokens accrue interest continuously, so the underlying
          // delivered between the view call and the actual IPool.withdraw can
          // be slightly more than the view number.
          const underDelta = (await underlying.balanceOf(recipient.address)).sub(recipientUnderBefore);
          expect(underDelta).to.be.gte(expectedUnderlying.sub(BigNumber.from(10)));
          expect(underDelta).to.be.lte(expectedUnderlying.mul(10001).div(10000));

          // For LINK2x: the USDT dust component is forwarded as-is.
          if (product.hasUsdtDust) {
            const usdtDelta = (await usdt.balanceOf(recipient.address)).sub(recipientUsdtBefore);
            expect(usdtDelta).to.eq(expectedUsdt);
          }

          // No leakage — redeemer holds zero of the collateral aToken and zero
          // of the underlying after the call.
          expect(await aToken.balanceOf(redeemer.address)).to.eq(redeemerATokenBefore);
          expect(await underlying.balanceOf(redeemer.address)).to.eq(redeemerUnderBefore);
        });

        it("recipient defaults to msg.sender when redeem(.., address(0)) is passed", async () => {
          // Issue a small amount, redeem with recipient=0, assert sender received
          // the underlying instead of recipient.
          const setTokenERC20 = IERC20__factory.connect(product.setToken, ethers.provider);
          const aToken = IERC20__factory.connect(product.collateralAToken, ethers.provider);
          const underlying = IERC20__factory.connect(product.collateralUnderlying, ethers.provider);
          const usdt = IERC20__factory.connect(addresses.tokens.usdt, ethers.provider);
          const issuanceModule = IDebtIssuanceModule__factory.connect(
            addresses.setFork.debtIssuanceModuleV3,
            ethers.provider,
          );

          const small = product.setAmount.div(10);
          const required = await issuanceModule.callStatic.getRequiredComponentIssuanceUnits(
            product.setToken,
            small,
          );
          await setBalance(addresses.whales.aaveV3ArbCollector, ether(100));
          const collector = await impersonateAccount(addresses.whales.aaveV3ArbCollector);
          await aToken.connect(collector).transfer(owner.address, required[1][0].mul(110).div(100));
          if (product.hasUsdtDust) {
            await usdt.connect(collector).transfer(owner.address, required[1][1].mul(110).div(100));
          }

          await aToken.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
          if (product.hasUsdtDust) {
            await usdt.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
          }
          await issuanceModule.connect(owner.wallet).issue(product.setToken, small, owner.address);

          await setTokenERC20.connect(owner.wallet).approve(redeemer.address, MAX_UINT_256);
          const ownerUnderBefore = await underlying.balanceOf(owner.address);

          await redeemer.connect(owner.wallet).redeem(product.setToken, small, ADDRESS_ZERO);

          const ownerUnderAfter = await underlying.balanceOf(owner.address);
          expect(ownerUnderAfter).to.be.gt(ownerUnderBefore);
        });
      });
    }

    // ── DEX-routed exits — redeemForToken / redeemForETH ────────────────────────────
    //
    // Per-component swap data is FROM the component's underlying TO the requested
    // output. For aTokens we go via Pool.withdraw to underlying first; the swap
    // step then sees the underlying. For dust components (LINK2x's USDT) the
    // swap goes from USDT → output too.
    //
    // Exchange enum mirrors DEXAdapterV3:
    //   None=0, Quickswap=1, Sushiswap=2, UniV3=3, Curve=4, BalancerV2=5
    enum Exchange { None, Quickswap, Sushiswap, UniV3, Curve, BalancerV2 }

    type SwapData = {
      path: string[]; fees: number[]; pool: string; poolIds: string[]; exchange: Exchange;
    };
    const noopSwap: SwapData = {
      path: [], fees: [], pool: ADDRESS_ZERO, poolIds: [], exchange: Exchange.None,
    };
    const uniV3 = (path: string[], fees: number[]): SwapData => ({
      path, fees, pool: ADDRESS_ZERO, poolIds: [], exchange: Exchange.UniV3,
    });

    interface DexExitCase {
      product: ProductCase;
      outputName: string;
      outputToken: string;             // address(0) for ETH
      isETH: boolean;
      // Per-SetToken-component swap from underlying-after-aToken-unwrap → outputToken.
      // For LINK2x [aArbLINK, USDT] with output WETH: [LINK→WETH, USDT→WETH].
      // For LINK2x with output LINK: [noopSwap, USDT→LINK].
      componentSwapData: (p: ProductCase) => SwapData[];
    }

    // Canonical UniV3 fee tiers on Arbitrum that have liquidity for our pairs.
    // Verified at planning by inspecting Arbiscan UniV3 pools. 0.3% (3000) for
    // AAVE/WETH and LINK/WETH; 0.05% (500) for WETH/USDC and USDT/USDC routes.
    const FEE = 3000;
    const FEE_LOW = 500;

    const DEX_CASES: DexExitCase[] = [
      // AAVE2x → WETH (single-component product). 1 swap: AAVE → WETH.
      {
        product: PRODUCTS[0],
        outputName: "WETH",
        outputToken: addresses.tokens.weth,
        isETH: false,
        componentSwapData: () => [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])],
      },
      // AAVE2x → ETH. Same swap path; contract handles WETH.withdraw at end.
      {
        product: PRODUCTS[0],
        outputName: "ETH",
        outputToken: ADDRESS_ZERO,
        isETH: true,
        componentSwapData: () => [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])],
      },
      // AAVE2x → USDC. Two-hop AAVE → WETH → USDC.
      {
        product: PRODUCTS[0],
        outputName: "USDC",
        outputToken: addresses.tokens.USDC,
        isETH: false,
        componentSwapData: () => [
          uniV3(
            [addresses.tokens.aave, addresses.tokens.weth, addresses.tokens.USDC],
            [FEE, FEE_LOW],
          ),
        ],
      },
      // AAVE2x → AAVE (passthrough). Empty SwapData; contract short-circuits and
      // forwards the unwrapped underlying directly.
      {
        product: PRODUCTS[0],
        outputName: "AAVE",
        outputToken: addresses.tokens.aave,
        isETH: false,
        componentSwapData: () => [noopSwap],
      },
      // LINK2x → WETH. Two swaps: LINK → WETH, USDT → WETH.
      {
        product: PRODUCTS[1],
        outputName: "WETH",
        outputToken: addresses.tokens.weth,
        isETH: false,
        componentSwapData: () => [
          uniV3([addresses.tokens.link, addresses.tokens.weth], [FEE]),
          uniV3([addresses.tokens.usdt, addresses.tokens.weth], [FEE]),
        ],
      },
      // LINK2x → ETH.
      {
        product: PRODUCTS[1],
        outputName: "ETH",
        outputToken: ADDRESS_ZERO,
        isETH: true,
        componentSwapData: () => [
          uniV3([addresses.tokens.link, addresses.tokens.weth], [FEE]),
          uniV3([addresses.tokens.usdt, addresses.tokens.weth], [FEE]),
        ],
      },
      // LINK2x → LINK (passthrough on the headline; dust USDT swapped in).
      {
        product: PRODUCTS[1],
        outputName: "LINK",
        outputToken: addresses.tokens.link,
        isETH: false,
        componentSwapData: () => [
          noopSwap,
          uniV3(
            [addresses.tokens.usdt, addresses.tokens.weth, addresses.tokens.link],
            [FEE, FEE],
          ),
        ],
      },
    ];

    for (const c of DEX_CASES) {
      describe(`${c.product.name} → ${c.outputName} via redeemFor${c.isETH ? "ETH" : "Token"}`, () => {
        it("issues, then redeems via DEX-routed exit, recipient receives output", async () => {
          const setTokenERC20 = IERC20__factory.connect(c.product.setToken, ethers.provider);
          const aToken = IERC20__factory.connect(c.product.collateralAToken, ethers.provider);
          const usdt = IERC20__factory.connect(addresses.tokens.usdt, ethers.provider);
          const issuanceModule = IDebtIssuanceModule__factory.connect(
            addresses.setFork.debtIssuanceModuleV3, ethers.provider,
          );

          // Bootstrap: pull components from the Aave V3 Arbitrum Collector and
          // issue setAmount of the SetToken to owner.
          const required = await issuanceModule.callStatic.getRequiredComponentIssuanceUnits(
            c.product.setToken, c.product.setAmount,
          );
          await setBalance(addresses.whales.aaveV3ArbCollector, ether(100));
          const collector = await impersonateAccount(addresses.whales.aaveV3ArbCollector);
          await aToken.connect(collector).transfer(owner.address, required[1][0].mul(110).div(100));
          if (c.product.hasUsdtDust) {
            await usdt.connect(collector).transfer(owner.address, required[1][1].mul(110).div(100));
          }
          await aToken.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
          if (c.product.hasUsdtDust) {
            await usdt.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
          }
          await issuanceModule.connect(owner.wallet).issue(c.product.setToken, c.product.setAmount, owner.address);
          const actualMinted = await setTokenERC20.balanceOf(owner.address);

          await setTokenERC20.connect(owner.wallet).approve(redeemer.address, MAX_UINT_256);
          const swapData = c.componentSwapData(c.product);

          // Capture before
          const dexRecipient = FRESH_RECIPIENT;
          const recipientBefore = c.isETH
            ? await ethers.provider.getBalance(dexRecipient)
            : await IERC20__factory.connect(c.outputToken, ethers.provider).balanceOf(dexRecipient);
          const setSupplyBefore = await setTokenERC20.totalSupply();

          // Optional sanity: read the contract-side quote ahead of time.
          const quoteAmount = c.isETH
            ? await redeemer.callStatic.getRedeemQuote(c.product.setToken, actualMinted, addresses.tokens.weth, swapData)
            : await redeemer.callStatic.getRedeemQuote(c.product.setToken, actualMinted, c.outputToken, swapData);
          // Slack the floor so swap-time price drift between view + tx still passes.
          const minOut = quoteAmount.mul(95).div(100);

          // Execute
          if (c.isETH) {
            await redeemer.connect(owner.wallet).redeemForETH(
              c.product.setToken, actualMinted, minOut, dexRecipient, swapData,
            );
          } else {
            await redeemer.connect(owner.wallet).redeemForToken(
              c.product.setToken, actualMinted, c.outputToken, minOut, dexRecipient, swapData,
            );
          }

          // Supply burned (modulo 0.2% redeem fee).
          const supplyBurned = setSupplyBefore.sub(await setTokenERC20.totalSupply());
          expect(supplyBurned).to.be.gte(actualMinted.mul(99).div(100));
          expect(supplyBurned).to.be.lte(actualMinted);

          // Recipient received output.
          const recipientAfter = c.isETH
            ? await ethers.provider.getBalance(dexRecipient)
            : await IERC20__factory.connect(c.outputToken, ethers.provider).balanceOf(dexRecipient);
          const delta = recipientAfter.sub(recipientBefore);
          expect(delta).to.be.gte(minOut);

          // No leakage on the output side.
          if (!c.isETH) {
            const redeemerOut = await IERC20__factory.connect(c.outputToken, ethers.provider).balanceOf(redeemer.address);
            expect(redeemerOut).to.eq(ZERO);
          } else {
            // Contract should have no leftover ETH or WETH.
            const wethBal = await IERC20__factory.connect(addresses.tokens.weth, ethers.provider).balanceOf(redeemer.address);
            const ethBal = await ethers.provider.getBalance(redeemer.address);
            expect(wethBal).to.eq(ZERO);
            expect(ethBal).to.eq(ZERO);
          }
        });
      });
    }

    describe("safety", () => {
      it("reverts on zero amount", async () => {
        await expect(
          redeemer.redeem(addresses.tokens.aave2x, ZERO, recipient.address),
        ).to.be.revertedWith("AaveV3DeleveredRedeemer: ZERO AMOUNT");
      });

      it("redeemForToken reverts when minOutputAmount not met", async () => {
        // Issue a tiny amount of AAVE2x first
        const product = PRODUCTS[0];
        const setTokenERC20 = IERC20__factory.connect(product.setToken, ethers.provider);
        const aToken = IERC20__factory.connect(product.collateralAToken, ethers.provider);
        const issuanceModule = IDebtIssuanceModule__factory.connect(
          addresses.setFork.debtIssuanceModuleV3, ethers.provider,
        );
        const small = ether(0.001);
        const required = await issuanceModule.callStatic.getRequiredComponentIssuanceUnits(product.setToken, small);
        await setBalance(addresses.whales.aaveV3ArbCollector, ether(100));
        const collector = await impersonateAccount(addresses.whales.aaveV3ArbCollector);
        await aToken.connect(collector).transfer(owner.address, required[1][0].mul(110).div(100));
        await aToken.connect(owner.wallet).approve(issuanceModule.address, MAX_UINT_256);
        await issuanceModule.connect(owner.wallet).issue(product.setToken, small, owner.address);
        await setTokenERC20.connect(owner.wallet).approve(redeemer.address, MAX_UINT_256);

        const swapData: SwapData[] = [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])];
        const wildlyHighMin = ether(1000);
        await expect(
          redeemer.connect(owner.wallet).redeemForToken(
            product.setToken, small, addresses.tokens.weth, wildlyHighMin, recipient.address, swapData,
          ),
        ).to.be.revertedWith("AaveV3DeleveredRedeemer: INSUFFICIENT OUTPUT");
      });

      it("redeemForToken reverts on swap-data length mismatch", async () => {
        const product = PRODUCTS[1]; // LINK2x — 2 components
        await expect(
          redeemer.redeemForToken(
            product.setToken, ether(0.01), addresses.tokens.weth, 0, recipient.address,
            [uniV3([addresses.tokens.link, addresses.tokens.weth], [FEE])], // only 1 swap, 2 components
          ),
        ).to.be.revertedWith("AaveV3DeleveredRedeemer: BAD SWAPDATA LENGTH");
      });
    });
  });
}
