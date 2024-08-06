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
import { ADDRESS_ZERO, ETH_ADDRESS } from "@utils/constants";
import { ether, usdc } from "@utils/index";
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

const swapDataFromInputToken = {
  exchange: Exchange.UniV3,
  fees: [500],
  path: [addresses.tokens.USDC, addresses.tokens.weth],
  pool: ADDRESS_ZERO,
};

const swapDataToInputToken = {
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

      context("when BED SetToken is deployed on Set Protocol", () => {
        let setToken: SetToken;
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
        });

        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

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
        const setTokenAmount = ether(100);
        let maxAmountIn: BigNumber;
        let inputToken: Address;

        function subject() {
          const issueParams: IssueRedeemParams = {
            setToken: setToken.address,
            amountSetToken: setTokenAmount,
            componentSwapData: componentSwapDataIssue,
            issuanceModule: legacyBasicIssuanceModule.address,
            isDebtIssuance: false,
          };
          const paymentInfo: PaymentInfo = {
            token: inputToken,
            limitAmt: maxAmountIn,
            swapDataTokenToWeth: swapDataFromInputToken,
            swapDataWethToToken: swapDataToInputToken,
          };
          if (paymentInfo.token === ETH_ADDRESS) {
            return flashMintDex.issueExactSetFromETH(
              issueParams,
              {
                value: maxAmountIn,
              },
            );
          } else {
            return flashMintDex.issueExactSetFromToken(issueParams, paymentInfo);
          }
        }

        it("Can issue legacy set token from ETH", async () => {
          inputToken = ETH_ADDRESS;
          maxAmountIn = ether(5);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const ethBalanceBefore = await owner.wallet.getBalance();
          await subject();
          const ethBalanceAfter = await owner.wallet.getBalance();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(ethBalanceAfter).to.gt(ethBalanceBefore.sub(maxAmountIn));
        });

        it("Can issue legacy set token from WETH", async () => {
          inputToken = addresses.tokens.weth;
          maxAmountIn = ether(5);
          const wethToken = IWETH__factory.connect(inputToken, owner.wallet);
          await wethToken.deposit({ value: maxAmountIn });
          wethToken.approve(flashMintDex.address, maxAmountIn);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
          await subject();
          const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        });

        it("Can issue set token from USDC", async () => {
          inputToken = addresses.tokens.USDC;
          maxAmountIn = usdc(20000);
          const usdcToken = IERC20__factory.connect(inputToken, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, maxAmountIn);
          usdcToken.approve(flashMintDex.address, maxAmountIn);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          await subject();
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        });

        describe("When legacy set token has been issued", () => {
          let outputToken: Address;
          let minAmountOut: BigNumber;

          beforeEach(async () => {
            const maxAmountIn = ether(5);
            const issueParams: IssueRedeemParams = {
              setToken: setToken.address,
              amountSetToken: setTokenAmount,
              componentSwapData: componentSwapDataIssue,
              issuanceModule: legacyBasicIssuanceModule.address,
              isDebtIssuance: false,
            };
            await flashMintDex.issueExactSetFromETH(
              issueParams,
              {
                value: maxAmountIn,
              },
            );
            await setToken.approve(flashMintDex.address, setTokenAmount);
          });

          function subject() {
            const redeemParams: IssueRedeemParams = {
              setToken: setToken.address,
              amountSetToken: setTokenAmount,
              componentSwapData: componentSwapDataRedeem,
              issuanceModule: legacyBasicIssuanceModule.address,
              isDebtIssuance: false,
            };
            const paymentInfo: PaymentInfo = {
              token: outputToken,
              limitAmt: minAmountOut,
              swapDataTokenToWeth: swapDataFromInputToken,
              swapDataWethToToken: swapDataToInputToken,
            };
            if (paymentInfo.token === ETH_ADDRESS) {
              return flashMintDex.redeemExactSetForETH(redeemParams, minAmountOut);
            } else {

              return flashMintDex.redeemExactSetForToken(redeemParams, paymentInfo);
            }
          }

          it("Can redeem set token for ETH", async () => {
            outputToken = ETH_ADDRESS;
            minAmountOut = maxAmountIn.mul(10).div(9);
            const outputTokenBalanceBefore = await owner.wallet.getBalance();
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await subject();
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await owner.wallet.getBalance();
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });

          it("Can redeem set token for WETH", async () => {
            outputToken = addresses.tokens.weth;
            minAmountOut = maxAmountIn.mul(10).div(9);
            const wethToken = IWETH__factory.connect(outputToken, owner.wallet);
            const outputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await subject();
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });

          it("Can redeem set token for USDC", async () => {
            outputToken = addresses.tokens.USDC;
            minAmountOut = usdc(5000);
            const usdcToken = IERC20__factory.connect(outputToken, owner.wallet);
            const outputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await subject();
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });
        });
      });

      context("when setToken with a simple composition is deployed", () => {
        let setToken: SetToken;
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

        const swapDataFromInputToken = {
          exchange: Exchange.UniV3,
          fees: [500],
          path: [addresses.tokens.USDC, addresses.tokens.weth],
          pool: ADDRESS_ZERO,
        };

        const swapDataToInputToken = {
          exchange: Exchange.UniV3,
          fees: [500],
          path: [addresses.tokens.weth, addresses.tokens.USDC],
          pool: ADDRESS_ZERO,
        };

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
        });

        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

        const setTokenAmount = ether(10);
        let maxAmountIn: BigNumber;
        let inputToken: Address;

        function subject() {
          const issueParams: IssueRedeemParams = {
            setToken: setToken.address,
            amountSetToken: setTokenAmount,
            componentSwapData: componentSwapDataIssue,
            issuanceModule: debtIssuanceModule.address,
            isDebtIssuance: true,
          };
          const paymentInfo: PaymentInfo = {
            token: inputToken,
            limitAmt: maxAmountIn,
            swapDataTokenToWeth: swapDataFromInputToken,
            swapDataWethToToken: swapDataToInputToken,
          };
          if (paymentInfo.token === ETH_ADDRESS) {
            return flashMintDex.issueExactSetFromETH(
              issueParams,
              {
                value: maxAmountIn,
              },
            );
          } else {
            return flashMintDex.issueExactSetFromToken(issueParams, paymentInfo);
          }
        }

        it("Can issue set token from ETH", async () => {
          inputToken = ETH_ADDRESS;
          maxAmountIn = ether(11);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const ethBalanceBefore = await owner.wallet.getBalance();
          await subject();
          const ethBalanceAfter = await owner.wallet.getBalance();
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(ethBalanceAfter).to.gt(ethBalanceBefore.sub(maxAmountIn));
        });

        it("Can issue set token from WETH", async () => {
          inputToken = addresses.tokens.weth;
          maxAmountIn = ether(11);
          const wethToken = IWETH__factory.connect(inputToken, owner.wallet);
          await wethToken.deposit({ value: maxAmountIn });
          wethToken.approve(flashMintDex.address, maxAmountIn);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
          await subject();
          const inputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        });

        it("Can issue set token from USDC", async () => {
          inputToken = addresses.tokens.USDC;
          maxAmountIn = usdc(27000);
          const usdcToken = IERC20__factory.connect(inputToken, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, maxAmountIn);
          usdcToken.approve(flashMintDex.address, maxAmountIn);

          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          await subject();
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        });

        describe("When set token has been issued", () => {
          let outputToken: Address;
          let minAmountOut: BigNumber;

          beforeEach(async () => {
            const maxAmountIn = ether(11);
            const issueParams: IssueRedeemParams = {
              setToken: setToken.address,
              amountSetToken: setTokenAmount,
              componentSwapData: componentSwapDataIssue,
              issuanceModule: debtIssuanceModule.address,
              isDebtIssuance: true,
            };
            await flashMintDex.issueExactSetFromETH(
              issueParams,
              {
                value: maxAmountIn,
              },
            );
            await setToken.approve(flashMintDex.address, setTokenAmount);
          });

          function subject() {
            const redeemParams: IssueRedeemParams = {
              setToken: setToken.address,
              amountSetToken: setTokenAmount,
              componentSwapData: componentSwapDataRedeem,
              issuanceModule: debtIssuanceModule.address,
              isDebtIssuance: true,
            };
            const paymentInfo: PaymentInfo = {
              token: outputToken,
              limitAmt: minAmountOut,
              swapDataTokenToWeth: swapDataFromInputToken,
              swapDataWethToToken: swapDataToInputToken,
            };
            if (paymentInfo.token === ETH_ADDRESS) {
              return flashMintDex.redeemExactSetForETH(redeemParams, minAmountOut);
            } else {

              return flashMintDex.redeemExactSetForToken(redeemParams, paymentInfo);
            }
          }

          it("Can redeem set token for ETH", async () => {
            outputToken = ETH_ADDRESS;
            minAmountOut = ether(5);
            const outputTokenBalanceBefore = await owner.wallet.getBalance();
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await subject();
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await owner.wallet.getBalance();
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });

          it("Can redeem set token for WETH", async () => {
            outputToken = addresses.tokens.weth;
            minAmountOut = ether(5);
            const wethToken = IWETH__factory.connect(outputToken, owner.wallet);
            const outputTokenBalanceBefore = await wethToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await subject();
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await wethToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });

          it("Can redeem set token for USDC", async () => {
            outputToken = addresses.tokens.USDC;
            minAmountOut = usdc(26000);
            const usdcToken = IERC20__factory.connect(outputToken, owner.wallet);
            const outputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
            const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            await subject();
            const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            const outputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
            expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            expect(outputTokenBalanceAfter).to.gt(outputTokenBalanceBefore.add(minAmountOut));
          });
        });
      });
    });
  });
}
