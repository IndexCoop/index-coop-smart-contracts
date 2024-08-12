import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ProtocolUtils } from "@utils/common";
import { ethers } from "hardhat";
import { utils, BigNumber } from "ethers";
import {
  IDebtIssuanceModule,
  IDebtIssuanceModule__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  FlashMintDex,
  IERC20__factory,
  IWETH__factory,
  IBasicIssuanceModule,
  IBasicIssuanceModule__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/index";
import { impersonateAccount } from "./utils";

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

type IssueRedeemParams = {
  setToken: Address;
  amountSetToken: BigNumber;
  componentSwapData: SwapData[];
  issuanceModule: Address;
  isDebtIssuance: boolean;
};

type PaymentInfo = {
  token: Address;
  limitAmt: BigNumber;
  swapDataTokenToWeth: SwapData;
  swapDataWethToToken: SwapData;
};

const addresses = PRODUCTION_ADDRESSES;

const swapDataEmpty = {
  exchange: Exchange.None,
  fees: [],
  path: [],
  pool: ADDRESS_ZERO,
};

const swapDataUsdcToWeth = {
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
  describe.only("FlashMintDex - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;

    let legacySetTokenCreator: SetTokenCreator;
    let setTokenCreator: SetTokenCreator;
    let legacyBasicIssuanceModule: IBasicIssuanceModule;
    let debtIssuanceModule: IDebtIssuanceModule;

    setBlockNumber(20385208, true);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      legacySetTokenCreator = SetTokenCreator__factory.connect(
        addresses.set.setTokenCreator,
        owner.wallet,
      );

      setTokenCreator = SetTokenCreator__factory.connect(
        addresses.setFork.setTokenCreator,
        owner.wallet,
      );

      legacyBasicIssuanceModule = IBasicIssuanceModule__factory.connect(
        addresses.set.basicIssuanceModule,
        owner.wallet,
      );

      debtIssuanceModule = IDebtIssuanceModule__factory.connect(
        addresses.setFork.debtIssuanceModuleV2,
        owner.wallet,
      );
    });

    context("When FlashMintDex contract is deployed", () => {
      let flashMintDex: FlashMintDex;

      before(async () => {
        flashMintDex = await deployer.extensions.deployFlashMintDex(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.dexes.curve.calculator,
          addresses.dexes.curve.addressProvider,
          addresses.set.controller,
          addresses.setFork.controller,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintDex.dexAdapter();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintDex.dexAdapter();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintDex.dexAdapter();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintDex.dexAdapter();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("Set controller address is set correctly", async () => {
        expect(await flashMintDex.setController()).to.eq(
          utils.getAddress(addresses.set.controller),
        );
      });

      it("Index controller address is set correctly", async () => {
        expect(await flashMintDex.indexController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      context("when SetToken is deployed on legacy Set Protocol", () => {
        let setToken: SetToken;
        let issueParams: IssueRedeemParams;
        let redeemParams: IssueRedeemParams;
        const setTokenAmount = ether(100);

        const components = [
          addresses.tokens.wbtc,
          addresses.tokens.weth,
          addresses.tokens.dpi,
        ];
        const positions = [
          BigNumber.from("84581"),
          BigNumber.from("11556875581911945"),
          BigNumber.from("218100363826474304"),
        ];

        const modules = [addresses.set.basicIssuanceModule];
        const tokenName = "BED Index";
        const tokenSymbol = "BED";

        const componentSwapDataIssue = [
          {
            exchange: Exchange.UniV3,
            fees: [3000],
            path: [addresses.tokens.weth, addresses.tokens.wbtc],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.UniV3,
            fees: [500],
            path: [addresses.tokens.weth, addresses.tokens.weth],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.UniV3,
            fees: [3000],
            path: [addresses.tokens.weth, addresses.tokens.dpi],
            pool: ADDRESS_ZERO,
          },
        ];

        const componentSwapDataRedeem = componentSwapDataIssue.map(item => ({
          ...item,
          path: [...item.path].reverse(),
        }));

        before(async () => {
          const tx = await legacySetTokenCreator.create(
            components,
            positions,
            modules,
            owner.address,
            tokenName,
            tokenSymbol,
          );
          const retrievedSetAddress = await new ProtocolUtils(
            ethers.provider,
          ).getCreatedSetTokenAddress(tx.hash);
          setToken = SetToken__factory.connect(retrievedSetAddress, owner.wallet);

          await legacyBasicIssuanceModule.initialize(
            setToken.address,
            ADDRESS_ZERO,
          );
          await flashMintDex.approveSetToken(setToken.address, legacyBasicIssuanceModule.address);

          issueParams = {
            setToken: setToken.address,
            amountSetToken: setTokenAmount,
            componentSwapData: componentSwapDataIssue,
            issuanceModule: legacyBasicIssuanceModule.address,
            isDebtIssuance: false,
          };

          redeemParams = {
            setToken: setToken.address,
            amountSetToken: setTokenAmount,
            componentSwapData: componentSwapDataRedeem,
            issuanceModule: legacyBasicIssuanceModule.address,
            isDebtIssuance: false,
          };
        });

        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

        it("Can return ETH quantity required to issue legacy set token", async () => {
          const ethRequired = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          expect(ethRequired).to.eq(BigNumber.from("3498514628413285230"));
        });

        it("Can return USDC quantity required to issue legacy set token", async () => {
          const usdcRequired = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          expect(usdcRequired).to.eq(BigNumber.from("11075363007"));
        });

        it("Can issue legacy set token from ETH", async () => {
          const ethEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          const maxEthIn = ethEstimate.mul(1005).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const ethBalanceBefore = await owner.wallet.getBalance();
          await flashMintDex.issueExactSetFromETH(issueParams, { value: maxEthIn });
          const ethBalanceAfter = await owner.wallet.getBalance();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(ethBalanceAfter).to.gte(ethBalanceBefore.sub(maxEthIn));
        });

        it("Can issue legacy set token from WETH", async () => {
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.weth,
            limitAmt: ether(0),
            swapDataTokenToWeth: swapDataEmpty,
            swapDataWethToToken: swapDataEmpty,
          };
          const wethEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          paymentInfo.limitAmt = wethEstimate.mul(1005).div(1000); // 0.5% slippage

          const wethToken = IWETH__factory.connect(paymentInfo.token, owner.wallet);
          await wethToken.deposit({ value: paymentInfo.limitAmt });
          wethToken.approve(flashMintDex.address, paymentInfo.limitAmt);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo);
          const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gte(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        it("Can issue set token from USDC", async () => {
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.USDC,
            limitAmt: ether(0),
            swapDataTokenToWeth: swapDataUsdcToWeth,
            swapDataWethToToken: swapDataWethToUsdc,
          };
          const usdcEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          paymentInfo.limitAmt = usdcEstimate.mul(1005).div(1000); // 0.5% slippage

          const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, paymentInfo.limitAmt);
          usdcToken.approve(flashMintDex.address, paymentInfo.limitAmt);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo);
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gte(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        describe("When legacy set token has been issued", () => {
          beforeEach(async () => {
            await flashMintDex.issueExactSetFromETH(
              issueParams,
              {
                value: await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty),
              },
            );
            await setToken.approve(flashMintDex.address, setTokenAmount);
          });

          it("Can return ETH quantity received when redeeming legacy set token", async () => {
            const ethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            expect(ethReceivedEstimate).to.eq(BigNumber.from("3492695444625661021"));
          });

          it("Can return USDC quantity received when redeeming legacy set token", async () => {
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            expect(usdcReceivedEstimate).to.eq(BigNumber.from("11054123420"));
          });

          it("Can redeem legacy set token for ETH", async () => {
            const ethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            const minAmountOut = ethReceivedEstimate.mul(995).div(1000); // 0.5% slippage
            const outputTokenBalanceBefore = await owner.wallet.getBalance();
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await flashMintDex.redeemExactSetForETH(redeemParams, minAmountOut);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await owner.wallet.getBalance();
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gte(outputTokenBalanceBefore.add(minAmountOut));
          });

          it("Can redeem legacy set token for WETH", async () => {
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.weth,
              limitAmt: ether(0),
              swapDataTokenToWeth: swapDataEmpty,
              swapDataWethToToken: swapDataEmpty,
            };
            const wethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            paymentInfo.limitAmt = wethReceivedEstimate.mul(995).div(1000); // 0.5% slippage
            const wethToken = IWETH__factory.connect(paymentInfo.token, owner.wallet);
            const outputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await flashMintDex.redeemExactSetForERC20(redeemParams, paymentInfo);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(paymentInfo.limitAmt));
          });

          it("Can redeem set token for USDC", async () => {
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: ether(0),
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            paymentInfo.limitAmt = usdcReceivedEstimate.mul(995).div(1000); // 0.5% slippage
            const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
            const outputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await flashMintDex.redeemExactSetForERC20(redeemParams, paymentInfo);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(paymentInfo.limitAmt));
          });
        });
      });

      context("when setToken is deployed on Index Protocol", () => {
        let setToken: SetToken;
        let issueParams: IssueRedeemParams;
        let redeemParams: IssueRedeemParams;
        const setTokenAmount = ether(10);

        const components = [
          addresses.tokens.wstEth,
          addresses.tokens.rETH,
          addresses.tokens.swETH,
          addresses.tokens.comp,
        ];
        const positions = [
          ethers.utils.parseEther("0.25"),
          ethers.utils.parseEther("0.25"),
          ethers.utils.parseEther("0.25"),
          ethers.utils.parseEther("0.25"),
        ];

        const componentSwapDataIssue = [
          {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.weth, addresses.tokens.wstEth],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.weth, addresses.tokens.rETH],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.UniV3,
            fees: [500],
            path: [addresses.tokens.weth, addresses.tokens.swETH],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.Sushiswap,
            fees: [],
            path: [addresses.tokens.weth, addresses.tokens.comp],
            pool: ADDRESS_ZERO,
          },
        ];

        const componentSwapDataRedeem = [
          {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.wstEth, addresses.tokens.weth],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.UniV3,
            fees: [100],
            path: [addresses.tokens.rETH, addresses.tokens.weth],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.UniV3,
            fees: [500],
            path: [addresses.tokens.swETH, addresses.tokens.weth],
            pool: ADDRESS_ZERO,
          },
          {
            exchange: Exchange.Sushiswap,
            fees: [],
            path: [addresses.tokens.comp, addresses.tokens.weth],
            pool: ADDRESS_ZERO,
          },
        ];

        const modules = [addresses.setFork.debtIssuanceModuleV2];
        const tokenName = "Simple Index";
        const tokenSymbol = "icSimple";

        before(async () => {
          const tx = await setTokenCreator.create(
            components,
            positions,
            modules,
            owner.address,
            tokenName,
            tokenSymbol,
          );
          const retrievedSetAddress = await new ProtocolUtils(
            ethers.provider,
          ).getCreatedSetTokenAddress(tx.hash);
          setToken = SetToken__factory.connect(retrievedSetAddress, owner.wallet);

          await debtIssuanceModule.initialize(
            setToken.address,
            ether(0.5),
            ether(0),
            ether(0),
            owner.address,
            ADDRESS_ZERO,
          );
          await flashMintDex.approveSetToken(setToken.address, debtIssuanceModule.address);

          issueParams = {
            setToken: setToken.address,
            amountSetToken: setTokenAmount,
            componentSwapData: componentSwapDataIssue,
            issuanceModule: debtIssuanceModule.address,
            isDebtIssuance: true,
          };

          redeemParams = {
            setToken: setToken.address,
            amountSetToken: setTokenAmount,
            componentSwapData: componentSwapDataRedeem,
            issuanceModule: debtIssuanceModule.address,
            isDebtIssuance: false,
          };
        });

        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

        it("Can return ETH quantity required to issue set token", async () => {
          const ethRequired = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          expect(ethRequired).to.eq(BigNumber.from("8427007884995480469"));
        });

        it("Can return USDC quantity required to issue set token", async () => {
          const usdcRequired = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          expect(usdcRequired).to.eq(BigNumber.from("26678902800"));
        });

        it("Can issue set token from ETH", async () => {
          const ethRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          const maxEthIn = ethRequiredEstimate.mul(1005).div(1000); // 0.5% slippage

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const ethBalanceBefore = await owner.wallet.getBalance();
          await flashMintDex.issueExactSetFromETH(issueParams, { value: maxEthIn });
          const ethBalanceAfter = await owner.wallet.getBalance();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(ethBalanceAfter).to.gt(ethBalanceBefore.sub(maxEthIn));
        });

        it("Can issue set token from WETH", async () => {
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.weth,
            limitAmt: ether(0),
            swapDataTokenToWeth: swapDataEmpty,
            swapDataWethToToken: swapDataEmpty,
          };
          const wethRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          paymentInfo.limitAmt = wethRequiredEstimate.mul(1005).div(1000); // 0.5% slippage
          const wethToken = IWETH__factory.connect(paymentInfo.token, owner.wallet);
          await wethToken.deposit({ value: paymentInfo.limitAmt });
          wethToken.approve(flashMintDex.address, paymentInfo.limitAmt);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo);
          const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        it("Can issue set token from USDC", async () => {
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.USDC,
            limitAmt: ether(0),
            swapDataTokenToWeth: swapDataUsdcToWeth,
            swapDataWethToToken: swapDataWethToUsdc,
          };
          const usdcRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          paymentInfo.limitAmt = usdcRequiredEstimate.mul(1005).div(1000); // 0.5% slippage

          const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, paymentInfo.limitAmt);
          usdcToken.approve(flashMintDex.address, paymentInfo.limitAmt);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo);
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gte(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        describe("When set token has been issued", () => {
          beforeEach(async () => {
            await flashMintDex.issueExactSetFromETH(
              issueParams,
              {
                value: await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty),
              },
            );
            await setToken.approve(flashMintDex.address, setTokenAmount);
          });

          it("Can return ETH quantity received when redeeming set token", async () => {
            const ethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            expect(ethReceivedEstimate).to.eq(BigNumber.from("8423933102234975071"));
          });

          it("Can return USDC quantity received when redeeming set token", async () => {
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            expect(usdcReceivedEstimate).to.eq(BigNumber.from("26643397669"));
          });

          it("Can redeem set token for ETH", async () => {
            const ethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            const minAmountOut = ethReceivedEstimate.mul(995).div(1000); // 0.5% slippage
            const outputTokenBalanceBefore = await owner.wallet.getBalance();
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await flashMintDex.redeemExactSetForETH(redeemParams, minAmountOut);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await owner.wallet.getBalance();
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });

          it("Can redeem set token for WETH", async () => {
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.weth,
              limitAmt: ether(0),
              swapDataTokenToWeth: swapDataEmpty,
              swapDataWethToToken: swapDataEmpty,
            };
            const wethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            paymentInfo.limitAmt = wethReceivedEstimate.mul(995).div(1000); // 0.5% slippage
            const wethToken = IWETH__factory.connect(paymentInfo.token, owner.wallet);
            const outputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await flashMintDex.redeemExactSetForERC20(redeemParams, paymentInfo);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(paymentInfo.limitAmt));
          });

          it("Can redeem set token for USDC", async () => {
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: ether(0),
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            paymentInfo.limitAmt = usdcReceivedEstimate.mul(995).div(1000); // 0.5% slippage
            const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
            const outputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await flashMintDex.redeemExactSetForERC20(redeemParams, paymentInfo);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(paymentInfo.limitAmt));
          });
        });

        context("When invalid unputs are given", () => {
          let invalidIssueParams: IssueRedeemParams;
          beforeEach(async () => {
            // reset invalidIssueParams each test
            invalidIssueParams = { ...issueParams };
          });

          it("Should revert when trying to issue set token with invalid swap data", async () => {
            const invalidSwapData = {
              exchange: Exchange.UniV3,
              fees: [100],
              path: [addresses.tokens.weth, addresses.tokens.comp],
              pool: ADDRESS_ZERO,
            };

            invalidIssueParams.componentSwapData = [invalidSwapData];

            await expect(
              flashMintDex.issueExactSetFromETH(
                issueParams,
                {
                  value: await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty),
                },
              ),
            ).to.be.revertedWith("FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");
          });

          it("should revert when not enough ETH is sent for issuance", async () => {
            const ethRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
            const notEnoughEth = ethRequiredEstimate.div(2);

            await expect(
              flashMintDex.issueExactSetFromETH(issueParams, { value: notEnoughEth }),
            ).to.be.revertedWith("STF");
          });
        });
      });
    });
  });
}
