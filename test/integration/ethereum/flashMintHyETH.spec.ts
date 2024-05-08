import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ProtocolUtils } from "@utils/common";
import { ethers } from "hardhat";
import { utils } from "ethers";
import {
  IDebtIssuanceModule,
  IDebtIssuanceModule__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  FlashMintHyETH,
  IPendlePrincipalToken__factory,
  IERC20,
  IERC20__factory,
  IWETH,
  IWETH__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether, usdc } from "@utils/index";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();
const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

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

if (process.env.INTEGRATIONTEST) {
  describe("FlashMintHyETH - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setTokenCreator: SetTokenCreator;
    let debtIssuanceModule: IDebtIssuanceModule;

    // const collateralTokenAddress = addresses.tokens.stEth;
    setBlockNumber(19740000, true);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      setTokenCreator = SetTokenCreator__factory.connect(
        addresses.setFork.setTokenCreator,
        owner.wallet,
      );
      debtIssuanceModule = IDebtIssuanceModule__factory.connect(
        addresses.setFork.debtIssuanceModuleV2,
        owner.wallet,
      );
    });

    context("When exchange issuance is deployed", () => {
      let flashMintHyETH: FlashMintHyETH;
      before(async () => {
        flashMintHyETH = await deployer.extensions.deployFlashMintHyETH(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.dexes.curve.calculator,
          addresses.dexes.curve.addressProvider,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2,
          addresses.tokens.stEth,
          addresses.dexes.curve.pools.stEthEth,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintHyETH.dexAdapter();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("controller address is set correctly", async () => {
        expect(await flashMintHyETH.setController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintHyETH.issuanceModule()).to.eq(
          utils.getAddress(addresses.setFork.debtIssuanceModuleV2),
        );
      });

      context("when setToken with hyETH launch composition is deployed", () => {
        const setToken: SetToken;
        const components = [
          addresses.tokens.instadappEthV2,
          addresses.tokens.pendleEEth0624,
          addresses.tokens.pendleRsEth0624,
          addresses.tokens.pendleRswEth0624,
          addresses.tokens.acrossWethLP,
        ];
        const positions = [
          ethers.utils.parseEther("0.2"),
          ethers.utils.parseEther("0.2"),
          ethers.utils.parseEther("0.2"),
          ethers.utils.parseEther("0.2"),
          ethers.utils.parseEther("0.2"),
        ];
        const modules = [addresses.setFork.debtIssuanceModuleV2];
        const tokenName = "IndexCoop High Yield ETH";
        const tokenSymbol = "HyETH";

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

          await flashMintHyETH.approveToken(
            addresses.tokens.stEth,
            addresses.tokens.instadappEthV2,
            MAX_UINT_256,
          );
          await flashMintHyETH.setSwapData(addresses.tokens.stEth, ADDRESS_ZERO, {
            path: [addresses.tokens.stEth, ETH_ADDRESS],
            fees: [],
            pool: addresses.dexes.curve.pools.stEthEth,
            exchange: 4,
          });

          const eEthPendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleEEth0624,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const eEthSyToken = await eEthPendleToken.SY();
          await flashMintHyETH.approveToken(
            eEthSyToken,
            addresses.dexes.pendle.markets.eEth0624,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleEEth0624,
            eEthSyToken,
            addresses.tokens.weEth,
            addresses.dexes.pendle.markets.eEth0624,
          );
          // weETH -> weth pool: https://etherscan.io/address/0x7a415b19932c0105c82fdb6b720bb01b0cc2cae3
          await flashMintHyETH.setSwapData(addresses.tokens.weEth, ADDRESS_ZERO, {
            path: [addresses.tokens.weEth, addresses.tokens.weth],
            fees: [500],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });

          const rsEthPendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleRsEth0624,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const rsEthSyToken = await rsEthPendleToken.SY();
          await flashMintHyETH.approveToken(
            rsEthSyToken,
            addresses.dexes.pendle.markets.rsEth0624,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleRsEth0624,
            rsEthSyToken,
            addresses.tokens.rsEth,
            addresses.dexes.pendle.markets.rsEth0624,
          );
          // rsEth -> weth pool: https://etherscan.io/address/0x059615ebf32c946aaab3d44491f78e4f8e97e1d3
          await flashMintHyETH.setSwapData(addresses.tokens.rsEth, ADDRESS_ZERO, {
            path: [addresses.tokens.rsEth, addresses.tokens.weth],
            fees: [500],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });

          const rswEthPendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleRswEth0624,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const rswEthSyToken = await rswEthPendleToken.SY();
          await flashMintHyETH.approveToken(
            rswEthSyToken,
            addresses.dexes.pendle.markets.rswEth0624,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleRswEth0624,
            rswEthSyToken,
            addresses.tokens.rswEth,
            addresses.dexes.pendle.markets.rswEth0624,
          );
          // rswEth -> weth pool: https://etherscan.io/address/0xe62627326d7794e20bb7261b24985294de1579fe
          await flashMintHyETH.setSwapData(addresses.tokens.rswEth, ADDRESS_ZERO, {
            path: [addresses.tokens.rswEth, addresses.tokens.weth],
            fees: [3000],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });
        });
        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

        ["eth", "weth", "USDC"].forEach((inputTokenName: keyof typeof addresses.tokens | "eth") => {
          describe(`When inputToken is ${inputTokenName}`, () => {
            let ethIn = ether(1.01);
            let maxAmountIn = inputTokenName == "USDC" ? usdc(3300) : ethIn;
            let setTokenAmount = ether(1);
            let inputToken: IERC20 | IWETH;
            let swapDataInputTokenToEth: SwapData;
            let swapDataEthToInputToken: SwapData;

            before(async () => {
              if (inputTokenName != "eth") {
                inputToken = IWETH__factory.connect(addresses.tokens[inputTokenName], owner.wallet);
                inputToken.approve(flashMintHyETH.address, maxAmountIn);
              }
              if (inputTokenName === "weth") {
                await inputToken.deposit({ value: maxAmountIn });
                swapDataInputTokenToEth = {
                  path: [addresses.tokens.weth, ETH_ADDRESS],
                  fees: [],
                  pool: ADDRESS_ZERO,
                  exchange: 0,
                };
                swapDataEthToInputToken = {
                  path: [ETH_ADDRESS, addresses.tokens.weth],
                  fees: [],
                  pool: ADDRESS_ZERO,
                  exchange: 0,
                };
              }
              if (inputTokenName === "USDC") {
                const whaleSigner = await impersonateAccount(addresses.whales.USDC);
                await inputToken.connect(whaleSigner).transfer(owner.address, maxAmountIn);
                swapDataInputTokenToEth = {
                  path: [addresses.tokens.USDC, addresses.tokens.weth],
                  fees: [500],
                  pool: ADDRESS_ZERO,
                  exchange: Exchange.UniV3,
                };
                swapDataEthToInputToken = {
                  path: [addresses.tokens.weth, addresses.tokens.USDC],
                  fees: [500],
                  pool: ADDRESS_ZERO,
                  exchange: Exchange.UniV3,
                };
              }
            });
            function subject() {
              if (inputTokenName === "eth") {
                return flashMintHyETH.issueExactSetFromETH(setToken.address, setTokenAmount, {
                  value: maxAmountIn,
                });
              } else {
                return flashMintHyETH.issueExactSetFromERC20(
                  setToken.address,
                  setTokenAmount,
                  inputToken.address,
                  maxAmountIn,
                  swapDataInputTokenToEth,
                  swapDataEthToInputToken,
                );
              }
            }
            it("Can issue set token", async () => {
              const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
              const inputTokenBalanceBefore =
                inputTokenName === "eth"
                  ? await owner.wallet.getBalance()
                  : await inputToken.balanceOf(owner.address);
              await subject();
              const inputTokenBalanceAfter =
                inputTokenName === "eth"
                  ? await owner.wallet.getBalance()
                  : await inputToken.balanceOf(owner.address);
              const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
              expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
              expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
            });

            describe("When set token has been issued", () => {
              let minAmountOut = maxAmountIn.mul(8).div(10);
              beforeEach(async () => {
                await flashMintHyETH.issueExactSetFromETH(setToken.address, setTokenAmount, {
                  value: ethIn,
                });
                await setToken.approve(flashMintHyETH.address, setTokenAmount);
              });

              function subject() {
                if (inputTokenName === "eth") {
                  return flashMintHyETH.redeemExactSetForETH(
                    setToken.address,
                    setTokenAmount,
                    minAmountOut,
                  );
                } else {
                  return flashMintHyETH.redeemExactSetForERC20(
                    setToken.address,
                    setTokenAmount,
                    inputToken.address,
                    minAmountOut,
                    swapDataEthToInputToken,
                  );
                }
              }

              it("Can redeem set token", async () => {
                const inputTokenBalanceBefore =
                  inputTokenName === "eth"
                    ? await owner.wallet.getBalance()
                    : await inputToken.balanceOf(owner.address);
                const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
                await subject();
                const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
                const inputTokenBalanceAfter =
                  inputTokenName === "eth"
                    ? await owner.wallet.getBalance()
                    : await inputToken.balanceOf(owner.address);
                expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
                expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.add(minAmountOut));
              });
            });
          });
        });
      });
    });
  });
}
