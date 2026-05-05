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

    before(async () => {
      [owner, recipient] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      redeemer = await deployer.extensions.deployAaveV3DeleveredRedeemer(
        addresses.lending.aaveV3.lendingPool,
        addresses.setFork.debtIssuanceModuleV3,
      );
    });

    it("constructor wires immutables", async () => {
      expect(await redeemer.pool()).to.eq(addresses.lending.aaveV3.lendingPool);
      expect(await redeemer.issuanceModule()).to.eq(addresses.setFork.debtIssuanceModuleV3);
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

    describe("safety", () => {
      it("reverts on zero amount", async () => {
        await expect(
          redeemer.redeem(addresses.tokens.aave2x, ZERO, recipient.address),
        ).to.be.revertedWith("AaveV3DeleveredRedeemer: ZERO AMOUNT");
      });
    });
  });
}
