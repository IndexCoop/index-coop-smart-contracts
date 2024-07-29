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
  // IERC20,
  IERC20__factory,
  // IWETH,
  // IWETH__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();
// const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

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
  componentSwapData: SwapData[];
  swapDataTokenToWeth: SwapData;
  swapDataWethToToken: SwapData;
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

// const NO_OP_SWAP_DATA: SwapData = {
//   path: [],
//   fees: [],
//   pool: ADDRESS_ZERO,
//   exchange: Exchange.None,
// };

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintDex - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setTokenCreator: SetTokenCreator;
    // let basicIssuanceModule: IBasicIssuanceModule;
    let debtIssuanceModule: IDebtIssuanceModule;

    setBlockNumber(20385208, true);

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

      context("when setToken with a simple LST composition is deployed", () => {
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

        it("Can issue set token from ETH", async () => {
          const maxAmountIn = ether(11);
          const setTokenAmount = ether(10);
          const issueParams: IssueParams = {
            setToken: setToken.address,
            inputToken: addresses.tokens.weth,
            amountSetToken: setTokenAmount,
            maxAmountInputToken: maxAmountIn,
            componentSwapData: componentSwapDataIssue,
            swapDataTokenToWeth: swapDataFromInputToken,
            swapDataWethToToken: swapDataToInputToken,
            issuanceModule: debtIssuanceModule.address,
            isDebtIssuance: true,
          };
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await owner.wallet.getBalance();
          const tx = await flashMintDex.issueExactSetFromETH(
            issueParams,
            {
              value: maxAmountIn,
            },
          );

          /* Start of Debugging - remove before PR */
          // Wait for the transaction to be mined
          const receipt = await tx.wait();

          const events = receipt.events.filter(event => event.event === "MaxAmountInputTokenLogged");

          // Log and check the value of each maxAmountInputToken
          events.forEach(event => {
              const maxAmountInputToken = event.args.maxAmountInputToken;
              console.log("Max Amount Input Token:", maxAmountInputToken.toString());
              // Additional assertions can be made here
          });
          /* End Debugging */

          const inputTokenBalanceAfter = await owner.wallet.getBalance();
          console.log("inputTokenBalanceBefore", inputTokenBalanceBefore.toString());
          console.log("inputTokenBalanceAfter", inputTokenBalanceAfter.toString());
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        });

        it("Can issue set token from USDC", async () => {
          const maxAmountIn = usdc(30000);
          const setTokenAmount = ether(10);
          const issueParams: IssueParams = {
            setToken: setToken.address,
            inputToken: addresses.tokens.weth,
            amountSetToken: setTokenAmount,
            maxAmountInputToken: maxAmountIn,
            componentSwapData: componentSwapDataIssue,
            swapDataTokenToWeth: swapDataFromInputToken,
            swapDataWethToToken: swapDataToInputToken,
            issuanceModule: debtIssuanceModule.address,
            isDebtIssuance: true,
          };
          const usdcToken = IERC20__factory.connect(issueParams.inputToken, owner.wallet);
          const whaleSigner = await impersonateAccount(addresses.whales.USDC);
          await usdcToken.connect(whaleSigner).transfer(owner.address, maxAmountIn);
          usdcToken.approve(flashMintDex.address, maxAmountIn);
          const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
          const inputTokenBalanceBefore = await usdcToken.balanceOf(owner.address);
          const tx = await flashMintDex.issueExactSetFromToken(issueParams);
          /* Start of Debugging - remove before PR */
          // Wait for the transaction to be mined
          const receipt = await tx.wait();

          const events = receipt.events.filter(event => event.event === "InputTokenBalanceLogged");

          // Log and check the value of each maxAmountInputToken
          events.forEach(event => {
              const inputTokenBalanceBefore = event.args.inputTokenBalanceBefore;
              console.log("Max Amount Input Token:", inputTokenBalanceBefore.toString());
              // Additional assertions can be made here
          });
          /* End Debugging */
          const inputTokenBalanceAfter = await usdcToken.balanceOf(owner.address);
          const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
          console.log("setTokenBalanceAfter", setTokenBalanceAfter.toString());
          expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
          expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        });

        // ["eth", "weth", "USDC"].forEach((inputTokenName: keyof typeof addresses.tokens | "eth") => {
        //   describe(`When inputToken is ${inputTokenName}`, () => {
        //     const ethIn = ether(1001);
        //     const maxAmountIn = inputTokenName == "USDC" ? usdc(4000000) : ethIn;
        //     const setTokenAmount = ether(1000);
        //     let inputToken: IERC20 | IWETH;
        //     // let swapDataInputTokenToEth: SwapData;
        //     // let swapDataEthToInputToken: SwapData;
        //     let issueParams: IssueParams;
        //     // let redeemParams: RedeemParams;


        //     before(async () => {
        //       if (inputTokenName != "eth") {
        //         inputToken.approve(flashMintDex.address, maxAmountIn);
        //       }
        //       if (inputTokenName === "weth") {
        //         inputToken = IWETH__factory.connect(addresses.tokens[inputTokenName], owner.wallet);
        //         await inputToken.deposit({ value: maxAmountIn });
        //       }
        //       if (inputTokenName === "USDC") {
        //         inputToken = IERC20__factory.connect(addresses.tokens[inputTokenName], owner.wallet);
        //         const whaleSigner = await impersonateAccount(addresses.whales.USDC);
        //         await inputToken.connect(whaleSigner).transfer(owner.address, maxAmountIn);
        //       }
        //     });
        //     function subject() {
        //       issueParams = {
        //         setToken: setToken.address,
        //         inputToken: inputToken.address,
        //         amountSetToken: setTokenAmount,
        //         maxAmountInputToken: maxAmountIn,
        //         swapData: componentSwapDataIssue,
        //         issuanceModule: debtIssuanceModule.address,
        //         isDebtIssuance: true,
        //       };

        //       if (inputTokenName === "eth") {
        //         // When issuing from ETH use WETH address for inputToken
        //         issueParams.inputToken = addresses.tokens.weth;
                // return flashMintDex.issueExactSetFromETH(
                //   issueParams,
                //   {
                //     value: maxAmountIn,
                //   },
                // );
        //       } else {
        //         return flashMintDex.issueExactSetFromToken(issueParams);
        //       }
        //     }
        //     it("Can issue set token", async () => {
        //       const setTokenBalanceBefore = await setToken.balanceOf(owner.address);
        //       console.log('setTokenBalanceBefore', setTokenBalanceBefore.toString());
        //       const inputTokenBalanceBefore =
        //         inputTokenName === "eth"
        //           ? await owner.wallet.getBalance()
        //           : await inputToken.balanceOf(owner.address);
        //       await subject();
        //       const inputTokenBalanceAfter =
        //         inputTokenName === "eth"
        //           ? await owner.wallet.getBalance()
        //           : await inputToken.balanceOf(owner.address);
        //       const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
        //       expect(setTokenBalanceAfter).to.eq(setTokenBalanceBefore.add(setTokenAmount));
        //       expect(inputTokenBalanceAfter).to.gt(inputTokenBalanceBefore.sub(maxAmountIn));
        //     });
        //   });
      });
    });
  });
}
