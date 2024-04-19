import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { impersonateAccount, setBlockNumber, setBalance } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { FlashMintLeveragedExtended } from "../../../typechain";
import { IWETH, StandardTokenMock, IDebtIssuanceModule, IERC20__factory } from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";

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
  describe.only("FlashMintLeveragedExtended - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let weth: IWETH;

    setBlockNumber(201830000);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.ETH2X,
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
      let flashMintLeveraged: FlashMintLeveragedExtended;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedExtended(
          addresses.tokens.weth,
          ADDRESS_ZERO,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2,
          addresses.setFork.aaveV3LeverageModule,
          addresses.lending.aaveV3.lendingPool,
          addresses.dexes.curve.addressProvider,
          ADDRESS_ZERO, // TODO: Check if there is curve calculator deployed on arbi
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
          utils.getAddress(addresses.setFork.debtIssuanceModuleV2),
        );
      });

      describe("When setToken is approved", () => {
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let collateralTokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          const awethWhale = addresses.whales.aWETH;
          const wethWhale = addresses.whales.weth;
          const operator = "0x37e6365d4f6aE378467b0e24c9065Ce5f06D70bF";
          await setBalance(operator, ether(1000));
          const whaleSigner = await impersonateAccount(awethWhale);

          const wethWhaleSigner = await impersonateAccount(wethWhale);

          const aweth = IERC20__factory.connect(addresses.tokens.aWETH, whaleSigner);

          const weth = IERC20__factory.connect(addresses.tokens.weth, wethWhaleSigner);
          await weth.transfer(owner.address, ether(100));
          await aweth.transfer(owner.address, ether(100));

          await aweth
            .connect(owner.wallet)
            .approve(addresses.setFork.debtIssuanceModuleV2, ether(10));
          await weth.connect(owner.wallet).approve(flashMintLeveraged.address, ether(100));
          const debtIssuanceModule = (await ethers.getContractAt(
            "IDebtIssuanceModule",
            addresses.setFork.debtIssuanceModuleV2,
            owner.wallet,
          )) as IDebtIssuanceModule;

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
          collateralTokenAddress = leveragedTokenData.collateralToken;
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
              addresses.setFork.debtIssuanceModuleV2,
            ),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(
              flashMintLeveraged.address,
              addresses.setFork.debtIssuanceModuleV2,
            ),
          ).to.equal(MAX_UINT_256);
        });

        ["collateralToken", "ETH"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let amountIn: BigNumber;
            beforeEach(async () => {
              amountIn = ether(2);
            });

            describe(
              inputTokenName === "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let subjectSetAmount: BigNumber;
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;

                let inputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;

                beforeEach(async () => {
                  subjectSetAmount = ether(1);
                  swapDataDebtToCollateral = {
                    path: [addresses.tokens.USDC, addresses.tokens.weth],
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

                  if (inputTokenName === "collateralToken") {
                    inputToken = weth;
                  } else {
                    // swapDataInputToken = swapDataDebtToCollateral;

                    if (inputTokenName === "WETH") {
                      inputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
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
                  await subject();
                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

                  expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
                  expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
                });
              },
            );

            describe(
              inputTokenName === "ETH" ? "issueSetFromExactETH" : "#issueSetFromExactERC20",
              () => {
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputTokenToCollateral: SwapData;
                let swapDataInputTokenToETH: SwapData;

                let inputToken: StandardTokenMock | IWETH;
                let subjectMinSetAmount: BigNumber;

                let subjectSetToken: Address;
                let subjectAmountIn: BigNumber;
                let subjectInputToken: Address;
                let subjectPriceEstimateInflater: BigNumber;
                let subjectMaxDust: BigNumber;

                beforeEach(async () => {
                  swapDataDebtToCollateral = {
                    path: [addresses.tokens.USDC, addresses.tokens.weth],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  swapDataInputTokenToCollateral = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };

                  subjectPriceEstimateInflater = ether(0.9);

                  if (inputTokenName === "collateralToken") {
                    inputToken = weth;
                  } else {
                    // swapDataInputTokenToCollateral = swapDataDebtToCollateral;

                    if (inputTokenName === "WETH") {
                      inputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
                  }

                  let inputTokenBalance: BigNumber;
                  if (inputTokenName === "ETH") {
                    subjectAmountIn = amountIn;
                  } else {
                    inputTokenBalance = await inputToken.balanceOf(owner.address);
                    subjectAmountIn = inputTokenBalance.div(50);
                    await inputToken.approve(flashMintLeveraged.address, MAX_UINT_256);
                    subjectInputToken = inputToken.address;
                  }
                  subjectMaxDust = subjectAmountIn.div(1000);
                  subjectMinSetAmount = subjectAmountIn.mul(2).div(3);
                  subjectSetToken = setToken.address;
                  swapDataInputTokenToETH = swapDataInputTokenToCollateral; // Assumes Collateral Token is WETH
                });

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.issueSetFromExactETH(
                      subjectSetToken,
                      subjectMinSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputTokenToCollateral,
                      subjectPriceEstimateInflater,
                      subjectMaxDust,
                      { value: subjectAmountIn },
                    );
                  }
                  return flashMintLeveraged.issueSetFromExactERC20(
                    subjectSetToken,
                    subjectMinSetAmount,
                    subjectInputToken,
                    subjectAmountIn,
                    swapDataDebtToCollateral,
                    swapDataInputTokenToCollateral,
                    swapDataInputTokenToETH,
                    subjectPriceEstimateInflater,
                    subjectMaxDust,
                  );
                }

                it("should issue at least minSetAmount of set tokens", async () => {
                  const setBalancebefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setObtained = setBalanceAfter.sub(setBalancebefore);
                  expect(setObtained).to.gte(subjectMinSetAmount);
                });

                it("should spend exactly inputAmount", async () => {
                  const inputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);

                  const tx = await subject();
                  const receipt = await tx.wait();
                  const gasCosts = receipt.gasUsed.mul(tx.gasPrice);

                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  let inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  expect(inputSpent).to.gt(BigNumber.from(0));
                  if (inputTokenName === "ETH") {
                    inputSpent = inputSpent.sub(gasCosts);
                    expect(inputSpent).to.gte(subjectAmountIn.sub(subjectMaxDust));
                    expect(inputSpent).to.lte(subjectAmountIn);
                  } else {
                    expect(inputSpent).to.eq(subjectAmountIn);
                  }
                });
              },
            );
            describe(
              inputTokenName === "ETH" ? "redeemSetForExactETH" : "#redeemSetForExactERC20",
              () => {
                let swapDataCollateralToDebt: SwapData;
                let swapDataOutputToken: SwapData;
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;
                let swapDataOutputTokenToETH: SwapData;

                let outputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMaxSetAmount: BigNumber;
                let subjectAmountOut: BigNumber;
                let subjectOutputToken: Address;
                let subjectPriceEstimateInflater: BigNumber;
                let subjectMaxDust: BigNumber;

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.redeemSetForExactETH(
                      subjectSetToken,
                      subjectMaxSetAmount,
                      subjectAmountOut,
                      swapDataCollateralToDebt,
                      swapDataOutputToken,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
                      subjectPriceEstimateInflater,
                      subjectMaxDust,
                    );
                  }
                  return flashMintLeveraged.redeemSetForExactERC20(
                    subjectSetToken,
                    subjectMaxSetAmount,
                    subjectOutputToken,
                    subjectAmountOut,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                    swapDataOutputTokenToETH,
                    subjectPriceEstimateInflater,
                    subjectMaxDust,
                  );
                }

                beforeEach(async () => {
                  subjectPriceEstimateInflater = ether(0.9);
                  subjectMaxSetAmount = ether(1);
                  subjectAmountOut = ether(0.1);
                  subjectMaxDust = subjectAmountOut.div(1000);
                  swapDataCollateralToDebt = {
                    path: [collateralTokenAddress, addresses.tokens.USDC],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  swapDataDebtToCollateral = {
                    path: [addresses.tokens.USDC, collateralTokenAddress],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  swapDataOutputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };
                  swapDataInputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };
                  swapDataOutputTokenToETH = swapDataInputToken; // Assumes Collateral Token is WETH

                  if (inputTokenName === "collateralToken") {
                    outputToken = weth;
                  } else {
                    // swapDataOutputToken = swapDataCollateralToDebt;
                    // swapDataInputToken = swapDataDebtToCollateral;

                    if (inputTokenName === "WETH") {
                      outputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
                  }

                  subjectSetToken = setToken.address;
                  await setToken.approve(flashMintLeveraged.address, subjectMaxSetAmount);

                  if (inputTokenName !== "ETH") {
                    subjectOutputToken = outputToken.address;
                  }
                });

                it("should redeem at most subjectMaxSetAmount", async () => {
                  const setBalanceBefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
                  expect(setRedeemed).to.lte(subjectMaxSetAmount);
                });

                it("should return exactly specified of output tokens", async () => {
                  const outputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const tx = await subject();
                  const receipt = await tx.wait();
                  const gasCosts = receipt.gasUsed.mul(tx.gasPrice);
                  const outputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  let outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  if (inputTokenName === "ETH") {
                    outputObtained = outputObtained.add(gasCosts);
                    expect(outputObtained).to.gte(subjectAmountOut);
                    expect(outputObtained).to.lte(subjectAmountOut.add(subjectMaxDust));
                  } else {
                    expect(outputObtained).to.eq(subjectAmountOut);
                  }
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
                let subjectSetAmount: BigNumber;
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
                  subjectSetAmount = ether(1);
                  swapDataCollateralToDebt = {
                    path: [collateralTokenAddress, addresses.tokens.USDC],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };
                  swapDataOutputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };

                  if (inputTokenName === "collateralToken") {
                    outputToken = weth;
                  } else {
                    if (inputTokenName === "WETH") {
                      outputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
                  }

                  subjectMinAmountOut = subjectSetAmount.div(10);
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
