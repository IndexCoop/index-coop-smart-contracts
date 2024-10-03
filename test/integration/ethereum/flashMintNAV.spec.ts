import "module-alias/register";
import { Account, Address, CustomOracleNAVIssuanceSettings } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { addSnapshotBeforeRestoreAfterEach, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber } from "ethers";
import {
  SetToken,
  ERC4626Oracle,
  FlashMintNAV,
  IERC20,
  IERC20__factory,
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
  morpho_seeding: "0x6ABfd6139c7C3CC270ee2Ce132E309F59cAaF6a2", // gtUSDC,
  weth: "0x4F4495243837681061C4743b74B3eEdf548D56A5",
  dai: "0x3B5fb9d9da3546e9CE6E5AA3CCEca14C8D20041e",
  usdt: "0xEEA81C4416d71CeF071224611359F6F99A4c4294",
};

const swapDataEmpty: SwapData = {
  exchange: Exchange.None,
  fees: [],
  path: [],
  pool: ADDRESS_ZERO,
};

const swapDataUsdcToWeth: SwapData = {
  exchange: Exchange.UniV3,
  fees: [500],
  path: [addresses.tokens.USDC, addresses.tokens.weth],
  pool: ADDRESS_ZERO,
};

const swapDataWethToUsdc = {
  exchange: Exchange.UniV3,
  fees: [500],
  path: [addresses.tokens.weth, addresses.tokens.USDC],
  pool: ADDRESS_ZERO,
};

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

    setBlockNumber(20528609, true);

    before(async () => {
      [owner] = await getAccounts();

      // Sytem setup
      deployer = new DeployHelper(owner.wallet);
      setV2Setup = new SetFixture(ethers.provider, owner.address);
      await setV2Setup.initialize();

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
          setV2Setup.debtIssuanceModuleV3.address,
          setV2Setup.rebasingComponentModule.address,
          setV2Setup.navIssuanceModule.address,
        ]
      );

      // Initialize Modules
      await setV2Setup.debtIssuanceModuleV3.initialize(
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
      await usdc_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModuleV3.address, MAX_UINT_256);
      await aEthUSDC_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModuleV3.address, MAX_UINT_256);
      await cUSDCv3_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModuleV3.address, MAX_UINT_256);
      await aUSDC_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModuleV3.address, MAX_UINT_256);
      await gtUSDC_erc20.connect(owner.wallet).approve(setV2Setup.debtIssuanceModuleV3.address, MAX_UINT_256);
      await setV2Setup.debtIssuanceModuleV3.connect(owner.wallet).issue(setToken.address, ether(10), owner.address);

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

      await flashMintNAV.approveSetToken(setToken.address);
      await setToken.connect(owner.wallet).approve(flashMintNAV.address, MAX_UINT_256);
    });

    addSnapshotBeforeRestoreAfterEach();

    describe("#issue", () => {
      let subjectInputToken: Address;
      let subjectInputTokenAmount: BigNumber;
      let subjectMinSetTokenOut: BigNumber;
      let subjectSwapData: SwapData;

      async function subjectQuote() {
        return await flashMintNAV.callStatic.getIssueAmount(
          setToken.address,
          subjectInputToken,
          subjectInputTokenAmount,
          subjectSwapData
        );
      }

      context("issueSetFromExactETH", async () => {
        subjectInputToken = addresses.tokens.weth;
        subjectInputTokenAmount = ether(1);
        subjectSwapData = swapDataWethToUsdc;

        async function subject() {
          return await flashMintNAV.issueSetFromExactETH(
            setToken.address,
            subjectMinSetTokenOut,
            subjectSwapData,
            { value: subjectInputTokenAmount }
          );
        }

        it("can estimate the amount of SetToken issued for a given amount of ETH", async () => {
          const setTokenOutEstimate = await subjectQuote();
          expect(setTokenOutEstimate).to.eq(BigNumber.from("25460056235206711599"));
        });

        it("should issue SetToken with ETH", async () => {
          const setTokenOutEstimate = await subjectQuote();
          subjectMinSetTokenOut = setTokenOutEstimate.mul(995).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.gte(setTokenBalanceBefore.add(subjectMinSetTokenOut));
        });

        it("should revert if less than minSetTokenAmount received", async () => {
          subjectInputTokenAmount = ether(0.01);
          await expect(subject()).to.be.revertedWith("Must be greater than min SetToken");
        });
      });

      context("issueSetFromExactERC20", async () => {
        let subjectWhale: Address;

        async function getInputTokens() {
          const whaleSigner = await impersonateAccount(subjectWhale);
          const erc20 = IERC20__factory.connect(subjectInputToken, owner.wallet);
          await erc20.connect(whaleSigner).transfer(owner.address, subjectInputTokenAmount);
          await erc20.approve(flashMintNAV.address, subjectInputTokenAmount);
        }

        async function subject() {
          return await flashMintNAV.issueSetFromExactERC20(
            setToken.address,
            subjectMinSetTokenOut,
            subjectInputToken,
            subjectInputTokenAmount,
            subjectSwapData
          );
        }

        it("can estimate the amount of SetToken issued for a given amount of ERC20", async () => {
          subjectInputToken = addresses.tokens.weth;
          subjectInputTokenAmount = ether(1);
          subjectSwapData = swapDataWethToUsdc;

          const setTokenOutEstimate = await subjectQuote();
          expect(setTokenOutEstimate).to.eq(BigNumber.from("25460056235206711599"));
        });

        it("should issue SetToken with USDC (reserve asset)", async () => {
          subjectInputToken = addresses.tokens.USDC;
          subjectInputTokenAmount = usdc(100);
          subjectWhale = whales.usdc;
          subjectSwapData = swapDataEmpty;

          await getInputTokens();
          const setTokenOutEstimate = await subjectQuote();
          subjectMinSetTokenOut = setTokenOutEstimate.mul(995).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.gte(setTokenBalanceBefore.add(subjectMinSetTokenOut));
        });

        it("should issue SetToken with WETH", async () => {
          subjectInputToken = addresses.tokens.weth;
          subjectInputTokenAmount = ether(1);
          subjectWhale = whales.weth;
          subjectSwapData = swapDataWethToUsdc;

          await getInputTokens();
          const setTokenOutEstimate = await subjectQuote();
          subjectMinSetTokenOut = setTokenOutEstimate.mul(995).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.gte(setTokenBalanceBefore.add(subjectMinSetTokenOut));
        });

        it("should issue SetToken with DAI", async () => {
          subjectInputToken = addresses.tokens.dai;
          subjectInputTokenAmount = ether(1000);
          subjectWhale = whales.dai;
          subjectSwapData = {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.dai, addresses.tokens.USDC],
            pool: ADDRESS_ZERO,
          };

          await getInputTokens();
          const setTokenOutEstimate = await subjectQuote();
          subjectMinSetTokenOut = setTokenOutEstimate.mul(995).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.gte(setTokenBalanceBefore.add(subjectMinSetTokenOut));
        });

        it("should issue SetToken with USDT", async () => {
          subjectInputToken = addresses.tokens.usdt;
          subjectInputTokenAmount = usdc(1000); // USDT and USDC both have 6 decimals
          subjectWhale = whales.usdt;
          subjectSwapData = {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.usdt, addresses.tokens.USDC],
            pool: ADDRESS_ZERO,
          };

          await getInputTokens();
          const setTokenOutEstimate = await subjectQuote();
          subjectMinSetTokenOut = setTokenOutEstimate.mul(995).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.gte(setTokenBalanceBefore.add(subjectMinSetTokenOut));
        });

        it("should revert if less than minSetTokenAmount received", async () => {
          subjectInputToken = addresses.tokens.USDC;
          subjectInputTokenAmount = usdc(100);
          subjectSwapData = swapDataEmpty;
          subjectWhale = whales.usdc;

          await getInputTokens();
          const setTokenOutEstimate = await subjectQuote();
          subjectMinSetTokenOut = setTokenOutEstimate.mul(1005).div(1000); // 0.5% too high
          await expect(subject()).to.be.revertedWith("Must be greater than min SetToken");
        });
      });
    });

    describe("#redeem", () => {
      let subjectOutputToken: Address;
      let subjectMinOutputTokenAmount: BigNumber;
      let subjectSwapData: SwapData;

      const setTokenRedeemAmount = ether(23);
      const ethAmountIn = ether(1);

      beforeEach(async () => {
        await flashMintNAV.issueSetFromExactETH(
          setToken.address,
          setTokenRedeemAmount,
          swapDataWethToUsdc,
          { value: ethAmountIn }
        );
      });

      async function subjectQuote() {
        return await flashMintNAV.callStatic.getRedeemAmountOut(
          setToken.address,
          setTokenRedeemAmount,
          subjectOutputToken,
          subjectSwapData
        );
      }

      context("redeemExactSetForETH", async () => {
        subjectOutputToken = addresses.tokens.weth;
        subjectSwapData = swapDataUsdcToWeth;

        async function subject() {
          return await flashMintNAV.redeemExactSetForETH(
            setToken.address,
            setTokenRedeemAmount,
            subjectMinOutputTokenAmount,
            subjectSwapData
          );
        }

        it("can estimate the amount of output token received for redeeming a given amount of Set Token", async () => {
          const outputTokenAmount = await subjectQuote();
          expect(outputTokenAmount).to.eq(BigNumber.from("881862431628006214"));
        });

        it("should redeem SetToken for ETH", async () => {
          const outputAmountEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = outputAmountEstimate.mul(995).div(1000); // 0.5% slippage

          const ethBalanceBefore = await owner.wallet.getBalance();
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          const ethBalanceAfter = await owner.wallet.getBalance();
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenRedeemAmount));
          expect(ethBalanceAfter).to.gte(ethBalanceBefore.add(subjectMinOutputTokenAmount));
        });

        it("should revert if less than minEthAmount received", async () => {
          const ethOutEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = ethOutEstimate.mul(1005).div(1000); // 0.5% too high
          await expect(subject()).to.be.revertedWith("FlashMint: NOT ENOUGH ETH RECEIVED");
        });
      });

      context("redeemExactSetForERC20", async () => {
        async function subject() {
          return await flashMintNAV.redeemExactSetForERC20(
            setToken.address,
            setTokenRedeemAmount,
            subjectOutputToken,
            subjectMinOutputTokenAmount,
            subjectSwapData
          );
        }

        it("should redeem SetToken for USDC (reserve asset)", async () => {
          subjectOutputToken = addresses.tokens.USDC;
          subjectSwapData = swapDataEmpty;

          const outputAmountEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = outputAmountEstimate.mul(995).div(1000); // 0.5% slippage

          const usdcBalanceBefore = await usdc_erc20.balanceOf(owner.address);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          const usdcBalanceAfter = await usdc_erc20.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenRedeemAmount));
          expect(usdcBalanceAfter).to.gte(usdcBalanceBefore.add(subjectMinOutputTokenAmount));
        });

        it("should redeem SetToken for WETH", async () => {
          subjectOutputToken = addresses.tokens.weth;
          subjectSwapData = swapDataUsdcToWeth;

          const outputAmountEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = outputAmountEstimate.mul(995).div(1000); // 0.5% slippage
          const wethToken = IERC20__factory.connect(subjectOutputToken, owner.wallet);

          const wethBalanceBefore = await wethToken.balanceOf(owner.address);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          const wethBalanceAfter = await wethToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenRedeemAmount));
          expect(wethBalanceAfter).to.gte(wethBalanceBefore.add(subjectMinOutputTokenAmount));
        });

        it("should redeem SetToken for DAI", async () => {
          subjectOutputToken = addresses.tokens.dai;
          subjectSwapData = {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.USDC, addresses.tokens.dai],
            pool: ADDRESS_ZERO,
          };

          const outputAmountEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = outputAmountEstimate.mul(995).div(1000); // 0.5% slippage
          const daiToken = IERC20__factory.connect(subjectOutputToken, owner.wallet);

          const daiBalanceBefore = await daiToken.balanceOf(owner.address);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          const daiBalanceAfter = await daiToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenRedeemAmount));
          expect(daiBalanceAfter).to.gte(daiBalanceBefore.add(subjectMinOutputTokenAmount));
        });

        it("should redeem SetToken for USDT", async () => {
          subjectOutputToken = addresses.tokens.usdt;
          subjectSwapData = {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.USDC, addresses.tokens.usdt],
            pool: ADDRESS_ZERO,
          };

          const outputAmountEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = outputAmountEstimate.mul(995).div(1000); // 0.5% slippage
          const usdtToken = IERC20__factory.connect(subjectOutputToken, owner.wallet);

          const usdtBalanceBefore = await usdtToken.balanceOf(owner.address);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          await subject();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          const usdtBalanceAfter = await usdtToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenRedeemAmount));
          expect(usdtBalanceAfter).to.gte(usdtBalanceBefore.add(subjectMinOutputTokenAmount));
        });

        it("should revert if less than minOutputTokenAmount received", async () => {
          const outputAmountEstimate = await subjectQuote();
          subjectMinOutputTokenAmount = outputAmountEstimate.mul(1005).div(1000); // 0.5% too high
          await expect(subject()).to.be.revertedWith("FlashMint: NOT ENOUGH OUTPUT TOKEN RECEIVED");
        });
      });
    });
  });
}
