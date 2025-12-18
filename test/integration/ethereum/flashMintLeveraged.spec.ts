import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { cacheBeforeEach } from "@utils/test";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { FlashMintLeveraged } from "@utils/contracts/index";
import {
  IWETH,
  StandardTokenMock,
  IDebtIssuanceModule,
  IERC20__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
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

if (process.env.INTEGRATIONTEST) {
  describe("FlashMintLeveraged - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setToken: StandardTokenMock;
    let weth: IWETH;

    // Using a recent block to reproduce the "TOO MANY EQUITY POSITIONS" issue with ETH3x
    setBlockNumber(24039350, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.eth3x,
      )) as StandardTokenMock;

      weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;
    });

    it("can get lending pool from address provider", async () => {
      const addressProvider = await ethers.getContractAt(
        "IPoolAddressesProvider",
        addresses.lending.aaveV3.addressProvider,
      );
      const lendingPool = await addressProvider.getPool();
      expect(lendingPool).to.eq(addresses.lending.aaveV3.lendingPool);
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveraged;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveraged(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2_A1,
          addresses.setFork.aaveV3LeverageModule_A1,
          addresses.lending.aaveV3.lendingPool,
          addresses.dexes.curve.addressProvider,
          addresses.dexes.curve.calculator,
          addresses.dexes.balancerv2.vault,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("controller address is set correctly", async () => {
        expect(await flashMintLeveraged.setController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintLeveraged.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.setFork.debtIssuanceModuleV2_A1),
        );
      });

      describe("When setToken is approved", () => {
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          const wethWhale = "0x8EB8a3b98659Cce290402893d0123abb75E3ab28";
          const aWethWhale = "0x28a55C4b4f9615FDE3CDAdDf6cc01FcF2E38A6b0";

          const wethWhaleSigner = await impersonateAccount(wethWhale);
          const whaleWeth = IERC20__factory.connect(addresses.tokens.weth, wethWhaleSigner);
          await whaleWeth.transfer(owner.address, ether(100));

          const aWethWhaleSigner = await impersonateAccount(aWethWhale);
          const whaleaWeth = IERC20__factory.connect(addresses.tokens.aWeth, aWethWhaleSigner);
          const aWeth = IERC20__factory.connect(addresses.tokens.aWeth, owner.wallet);
          await whaleaWeth.transfer(owner.address, ether(100));

          await weth.connect(owner.wallet).approve(flashMintLeveraged.address, ether(100));
          const debtIssuanceModule = (await ethers.getContractAt(
            "IDebtIssuanceModule",
            addresses.setFork.debtIssuanceModuleV2_A1,
            owner.wallet,
          )) as IDebtIssuanceModule;
          await aWeth.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));

          const issueTx = await debtIssuanceModule.issue(
            setToken.address,
            ether(10),
            owner.address,
          );

          await issueTx.wait();

          await flashMintLeveraged.approveSetToken(setToken.address);

          const leveragedTokenData = await flashMintLeveraged.getLeveragedTokenData(
            setToken.address,
            ether(1),
            true,
          );

          collateralATokenAddress = leveragedTokenData.collateralAToken;
          debtTokenAddress = leveragedTokenData.debtToken;

          collateralAToken = (await ethers.getContractAt(
            "StandardTokenMock",
            collateralATokenAddress,
          )) as StandardTokenMock;
          debtToken = (await ethers.getContractAt(
            "StandardTokenMock",
            debtTokenAddress,
          )) as StandardTokenMock;
        });

        it("should adjust collateral a token allowance correctly", async () => {
          expect(
            await collateralAToken.allowance(
              flashMintLeveraged.address,
              addresses.setFork.debtIssuanceModuleV2_A1,
            ),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(
              flashMintLeveraged.address,
              addresses.setFork.debtIssuanceModuleV2_A1,
            ),
          ).to.equal(MAX_UINT_256);
        });

        ["WETH"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let subjectSetAmount: BigNumber;
            let amountIn: BigNumber;
            cacheBeforeEach(async () => {
              amountIn = ether(2);
              subjectSetAmount = ether(1);
            });

            describe(
              inputTokenName === "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;

                let inputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;

                beforeEach(async () => {
                  swapDataDebtToCollateral = {
                    path: [addresses.tokens.usdt, addresses.tokens.weth],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  swapDataInputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };

                  if (inputTokenName === "WETH") {
                    inputToken = weth;
                    await weth.deposit({ value: amountIn });
                  }

                  let inputTokenBalance: BigNumber;
                  if (inputTokenName === "ETH") {
                    subjectMaxAmountIn = amountIn;
                  } else {
                    inputTokenBalance = await inputToken.balanceOf(owner.address);
                    subjectMaxAmountIn = inputTokenBalance;
                    await inputToken.approve(flashMintLeveraged.address, subjectMaxAmountIn);
                    subjectInputToken = inputToken.address;
                  }
                  subjectSetToken = setToken.address;
                });

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
                      { value: subjectMaxAmountIn },
                    );
                  }
                  console.log("issuing", {
                    subjectSetToken,
                    subjectSetAmount,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                  });
                  return flashMintLeveraged.issueExactSetFromERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectInputToken,
                    subjectMaxAmountIn,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                  );
                }

                async function subjectQuote() {
                  console.log("quoting", {
                    subjectSetToken,
                    subjectSetAmount,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                  });
                  return flashMintLeveraged.callStatic.getIssueExactSet(
                    subjectSetToken,
                    subjectSetAmount,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                  );
                }

                it("should issue the correct amount of tokens", async () => {
                  const setBalancebefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setObtained = setBalanceAfter.sub(setBalancebefore);
                  expect(setObtained).to.eq(subjectSetAmount);
                });

                it("should spend less than specified max amount", async () => {
                  const inputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  await subject();
                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  expect(inputSpent.gt(0)).to.be.true;
                  expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
                });

                it("should quote the correct input amount", async () => {
                  const quotedInputAmount = await subjectQuote();
                  const inputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  console.log("inputBalanceBefore", inputBalanceBefore.toString());
                  await subject();
                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  console.log("inputBalanceAfter", inputBalanceAfter.toString());
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

                  console.log("inputSpent", inputSpent.toString());
                  console.log("quotedInputAmount", quotedInputAmount.toString());

                  expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
                  expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
                });
              },
            );

            describe(
              inputTokenName === "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                let swapDataCollateralToDebt: SwapData;
                let swapDataOutputToken: SwapData;

                let outputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMinAmountOut: BigNumber;
                let subjectOutputToken: Address;

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.redeemExactSetForETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectMinAmountOut,
                      swapDataCollateralToDebt,
                      swapDataOutputToken,
                    );
                  }
                  return flashMintLeveraged.redeemExactSetForERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectOutputToken,
                    subjectMinAmountOut,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                  );
                }

                async function subjectQuote(): Promise<BigNumber> {
                  return flashMintLeveraged.callStatic.getRedeemExactSet(
                    subjectSetToken,
                    subjectSetAmount,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                  );
                }

                beforeEach(async () => {
                  swapDataCollateralToDebt = {
                    path: [addresses.tokens.weth, addresses.tokens.usdt],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  if (inputTokenName === "WETH") {
                    outputToken = weth;
                    swapDataOutputToken = {
                      path: [],
                      fees: [],
                      pool: ADDRESS_ZERO,
                      exchange: Exchange.None,
                    };
                    outputToken = weth;
                    await weth.deposit({ value: amountIn });
                  }

                  subjectMinAmountOut = subjectSetAmount.div(100);
                  subjectSetToken = setToken.address;
                  await setToken.approve(flashMintLeveraged.address, subjectSetAmount);

                  if (inputTokenName !== "ETH") {
                    subjectOutputToken = outputToken.address;
                  }
                });

                it("should redeem the correct amount of tokens", async () => {
                  const setBalanceBefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
                  expect(setRedeemed).to.eq(subjectSetAmount);
                });

                it("should return at least the specified minimum of output tokens", async () => {
                  const outputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  await subject();
                  const outputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  expect(outputObtained.gte(subjectMinAmountOut)).to.be.true;
                });

                it("should quote the correct output amount", async () => {
                  const outputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  await subject();
                  const outputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);

                  const outputAmountQuote = await subjectQuote();
                  expect(outputAmountQuote).to.gt(preciseMul(outputObtained, ether(0.99)));
                  expect(outputAmountQuote).to.lt(preciseMul(outputObtained, ether(1.01)));
                });
              },
            );
          });
        });
      });
    });
  });
}
