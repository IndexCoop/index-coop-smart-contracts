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
  IWETH,
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
  describe("FlashMintDex - Integration Test", async () => {
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
          addresses.dexes.dexAdapterV2,
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

      it("should revert when eth is sent to the contract", async () => {
        await expect(
          owner.wallet.sendTransaction({ to: flashMintDex.address, value: ether(1) })
        ).to.be.revertedWith("FlashMint: DIRECT DEPOSITS NOT ALLOWED");
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
          await flashMintDex.issueExactSetFromETH(issueParams, 0, { value: maxEthIn });
          const ethBalanceAfter = await owner.wallet.getBalance();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(ethBalanceAfter).to.gte(ethBalanceBefore.sub(maxEthIn));
        });

        it("Can issue legacy set token from WETH", async () => {
          const wethEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.weth,
            limitAmt: wethEstimate.mul(1005).div(1000), // 0.5% slippage
            swapDataTokenToWeth: swapDataEmpty,
            swapDataWethToToken: swapDataEmpty,
          };

          const wethToken = IWETH__factory.connect(paymentInfo.token, owner.wallet);
          await wethToken.deposit({ value: paymentInfo.limitAmt });
          wethToken.approve(flashMintDex.address, paymentInfo.limitAmt);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo, 0);
          const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gte(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        it("Can issue set token from USDC", async () => {
          const usdcEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.USDC,
            limitAmt: usdcEstimate.mul(1005).div(1000), // 0.5% slippage
            swapDataTokenToWeth: swapDataUsdcToWeth,
            swapDataWethToToken: swapDataWethToUsdc,
          };

          const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, paymentInfo.limitAmt);
          usdcToken.approve(flashMintDex.address, paymentInfo.limitAmt);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo, 0);
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gte(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        describe("When legacy set token has been issued", () => {
          beforeEach(async () => {
            await flashMintDex.issueExactSetFromETH(
              issueParams,
              0,
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
            const wethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.weth,
              limitAmt: wethReceivedEstimate.mul(995).div(1000), // 0.5% slippage
              swapDataTokenToWeth: swapDataEmpty,
              swapDataWethToToken: swapDataEmpty,
            };
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
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: usdcReceivedEstimate.mul(995).div(1000), // 0.5% slippage
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
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

        context("When issuing from ETH or WETH", () => {
          let ethRequiredEstimate: BigNumber;
          let maxEthIn: BigNumber;
          let setTokenBalanceBefore: BigNumber;
          let ethBalanceBefore: BigNumber;
          let excessEth: BigNumber;
          let wethToken: IWETH;
          let wethInContractBefore: BigNumber;

          beforeEach(async () => {
            ethRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty);
            maxEthIn = ethRequiredEstimate.mul(1005).div(1000); // 0.5% slippage
            excessEth = maxEthIn.sub(ethRequiredEstimate);
            setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            ethBalanceBefore = await owner.wallet.getBalance();
            wethToken = IWETH__factory.connect(addresses.tokens.weth, owner.wallet);
            wethInContractBefore = await wethToken.balanceOf(flashMintDex.address);
          });

          it("Can return unused ETH to the user if above a specified amount", async () => {
            const minEthRefund = ether(0.001);
            const tx = await flashMintDex.issueExactSetFromETH(issueParams, minEthRefund, { value: maxEthIn });
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed.mul(tx.gasPrice);
            const ethBalanceAfter = await owner.wallet.getBalance();
            const wethInContractAfter = await wethToken.balanceOf(flashMintDex.address);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
            expect(ethBalanceAfter).to.eq(ethBalanceBefore.sub(maxEthIn).sub(gasCost).add(excessEth));
            expect(wethInContractAfter).to.eq(wethInContractBefore);
          });

          it("Can leave unused ETH in the contract as WETH if below a specified amount", async () => {
            const minEthRefund = ether(1);
            const tx = await flashMintDex.issueExactSetFromETH(issueParams, minEthRefund, { value: maxEthIn });
            const receipt = await tx.wait();
            const gasCost = receipt.gasUsed.mul(tx.gasPrice);
            const ethBalanceAfter = await owner.wallet.getBalance();
            const wethInContractAfter = await wethToken.balanceOf(flashMintDex.address);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
            expect(ethBalanceAfter).to.eq(ethBalanceBefore.sub(maxEthIn).sub(gasCost));
            expect(wethInContractAfter).to.eq(wethInContractBefore.add(excessEth));
          });

          it("Can return unused WETH to the user if above a specified amount", async () => {
            const minWethRefund = ether(0.01);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.weth,
              limitAmt: ethRequiredEstimate.mul(1005).div(1000), // 0.5% slippage,
              swapDataTokenToWeth: swapDataEmpty,
              swapDataWethToToken: swapDataEmpty,
            };
            await wethToken.deposit({ value: paymentInfo.limitAmt });
            wethToken.approve(flashMintDex.address, paymentInfo.limitAmt);
            const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);

            await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo, minWethRefund);
            const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
            const wethInContractAfter = await wethToken.balanceOf(flashMintDex.address);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
            expect(inputTokenBalanceAfter).to.eq(inputTokenBalanceBefore.sub(paymentInfo.limitAmt).add(excessEth));
            expect(wethInContractAfter).to.eq(wethInContractBefore);
          });

          it("Can leave unused WETH in contract if below a specified amount", async () => {
            const minWethRefund = ether(1);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.weth,
              limitAmt: ethRequiredEstimate.mul(1005).div(1000), // 0.5% slippage,
              swapDataTokenToWeth: swapDataEmpty,
              swapDataWethToToken: swapDataEmpty,
            };
            await wethToken.deposit({ value: paymentInfo.limitAmt });
            wethToken.approve(flashMintDex.address, paymentInfo.limitAmt);
            const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);

            await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo, minWethRefund);
            const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
            const wethInContractAfter = await wethToken.balanceOf(flashMintDex.address);
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
            expect(inputTokenBalanceAfter).to.eq(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
            expect(wethInContractAfter).to.eq(wethInContractBefore.add(excessEth));
          });
        });

        it("Can issue set token from USDC and return leftover funds to user as USDC", async () => {
          const usdcRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          const minRefundValueInWeth = ether(0);
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.USDC,
            limitAmt: usdcRequiredEstimate.mul(1005).div(1000), // 0.5% slippage
            swapDataTokenToWeth: swapDataUsdcToWeth,
            swapDataWethToToken: swapDataWethToUsdc,
          };

          const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, paymentInfo.limitAmt);
          usdcToken.approve(flashMintDex.address, paymentInfo.limitAmt);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);

          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo, minRefundValueInWeth);
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
        });

        it("Can issue set token from USDC and leave unused funds in the contract as WETH", async () => {
          const usdcRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
          const minRefundValueInWeth = ether(1);
          const paymentInfo: PaymentInfo = {
            token: addresses.tokens.USDC,
            limitAmt: usdcRequiredEstimate.mul(1005).div(1000), // 0.5% slippage
            swapDataTokenToWeth: swapDataUsdcToWeth,
            swapDataWethToToken: swapDataWethToUsdc,
          };
          const usdcToken = IERC20__factory.connect(paymentInfo.token, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, paymentInfo.limitAmt);
          usdcToken.approve(flashMintDex.address, paymentInfo.limitAmt);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          const wethToken = IWETH__factory.connect(addresses.tokens.weth, owner.wallet);
          const wethInContractBefore = await wethToken.balanceOf(flashMintDex.address);

          await flashMintDex.issueExactSetFromERC20(issueParams, paymentInfo, minRefundValueInWeth);
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          const wethInContractAfter = await wethToken.balanceOf(flashMintDex.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.eq(inputTokenBalanceBefore.sub(paymentInfo.limitAmt));
          expect(wethInContractAfter).to.gt(wethInContractBefore);
        });

        describe("When set token has been issued", () => {
          beforeEach(async () => {
            await flashMintDex.issueExactSetFromETH(
              issueParams,
              0,
              {
                value: await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty),
              },
            );
            await setToken.approve(flashMintDex.address, setTokenAmount);
          });

          it("Can return ETH quantity received when redeeming set token", async () => {
            const ethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            expect(ethReceivedEstimate).to.eq(BigNumber.from("8424778030321284651"));
          });

          it("Can return USDC quantity received when redeeming set token", async () => {
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            expect(usdcReceivedEstimate).to.eq(BigNumber.from("26650292996"));
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
            const wethReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.weth,
              limitAmt:  wethReceivedEstimate.mul(995).div(1000), // 0.5% slippage
              swapDataTokenToWeth: swapDataEmpty,
              swapDataWethToToken: swapDataEmpty,
            };

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
            const usdcReceivedEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: usdcReceivedEstimate.mul(995).div(1000), // 0.5% slippage
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };

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

        context("When invalid inputs are given", () => {
          let invalidIssueParams: IssueRedeemParams;
          beforeEach(async () => {
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
                invalidIssueParams,
                0,
                {
                  value: await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty),
                },
              ),
            ).to.be.revertedWith("FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");
          });

          it("should revert when not enough ETH is sent for issuance", async () => {
            const ethRequiredEstimate = await flashMintDex.callStatic.getIssueExactSet(invalidIssueParams, swapDataEmpty);
            const notEnoughEth = ethRequiredEstimate.div(2);

            await expect(
              flashMintDex.issueExactSetFromETH(invalidIssueParams, 0, { value: notEnoughEth }),
            ).to.be.revertedWith("STF");
          });

          it("should revert when not enough ERC20 is sent for issuance", async () => {
            const usdcEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
            const usdc = IERC20__factory.connect(addresses.tokens.USDC, owner.wallet);
            const whaleSigner = await impersonateAccount(addresses.whales.USDC);
            await usdc.connect(whaleSigner).transfer(owner.address, usdcEstimate);
            usdc.approve(flashMintDex.address, usdcEstimate);

            const paymentInfoNotEnoughUsdc: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: usdcEstimate.div(2),
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
            await expect(
              flashMintDex.issueExactSetFromERC20(issueParams, paymentInfoNotEnoughUsdc, 0),
            ).to.be.revertedWith("STF");

            const wethToken = IWETH__factory.connect(addresses.tokens.weth, owner.wallet);
            await wethToken.deposit({ value: ether(100) });
            await wethToken.transfer(flashMintDex.address, ether(100));
            await expect(
              flashMintDex.issueExactSetFromERC20(issueParams, paymentInfoNotEnoughUsdc, 0),
            ).to.be.revertedWith("FlashMint: OVERSPENT WETH");
          });

          it("should revert when minimum ETH is not received during redemption", async () => {
            const setToken = SetToken__factory.connect(redeemParams.setToken, owner.wallet);
            setToken.approve(flashMintDex.address, redeemParams.amountSetToken);
            await flashMintDex.issueExactSetFromETH(issueParams, 0, {
              value: await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataEmpty),
            });
            const ethEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            const minAmountOutTooHigh = ethEstimate.mul(2);
            await expect(
              flashMintDex.redeemExactSetForETH(redeemParams, minAmountOutTooHigh),
            ).to.be.revertedWith("FlashMint: INSUFFICIENT WETH RECEIVED");
          });

          it("should revert when minimum ERC20 is not received during redemption", async () => {
            const setToken = SetToken__factory.connect(redeemParams.setToken, owner.wallet);
            setToken.approve(flashMintDex.address, redeemParams.amountSetToken);
            const usdcEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            const paymentInfoNotEnoughUsdc: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: usdcEstimate.mul(2),
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
            await expect(
              flashMintDex.redeemExactSetForERC20(redeemParams, paymentInfoNotEnoughUsdc),
            ).to.be.revertedWith("FlashMint: INSUFFICIENT OUTPUT AMOUNT");
          });

          it("issueExactSetFromETH should revert when incompatible set token is provided", async () => {
            invalidIssueParams.setToken = addresses.tokens.dpi;
            await expect(
              flashMintDex.issueExactSetFromETH(invalidIssueParams, 0, { value: ether(1) }),
            ).to.be.revertedWith("FlashMint: INVALID ISSUANCE MODULE OR SET TOKEN");
          });

          it("issueExactSetFromERC20 should revert when incompatible issuance module is provided", async () => {
            const usdcEstimate = await flashMintDex.callStatic.getIssueExactSet(issueParams, swapDataUsdcToWeth);
            const usdc = IERC20__factory.connect(addresses.tokens.USDC, owner.wallet);
            const whaleSigner = await impersonateAccount(addresses.whales.USDC);
            await usdc.connect(whaleSigner).transfer(owner.address, usdcEstimate);
            usdc.approve(flashMintDex.address, usdcEstimate);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: usdcEstimate,
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
            invalidIssueParams.issuanceModule = addresses.set.basicIssuanceModule;
            await expect(
              flashMintDex.issueExactSetFromERC20(invalidIssueParams, paymentInfo, 0)
            ).to.be.revertedWith("FlashMint: INVALID ISSUANCE MODULE OR SET TOKEN");
          });

          it("redeemExactSetForETH should revert when incompatible set token is provided", async () => {
            const invalidRedeemParams = { ...redeemParams };
            const minEthOut = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataEmpty);
            invalidRedeemParams.setToken = addresses.tokens.dpi;
            await expect(
              flashMintDex.redeemExactSetForETH(invalidRedeemParams, minEthOut),
            ).to.be.revertedWith("FlashMint: INVALID ISSUANCE MODULE OR SET TOKEN");
          });

          it("redeemExactSetForERC20 should revert when incompatible issuance module is provided", async () => {
            const invalidRedeemParams = { ...redeemParams };
            const usdcEstimate = await flashMintDex.callStatic.getRedeemExactSet(redeemParams, swapDataWethToUsdc);
            const paymentInfo: PaymentInfo = {
              token: addresses.tokens.USDC,
              limitAmt: usdcEstimate,
              swapDataTokenToWeth: swapDataUsdcToWeth,
              swapDataWethToToken: swapDataWethToUsdc,
            };
            invalidRedeemParams.issuanceModule = addresses.set.basicIssuanceModule;
            await expect(
              flashMintDex.redeemExactSetForERC20(invalidRedeemParams, paymentInfo),
            ).to.be.revertedWith("FlashMint: INVALID ISSUANCE MODULE OR SET TOKEN");
          });
        });
      });
    });
  });
}
