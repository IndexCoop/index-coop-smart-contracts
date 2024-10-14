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
  FlashMintHyETHV2,
  IPendlePrincipalToken__factory,
  IERC20,
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

const NO_OP_SWAP_DATA: SwapData = {
  path: [],
  fees: [],
  pool: ADDRESS_ZERO,
  exchange: Exchange.None,
};

if (process.env.INTEGRATIONTEST) {
  describe("FlashMintHyETHV2 - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setTokenCreator: SetTokenCreator;
    let debtIssuanceModule: IDebtIssuanceModule;

    // const collateralTokenAddress = addresses.tokens.stEth;
    setBlockNumber(20030042, true);

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
      let flashMintHyETH: FlashMintHyETHV2;
      before(async () => {
        flashMintHyETH = await deployer.extensions.deployFlashMintHyETHV2(
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
        let setToken: SetToken;
        const components = [
          addresses.tokens.instadappEthV2,
          addresses.tokens.pendleEzEth1226,
          addresses.tokens.pendleEEth0926,
          addresses.tokens.pendleEEth1226,
          addresses.tokens.morphoRe7WETH,
          addresses.tokens.USDC,
        ];
        const positions = [
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          usdc(600),
        ];

        const componentSwapDataIssue = [
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          {
            exchange: Exchange.UniV3,
            fees: [500],
            path: [addresses.tokens.weth, addresses.tokens.USDC],
            pool: ADDRESS_ZERO,
          },
        ];

        const componentSwapDataRedeem = [
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          NO_OP_SWAP_DATA,
          {
            exchange: Exchange.UniV3,
            fees: [500],
            path: [ addresses.tokens.USDC, addresses.tokens.weth],
            pool: ADDRESS_ZERO,
          },
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

          await flashMintHyETH.setERC4626Component(
            addresses.tokens.morphoRe7WETH,
            true
          );
          await flashMintHyETH.approveToken(
            addresses.tokens.weth,
            addresses.tokens.morphoRe7WETH,
            MAX_UINT_256
          );
          const ezEth1226PendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleEzEth1226,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const ezEth1226SyToken = await ezEth1226PendleToken.SY();
          await flashMintHyETH.approveToken(
            ezEth1226SyToken,
            addresses.dexes.pendle.markets.ezEth1226,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleEzEth1226,
            ezEth1226SyToken,
            addresses.tokens.ezEth,
            addresses.dexes.pendle.markets.ezEth1226,
            ethers.utils.parseEther("1.0005"),
          );
          // ezETH -> weth pool: https://etherscan.io/address/0xbe80225f09645f172b079394312220637c440a63#code
          await flashMintHyETH.setSwapData(addresses.tokens.ezEth, ADDRESS_ZERO, {
            path: [addresses.tokens.ezEth, addresses.tokens.weth],
            fees: [100],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });

          const pendleEEth0926PendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleEEth0926,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const pendleEEth0926SyToken = await pendleEEth0926PendleToken.SY();
          await flashMintHyETH.approveToken(
            pendleEEth0926SyToken,
            addresses.dexes.pendle.markets.eEth0926,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleEEth0926,
            pendleEEth0926SyToken,
            addresses.tokens.weEth,
            addresses.dexes.pendle.markets.eEth0926,
            ethers.utils.parseEther("1.0005"),
          );
          // weETH -> weth pool: https://etherscan.io/address/0x7a415b19932c0105c82fdb6b720bb01b0cc2cae3
          await flashMintHyETH.setSwapData(addresses.tokens.weEth, ADDRESS_ZERO, {
            path: [addresses.tokens.weEth, addresses.tokens.weth],
            fees: [500],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });

          const pendleEEth1226PendleToken = IPendlePrincipalToken__factory.connect(
            addresses.tokens.pendleEEth1226,
            owner.wallet,
          );
          await flashMintHyETH.approveSetToken(setToken.address);
          const pendleEEth1226SyToken = await pendleEEth1226PendleToken.SY();
          await flashMintHyETH.approveToken(
            pendleEEth1226SyToken,
            addresses.dexes.pendle.markets.eEth1226,
            MAX_UINT_256,
          );
          await flashMintHyETH.setPendleMarket(
            addresses.tokens.pendleEEth1226,
            pendleEEth1226SyToken,
            addresses.tokens.weEth,
            addresses.dexes.pendle.markets.eEth1226,
            ethers.utils.parseEther("1.0005"),
          );
          // weETH -> weth pool: https://etherscan.io/address/0x7a415b19932c0105c82fdb6b720bb01b0cc2cae3
          await flashMintHyETH.setSwapData(addresses.tokens.weEth, ADDRESS_ZERO, {
            path: [addresses.tokens.weEth, addresses.tokens.weth],
            fees: [500],
            pool: ADDRESS_ZERO,
            exchange: 3,
          });
        });
        it("setToken is deployed correctly", async () => {
          expect(await setToken.symbol()).to.eq(tokenSymbol);
        });

        ["eth", "weth", "USDC"].forEach((inputTokenName: keyof typeof addresses.tokens | "eth") => {
          describe(`When inputToken is ${inputTokenName}`, () => {
            const ethIn = ether(1001);
            const maxAmountIn = inputTokenName == "USDC" ? usdc(4000000) : ethIn;
            const setTokenAmount = ether(1000);
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
                return flashMintHyETH.issueExactSetFromETH(
                  setToken.address,
                  setTokenAmount,
                  componentSwapDataIssue,
                  {
                    value: maxAmountIn,
                  },
                );
              } else {
                return flashMintHyETH.issueExactSetFromERC20(
                  setToken.address,
                  setTokenAmount,
                  inputToken.address,
                  maxAmountIn,
                  swapDataInputTokenToEth,
                  swapDataEthToInputToken,
                  componentSwapDataIssue,
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
              const minAmountOut = maxAmountIn.mul(8).div(10);
              beforeEach(async () => {
                await flashMintHyETH.issueExactSetFromETH(
                  setToken.address,
                  setTokenAmount,
                  componentSwapDataIssue,
                  {
                    value: ethIn,
                  },
                );
                await setToken.approve(flashMintHyETH.address, setTokenAmount);
              });

              function subject() {
                if (inputTokenName === "eth") {
                  return flashMintHyETH.redeemExactSetForETH(
                    setToken.address,
                    setTokenAmount,
                    minAmountOut,
                    componentSwapDataRedeem,
                  );
                } else {
                  return flashMintHyETH.redeemExactSetForERC20(
                    setToken.address,
                    setTokenAmount,
                    inputToken.address,
                    minAmountOut,
                    swapDataEthToInputToken,
                    componentSwapDataRedeem,
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
