import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul, usdc } from "@utils/index";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { FlashMintLeveragedForCompound } from "@utils/contracts/index";
import { IWETH, WETH9, StandardTokenMock, IUniswapV2Router } from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
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

const getDeadline = async () => {
  const block = await ethers.provider.getBlock("latest");
  // add 7 days
  return BigNumber.from(block.timestamp).add(60 * 60 * 24 * 7);
};
if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceLeveragedForCompound - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let uSDC: StandardTokenMock;
    let weth: IWETH;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.ETH2xFli,
      )) as StandardTokenMock;
      uSDC = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.USDC,
      )) as StandardTokenMock;
      weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;
    });

    it("can get lending pool from address provider", async () => {
      const addressProvider = await ethers.getContractAt(
        "ILendingPoolAddressesProviderV2",
        addresses.lending.aave.addressProvider,
      );
      const lendingPool = await addressProvider.getLendingPool();
      expect(lendingPool).to.eq(addresses.lending.aave.lendingPool);
    });

    context("When exchange issuance is deployed", () => {
      let exchangeIssuance: FlashMintLeveragedForCompound;
      before(async () => {
        exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveragedForCompound(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.set.controller,
          addresses.set.debtIssuanceModule,
          addresses.set.compoundLeverageModule,
          addresses.lending.aave.addressProvider,
          addresses.dexes.curve.addressProvider,
          addresses.dexes.curve.calculator,
          addresses.tokens.cEther,
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await exchangeIssuance.addresses();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("cEther address is set correctly", async () => {
        const cEtherAddress = await exchangeIssuance.cEtherAddress();
        expect(cEtherAddress).to.eq(utils.getAddress(addresses.tokens.cEther));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await exchangeIssuance.addresses();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await exchangeIssuance.addresses();
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await exchangeIssuance.addresses();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
      });

      it("controller address is set correctly", async () => {
        expect(await exchangeIssuance.setController()).to.eq(
          utils.getAddress(addresses.set.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await exchangeIssuance.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.set.debtIssuanceModule),
        );
      });

      describe("When setToken is approved", () => {
        let collateralCToken: StandardTokenMock;
        let collateralToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralCTokenAddress: Address;
        let collateralTokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          await exchangeIssuance.approveSetToken(setToken.address);

          const leveragedTokenData = await exchangeIssuance.getLeveragedTokenData(
            setToken.address,
            ether(1),
            true,
          );

          collateralCTokenAddress = leveragedTokenData.collateralCToken;
          collateralTokenAddress = leveragedTokenData.collateralToken;
          debtTokenAddress = leveragedTokenData.debtToken;

          collateralCToken = (await ethers.getContractAt(
            "StandardTokenMock",
            collateralCTokenAddress,
          )) as StandardTokenMock;
          collateralToken = (await ethers.getContractAt(
            "StandardTokenMock",
            collateralTokenAddress,
          )) as StandardTokenMock;
          debtToken = (await ethers.getContractAt(
            "StandardTokenMock",
            debtTokenAddress,
          )) as StandardTokenMock;
        });

        it("should adjust collateral a token allowance correctly", async () => {
          expect(
            await collateralCToken.allowance(
              exchangeIssuance.address,
              addresses.set.debtIssuanceModule,
            ),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(exchangeIssuance.address, addresses.set.debtIssuanceModule),
          ).to.equal(MAX_UINT_256);
        });

        ["CollateralToken", "ETH", "ERC20"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let subjectSetAmount: BigNumber;
            let amountIn: BigNumber;
            beforeEach(async () => {
              amountIn = ether(100);
              subjectSetAmount = ether(1);
            });

            describe(
              inputTokenName == "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;

                let inputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;

                beforeEach(async () => {
                  const inputTokenMapping: { [key: string]: StandardTokenMock | WETH9 | IWETH } = {
                    CollateralToken: collateralToken,
                    ETH: weth,
                    ERC20: uSDC,
                  };
                  inputToken = inputTokenMapping[inputTokenName];
                  subjectInputToken =
                    inputTokenName == "ETH" ? addresses.dexes.curve.ethAddress : inputToken.address;

                  if (inputTokenName == "CollateralToken") {
                    await weth.deposit({ value: amountIn });
                    subjectMaxAmountIn = amountIn;
                    await weth.approve(exchangeIssuance.address, MAX_UINT_256);
                  } else if (inputTokenName == "ERC20") {
                    amountIn = usdc(100);
                    const quickRouter = (await ethers.getContractAt(
                      "IUniswapV2Router",
                      addresses.dexes.uniV2.router,
                    )) as IUniswapV2Router;
                    await quickRouter.swapETHForExactTokens(
                      amountIn,
                      [weth.address, uSDC.address],
                      owner.address,
                      await getDeadline(),
                      { value: ether(1) },
                    );
                    await inputToken.approve(exchangeIssuance.address, MAX_UINT_256);
                  } else {
                    subjectMaxAmountIn = amountIn;
                  }

                  let inputTokenBalance: BigNumber;
                  if (inputTokenName == "ETH") {
                    subjectMaxAmountIn = amountIn;
                  } else {
                    inputTokenBalance = await inputToken.balanceOf(owner.address);
                    subjectMaxAmountIn = inputTokenBalance;
                    await inputToken.approve(exchangeIssuance.address, subjectMaxAmountIn);
                    subjectInputToken = inputToken.address;
                  }
                  subjectSetToken = setToken.address;

                  await setToken.approve(exchangeIssuance.address, MAX_UINT_256);

                  swapDataDebtToCollateral = {
                    path: [uSDC.address, collateralTokenAddress],
                    fees: [3000],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.Quickswap,
                  };

                  swapDataInputToken = {
                    path: [inputToken.address, collateralTokenAddress],
                    fees: [3000],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.Quickswap,
                  };
                });

                async function subject() {
                  if (inputTokenName == "ETH") {
                    return exchangeIssuance.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
                      { value: subjectMaxAmountIn },
                    );
                  }
                  return exchangeIssuance.issueExactSetFromERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectInputToken,
                    subjectMaxAmountIn,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                  );
                }

                async function subjectQuote() {
                  return exchangeIssuance.callStatic.getIssueExactSet(
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
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  await subject();
                  const inputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  expect(inputSpent.gt(0)).to.be.true;
                  expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
                });

                it("should quote the correct input amount", async () => {
                  const inputBalanceBefore =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const result = await subject();
                  const inputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  let inputSpent = inputBalanceBefore.sub(inputBalanceAfter);


                  if (inputTokenName == "ETH") {
                    const gasFee = await exchangeIssuance.estimateGas.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
                      { value: subjectMaxAmountIn },
                    );
                    const gasCost = gasFee.mul(result.gasPrice);

                    inputSpent = inputSpent.sub(gasCost);
                  }
                  const quotedInputAmount = await subjectQuote();
                  expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.96)));
                  expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.04)));
                });
              },
            );

            describe(
              inputTokenName == "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                let swapDataCollateralToDebt: SwapData;
                let swapDataOutputToken: SwapData;

                let outputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMinAmountOut: BigNumber;
                let subjectOutputToken: Address;

                async function subject() {
                  if (inputTokenName == "ETH") {
                    return exchangeIssuance.redeemExactSetForETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectMinAmountOut,
                      swapDataCollateralToDebt,
                      swapDataOutputToken,
                    );
                  }
                  return exchangeIssuance.redeemExactSetForERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectOutputToken,
                    subjectMinAmountOut,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                  );
                }

                async function subjectQuote(): Promise<BigNumber> {
                  return exchangeIssuance.callStatic.getRedeemExactSet(
                    subjectSetToken,
                    subjectSetAmount,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                  );
                }

                beforeEach(async () => {
                  const inputTokenMapping: { [key: string]: StandardTokenMock | WETH9 | IWETH } = {
                    CollateralToken: collateralToken,
                    ETH: weth,
                    ERC20: uSDC,
                  };
                  outputToken = inputTokenMapping[inputTokenName];
                  subjectOutputToken =
                    inputTokenName == "ETH"
                      ? addresses.dexes.curve.ethAddress
                      : outputToken.address;

                  subjectMinAmountOut = ZERO;
                  if (inputTokenName == "CollateralToken") {
                    await weth.deposit({ value: amountIn });
                    await weth.approve(exchangeIssuance.address, MAX_UINT_256);
                  } else if (inputTokenName == "ERC20") {
                    await outputToken.approve(exchangeIssuance.address, MAX_UINT_256);
                  }
                  subjectSetToken = setToken.address;

                  swapDataCollateralToDebt = {
                    path: [collateralTokenAddress, uSDC.address],
                    fees: [3000],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.Quickswap,
                  };

                  swapDataOutputToken = {
                    path: [collateralTokenAddress, outputToken.address],
                    fees: [3000],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.Quickswap,
                  };
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
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  await subject();
                  const outputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  expect(outputObtained.gte(subjectMinAmountOut)).to.be.true;
                });

                it("should quote the correct output amount", async () => {
                  let gasCount = BigNumber.from(0);
                  let gasCost: BigNumber;
                  let outputObtained: BigNumber;
                  const outputBalanceBefore =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  if (inputTokenName == "ETH") {
                    gasCount = await exchangeIssuance.estimateGas.redeemExactSetForETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectMinAmountOut,
                      swapDataCollateralToDebt,
                      swapDataOutputToken,
                    );
                  }
                  const result = await subject();
                  const outputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  gasCount = preciseMul(gasCount, ether(0.9));
                  gasCost = gasCount.mul(result.gasPrice);
                  outputObtained = outputObtained.add(gasCost);
                  const outputAmountQuote = await subjectQuote();
                  expect(outputAmountQuote).to.gt(preciseMul(outputObtained, ether(0.97)));
                  expect(outputAmountQuote).to.lt(preciseMul(outputObtained, ether(1.03)));
                });
              },
            );
          });
        });
      });
    });
  });
}
