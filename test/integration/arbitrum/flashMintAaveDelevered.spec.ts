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
  FlashMintAaveDelevered,
  IAToken__factory,
  IDebtIssuanceModule__factory,
  IERC20__factory,
  IPool__factory,
} from "../../../typechain";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintAaveDelevered - Arbitrum Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;
    let flashMint: FlashMintAaveDelevered;

    // Pin to a recent block where AAVE2x and LINK2x are in their fully-delevered
    // post-disengage state. After this block the components on-chain are
    // [aArbAAVE] (AAVE2x) and [aArbLINK, USDT-dust] (LINK2x).
    setBlockNumber(459_500_000, false);

    // Hardhat's default mnemonic signers (0xf39F…2266, 0x7099…79C8, etc.) all
    // happen to have contract code on Arbitrum mainnet at this fork block, so
    // sending ETH to them via Address.sendValue reverts. Use a deterministic
    // burn-style address that's a fresh EOA on the fork.
    const FRESH_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      flashMint = await deployer.extensions.deployFlashMintAaveDelevered(
        addresses.setFork.controller,
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
      expect((await flashMint.setController()).toLowerCase()).to.eq(addresses.setFork.controller.toLowerCase());
      expect((await flashMint.aaveV3Pool()).toLowerCase()).to.eq(addresses.lending.aaveV3.lendingPool.toLowerCase());
      expect((await flashMint.debtIssuanceModule()).toLowerCase()).to.eq(addresses.setFork.debtIssuanceModuleV3.toLowerCase());
      const a = await flashMint.addresses();
      expect(a.weth.toLowerCase()).to.eq(addresses.tokens.weth.toLowerCase());
      expect(a.uniV3Router.toLowerCase()).to.eq(addresses.dexes.uniV3.router.toLowerCase());
      expect(a.uniV3Quoter.toLowerCase()).to.eq(addresses.dexes.uniV3.quoter.toLowerCase());
    });

    // Sanity check on the load-bearing assumption that aArbAAVE / aArbLINK
    // expose UNDERLYING_ASSET_ADDRESS() and that the returned address is the
    // canonical Arbitrum AAVE / LINK token. If this ever changes, the contract's
    // try/catch fallback would silently treat an aToken as a non-aToken — bad UX.
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

        await setBalance(addresses.whales.aaveV3ArbCollector, ether(100));
        const collector = await impersonateAccount(addresses.whales.aaveV3ArbCollector);
        const sample = ether(0.5);
        const [, sink] = await getAccounts();
        await aAave.connect(collector).transfer(sink.address, sample);

        const aBefore = await aAave.balanceOf(sink.address);
        const underBefore = await aave.balanceOf(sink.address);
        expect(aBefore).to.be.gte(sample);

        await (
          await pool.connect(sink.wallet)
            .withdraw(addresses.tokens.aave, MAX_UINT_256, sink.address)
        ).wait();

        const aAfter = await aAave.balanceOf(sink.address);
        const underAfter = await aave.balanceOf(sink.address);
        expect(aAfter).to.eq(ZERO);
        expect(underAfter.sub(underBefore)).to.be.gte(aBefore.sub(BigNumber.from(1)));
      });
    });

    // Per-product cases. Tests cover the full matrix of output tokens the SDK
    // is expected to support: native ETH, WETH, the headline underlying
    // (passthrough via no-op SwapData), USDC (a stable that requires a real
    // multi-hop UniV3 path), plus one multi-component case (LINK2x's USDT
    // dust).
    interface ProductCase {
      name: string;
      setToken: string;
      collateralAToken: string;
      collateralUnderlying: string;
      hasUsdtDust: boolean;
      // Conservative setAmount, well below the SetToken's tiny on-chain supply.
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

    // Bootstrap helper — fund owner with the components needed to issue
    // `setAmount` of the SetToken via the V3 module from the Aave V3 Arbitrum
    // Collector, then issue. Returns the actual minted amount (after the V3
    // module's 0.2% issue fee).
    async function bootstrapMint(product: ProductCase, setAmount: BigNumber): Promise<BigNumber> {
      const setTokenERC20 = IERC20__factory.connect(product.setToken, ethers.provider);
      const aToken = IERC20__factory.connect(product.collateralAToken, ethers.provider);
      const usdt = IERC20__factory.connect(addresses.tokens.usdt, ethers.provider);
      const issuanceModule = IDebtIssuanceModule__factory.connect(
        addresses.setFork.debtIssuanceModuleV3, ethers.provider,
      );
      const required = await issuanceModule.callStatic.getRequiredComponentIssuanceUnits(product.setToken, setAmount);

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
      await issuanceModule.connect(owner.wallet).issue(product.setToken, setAmount, owner.address);
      return setTokenERC20.balanceOf(owner.address);
    }

    // ── Per-output-token redemption cases ───────────────────────────────────────────
    //
    // Per-component swap data is FROM the component's underlying TO the requested
    // output. Aave V3 aTokens are unwrapped via Pool.withdraw before the swap so
    // the DEX leg sees the underlying.
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

    interface RedeemCase {
      product: ProductCase;
      outputName: string;
      outputToken: string;             // address(0) for ETH
      isETH: boolean;
      componentSwapData: () => SwapData[];
    }

    // Canonical UniV3 fee tiers on Arbitrum that have liquidity for our pairs.
    const FEE = 3000;       // AAVE/WETH and LINK/WETH 0.3% pools
    const FEE_LOW = 500;    // WETH/USDC 0.05% pool

    const REDEEM_CASES: RedeemCase[] = [
      // AAVE2x → AAVE (passthrough). Empty SwapData; contract short-circuits.
      {
        product: PRODUCTS[0], outputName: "AAVE", outputToken: addresses.tokens.aave, isETH: false,
        componentSwapData: () => [noopSwap],
      },
      // AAVE2x → WETH (single-hop UniV3).
      {
        product: PRODUCTS[0], outputName: "WETH", outputToken: addresses.tokens.weth, isETH: false,
        componentSwapData: () => [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])],
      },
      // AAVE2x → ETH (WETH unwrap inside the contract).
      {
        product: PRODUCTS[0], outputName: "ETH", outputToken: ADDRESS_ZERO, isETH: true,
        componentSwapData: () => [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])],
      },
      // AAVE2x → USDC (multi-hop AAVE → WETH → USDC).
      {
        product: PRODUCTS[0], outputName: "USDC", outputToken: addresses.tokens.USDC, isETH: false,
        componentSwapData: () => [
          uniV3([addresses.tokens.aave, addresses.tokens.weth, addresses.tokens.USDC], [FEE, FEE_LOW]),
        ],
      },
      // LINK2x → LINK (collateral passthrough; USDT dust swapped in).
      {
        product: PRODUCTS[1], outputName: "LINK", outputToken: addresses.tokens.link, isETH: false,
        componentSwapData: () => [
          noopSwap,
          uniV3([addresses.tokens.usdt, addresses.tokens.weth, addresses.tokens.link], [FEE, FEE]),
        ],
      },
      // LINK2x → WETH (multi-component including USDT swap).
      {
        product: PRODUCTS[1], outputName: "WETH", outputToken: addresses.tokens.weth, isETH: false,
        componentSwapData: () => [
          uniV3([addresses.tokens.link, addresses.tokens.weth], [FEE]),
          uniV3([addresses.tokens.usdt, addresses.tokens.weth], [FEE]),
        ],
      },
      // LINK2x → ETH.
      {
        product: PRODUCTS[1], outputName: "ETH", outputToken: ADDRESS_ZERO, isETH: true,
        componentSwapData: () => [
          uniV3([addresses.tokens.link, addresses.tokens.weth], [FEE]),
          uniV3([addresses.tokens.usdt, addresses.tokens.weth], [FEE]),
        ],
      },
    ];

    for (const c of REDEEM_CASES) {
      describe(`${c.product.name} → ${c.outputName} via redeemExactSetFor${c.isETH ? "ETH" : "ERC20"}`, () => {
        it("issues, then redeems, msg.sender receives output", async () => {
          const setTokenERC20 = IERC20__factory.connect(c.product.setToken, ethers.provider);
          const actualMinted = await bootstrapMint(c.product, c.product.setAmount);

          await setTokenERC20.connect(owner.wallet).approve(flashMint.address, MAX_UINT_256);
          const swapData = c.componentSwapData();

          // FlashMintAaveDelevered always sends to msg.sender, mirroring the
          // existing FlashMintLeveraged contracts. For ETH outputs we route
          // through a fresh impersonated EOA so the ETH delivery doesn't hit
          // a hardhat-default-signer-collides-with-mainnet-contract case.
          let recipient: string;
          let sender: any = owner.wallet;
          if (c.isETH) {
            await setBalance(FRESH_RECIPIENT, ether(10));
            sender = await impersonateAccount(FRESH_RECIPIENT);
            recipient = FRESH_RECIPIENT;
            // Move SetTokens to the fresh sender.
            await setTokenERC20.connect(owner.wallet).transfer(recipient, actualMinted);
            await setTokenERC20.connect(sender).approve(flashMint.address, MAX_UINT_256);
          } else {
            recipient = owner.address;
          }

          const setSupplyBefore = await setTokenERC20.totalSupply();
          const recipientBefore = c.isETH
            ? await ethers.provider.getBalance(recipient)
            : await IERC20__factory.connect(c.outputToken, ethers.provider).balanceOf(recipient);

          // Quote the predicted output via the contract's getRedeemExactSet view-
          // style helper (uses ETH_ADDRESS sentinel for ETH).
          const ETH_ADDR = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
          const quoteAmount = await flashMint.callStatic.getRedeemExactSet(
            c.product.setToken,
            actualMinted,
            c.isETH ? ETH_ADDR : c.outputToken,
            swapData,
          );
          const minOut = quoteAmount.mul(95).div(100);

          // Execute
          let tx;
          if (c.isETH) {
            tx = await flashMint.connect(sender).redeemExactSetForETH(
              c.product.setToken, actualMinted, minOut, swapData,
            );
          } else {
            tx = await flashMint.connect(sender).redeemExactSetForERC20(
              c.product.setToken, actualMinted, c.outputToken, minOut, swapData,
            );
          }
          const receipt = await tx.wait();

          const supplyBurned = setSupplyBefore.sub(await setTokenERC20.totalSupply());
          expect(supplyBurned).to.be.gte(actualMinted.mul(99).div(100));
          expect(supplyBurned).to.be.lte(actualMinted);

          let recipientAfter: BigNumber;
          if (c.isETH) {
            const ethAfter = await ethers.provider.getBalance(recipient);
            const gasUsed = receipt.gasUsed.mul(receipt.effectiveGasPrice ?? tx.gasPrice ?? 0);
            recipientAfter = ethAfter.add(gasUsed);
          } else {
            recipientAfter = await IERC20__factory.connect(c.outputToken, ethers.provider).balanceOf(recipient);
          }
          const delta = recipientAfter.sub(recipientBefore);
          expect(delta).to.be.gte(minOut);

          // No leakage on the contract.
          if (!c.isETH) {
            expect(await IERC20__factory.connect(c.outputToken, ethers.provider).balanceOf(flashMint.address)).to.eq(ZERO);
          } else {
            expect(await IERC20__factory.connect(addresses.tokens.weth, ethers.provider).balanceOf(flashMint.address)).to.eq(ZERO);
            expect(await ethers.provider.getBalance(flashMint.address)).to.eq(ZERO);
          }
        });
      });
    }

    describe("safety", () => {
      it("redeemExactSetForERC20 reverts on zero amount", async () => {
        await expect(
          flashMint.redeemExactSetForERC20(
            addresses.tokens.aave2x, ZERO, addresses.tokens.aave, 0,
            [noopSwap],
          ),
        ).to.be.revertedWith("FlashMintAaveDelevered: ZERO AMOUNT");
      });

      it("redeemExactSetForETH reverts on zero amount", async () => {
        await expect(
          flashMint.redeemExactSetForETH(
            addresses.tokens.aave2x, ZERO, 0,
            [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])],
          ),
        ).to.be.revertedWith("FlashMintAaveDelevered: ZERO AMOUNT");
      });

      it("reverts when minAmountOutputToken not met", async () => {
        const product = PRODUCTS[0];
        const setTokenERC20 = IERC20__factory.connect(product.setToken, ethers.provider);
        const small = ether(0.001);
        await bootstrapMint(product, small);
        await setTokenERC20.connect(owner.wallet).approve(flashMint.address, MAX_UINT_256);
        const swapData: SwapData[] = [uniV3([addresses.tokens.aave, addresses.tokens.weth], [FEE])];
        await expect(
          flashMint.connect(owner.wallet).redeemExactSetForERC20(
            product.setToken, small, addresses.tokens.weth, ether(1000), swapData,
          ),
        ).to.be.revertedWith("FlashMintAaveDelevered: INSUFFICIENT OUTPUT");
      });

      it("reverts on swap-data length mismatch", async () => {
        const product = PRODUCTS[1]; // LINK2x — 2 components
        await expect(
          flashMint.redeemExactSetForERC20(
            product.setToken, ether(0.01), addresses.tokens.weth, 0,
            [uniV3([addresses.tokens.link, addresses.tokens.weth], [FEE])], // only 1 swap, 2 components
          ),
        ).to.be.revertedWith("FlashMintAaveDelevered: BAD SWAPDATA LENGTH");
      });

      it("reverts on non-Set token", async () => {
        await expect(
          flashMint.redeemExactSetForERC20(
            addresses.tokens.aave, ether(0.01), addresses.tokens.weth, 0,
            [noopSwap],
          ),
        ).to.be.revertedWith("FlashMintAaveDelevered: INVALID SET");
      });
    });
  });
}
