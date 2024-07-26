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
  IERC20,
  IERC20__factory,
  IWETH,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO } from "@utils/constants";
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

type IssueParams = {
  setToken: Address;
  inputToken: Address;
  amountSetToken: BigNumber;
  maxAmountInputToken: BigNumber;
  swapData: SwapData[];
  issuanceModule: Address;
  isDebtIssuance: boolean;
};

// type RedeemParams = {
//   setToken: Address;
//   outputToken: Address;
//   amountSetToken: BigNumber;
//   maxAmountInputToken: BigNumber;
//   swapData: SwapData[];
//   issuanceModule: Address;
//   isDebtIssuance: boolean;
// };

const NO_OP_SWAP_DATA: SwapData = {
  path: [],
  fees: [],
  pool: ADDRESS_ZERO,
  exchange: Exchange.None,
};

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintDex - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setTokenCreator: SetTokenCreator;
    // let basicIssuanceModule: IBasicIssuanceModule;
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
      // basicIssuanceModule = IBasicIssuanceModule__factory.connect(
      //   addresses.set.basicIssuanceModule,
      //   owner.wallet,
      // );
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
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2,
          addresses.tokens.stEth,
          addresses.dexes.curve.pools.stEthEth,
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

      it("controller address is set correctly", async () => {
        expect(await flashMintDex.setController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      context("when setToken with dsETH composition is deployed", () => {
        let setToken: SetToken;
        const components = [
          addresses.tokens.wstEth,
          addresses.tokens.rETH,
          addresses.tokens.sfrxEth,
          addresses.tokens.osEth,
          addresses.tokens.ETHx,
          addresses.tokens.swETH,
        ];
        const positions = [
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
          ethers.utils.parseEther("0.16"),
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
            path: [addresses.tokens.weth, addresses.tokens.swETH],
            pool: ADDRESS_ZERO,
          },
        ];

        // const componentSwapDataRedeem = [
        //   NO_OP_SWAP_DATA,
        //   NO_OP_SWAP_DATA,
        //   NO_OP_SWAP_DATA,
        //   NO_OP_SWAP_DATA,
        //   NO_OP_SWAP_DATA,
        //   {
        //     exchange: Exchange.UniV3,
        //     fees: [500],
        //     path: [ addresses.tokens.swETH, addresses.tokens.weth],
        //     pool: ADDRESS_ZERO,
        //   },
        // ];

        const modules = [addresses.setFork.debtIssuanceModuleV2];
        const tokenName = "Diversified Staked ETH Index";
        const tokenSymbol = "dsETH";

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

          await flashMintDex.approveTokens(
            [
              addresses.tokens.wstEth,
              addresses.tokens.rETH,
              addresses.tokens.sfrxEth,
              addresses.tokens.osEth,
              addresses.tokens.ETHx,
              addresses.tokens.swETH,
            ],
            debtIssuanceModule.address
          );

          await flashMintDex.approveSetToken(setToken.address, debtIssuanceModule.address);
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
            // let swapDataInputTokenToEth: SwapData;
            // let swapDataEthToInputToken: SwapData;
            let issueParams: IssueParams;
            // let redeemParams: RedeemParams;


            before(async () => {
              if (inputTokenName != "eth") {
                inputToken = IERC20__factory.connect(addresses.tokens[inputTokenName], owner.wallet);
                inputToken.approve(flashMintDex.address, maxAmountIn);
              }
              if (inputTokenName === "weth") {
                await inputToken.deposit({ value: maxAmountIn });
              }
              if (inputTokenName === "USDC") {
                const whaleSigner = await impersonateAccount(addresses.whales.USDC);
                await inputToken.connect(whaleSigner).transfer(owner.address, maxAmountIn);
              }
            });
            function subject() {
              console.log("debtIssuanceModule", debtIssuanceModule.address);
              issueParams = {
                setToken: setToken.address,
                inputToken: inputToken.address,
                amountSetToken: setTokenAmount,
                maxAmountInputToken: maxAmountIn,
                swapData: componentSwapDataIssue,
                issuanceModule: debtIssuanceModule.address,
                isDebtIssuance: true,
              };

              if (inputTokenName === "eth") {
                // When issuing from ETH use WETH address for inputToken
                issueParams.inputToken = addresses.tokens.weth;
                return flashMintDex.issueExactSetFromETH(
                  issueParams,
                  {
                    value: maxAmountIn,
                  },
                );
              } else {
                return flashMintDex.issueExactSetFromToken(issueParams);
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
          });


            // describe("When set token has been issued", () => {
            //   const minAmountOut = maxAmountIn.mul(8).div(10);
            //   beforeEach(async () => {
            //     await flashMintDex.issueExactSetFromETH(
            //       issueParams,
            //       {
            //         value: maxAmountIn,
            //       },
            //     );
            //     await setToken.approve(flashMintDex.address, setTokenAmount);
            //   });

            //   function subject() {
            //     if (inputTokenName === "eth") {
            //       return flashMintDex.redeemExactSetForETH(
            //         setToken.address,
            //         setTokenAmount,
            //         minAmountOut,
            //         componentSwapDataRedeem,
            //       );
            //     } else {
            //       return flashMintDex.redeemExactSetForERC20(
            //         setToken.address,
            //         setTokenAmount,
            //         inputToken.address,
            //         minAmountOut,
            //         swapDataEthToInputToken,
            //         componentSwapDataRedeem,
            //       );
            //     }
            //   }

            //   it("Can redeem set token", async () => {
            //     const inputTokenBalanceBefore =
            //       inputTokenName === "eth"
            //         ? await owner.wallet.getBalance()
            //         : await inputToken.balanceOf(owner.address);
            //     const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
            //     await subject();
            //     const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
            //     const inputTokenBalanceAfter =
            //       inputTokenName === "eth"
            //         ? await owner.wallet.getBalance()
            //         : await inputToken.balanceOf(owner.address);
            //     expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.sub(setTokenAmount));
            //     expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.add(minAmountOut));
            //   });
            // });
          // });
        });
      });
    });
  });
}
