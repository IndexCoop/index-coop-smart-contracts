import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, BytesLike, utils } from "ethers";
import { FlashMintLeveragedZeroEx } from "../../../typechain";
import { IWETH, StandardTokenMock, IERC20 } from "../../../typechain";
import { MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { fetchZeroExData } from "../../../scripts/cache0xApiResponse";

const expect = getWaffleExpect();
type SwapData = { swapTarget: string; callData: BytesLike };

const NOOP_SWAPDATA = {
  swapTarget: ethers.constants.AddressZero,
  callData: ethers.constants.HashZero,
};

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintLeveragedZeroEx - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let wsteth: IERC20;
    let weth: IWETH;
    const wethAddress = "0x4200000000000000000000000000000000000006";
    const wstethAddress = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
    const wsteth15xAddress = "0xc8DF827157AdAf693FCb0c6f305610C28De739FD";
    const debtIssuanceModuleAddress = "0xa30E87311407dDcF1741901A8F359b6005252F22";
    const controllerAddress = "0x1246553a53Cd2897EB26beE87a0dB0Fb456F39d1";
    const morphoLeverageModuleAddress = "0x9534b6EC541aD182FBEE2B0B01D1e4404765b8d7";
    const aaveLeverageModuleAddress = "0xC06a6E4d9D5FF9d64BD19fc243aD9B6E5a672699";
    const wstethWhale = "0x31b7538090C8584FED3a053FD183E202c26f9a3e";
    const morphoAddress = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
    const zeroExRouterAddress = "0x0000000000001fF3684f28c67538d4D072C22734";
    const aaveV3PoolAddress = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
    const forkBlockNumber = 27222056;
    const blockRange = 100;
    const chainId = 8453;
    const isAave = false;

    setBlockNumber(forkBlockNumber, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        wsteth15xAddress,
      )) as StandardTokenMock;

      wsteth = (await ethers.getContractAt("IERC20", wstethAddress)) as IERC20;
      weth = (await ethers.getContractAt("IWETH", wethAddress)) as IWETH;
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveragedZeroEx;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedZeroEx(
          controllerAddress,
          debtIssuanceModuleAddress,
          morphoLeverageModuleAddress,
          aaveLeverageModuleAddress,
          morphoAddress,
          aaveV3PoolAddress,
          wethAddress,
          zeroExRouterAddress,
        );

      });

      it("controller address is set correctly", async () => {
        expect(await flashMintLeveraged.setController()).to.eq(controllerAddress);
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintLeveraged.debtIssuanceModule()).to.eq(
          utils.getAddress(debtIssuanceModuleAddress),
        );
      });

      describe("When setToken is approved", () => {
        let collateralToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralTokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          await flashMintLeveraged.approveSetToken(setToken.address, isAave);

          const leveragedTokenData = await flashMintLeveraged.callStatic.getLeveragedTokenData(
            wsteth15xAddress,
            ether(1),
            true,
            isAave,
          );

          collateralTokenAddress = leveragedTokenData.collateralToken;
          debtTokenAddress = leveragedTokenData.debtToken;

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
            await collateralToken.allowance(flashMintLeveraged.address, debtIssuanceModuleAddress),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(flashMintLeveraged.address, debtIssuanceModuleAddress),
          ).to.equal(MAX_UINT_256);
        });

        ["collateralToken", "ETH"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let amountIn: BigNumber;
            let subjectSetAmount: BigNumber;
            const slippageTolerancePercentIssue = 0;
            let gasCosts: BigNumber;
            // Note: This difference is likely due to wsteth15x not being at 1 eth nav anymore
            // TODO: verify
            const slippageTolerancePercentRedeem = 30;
            before(async () => {
              subjectSetAmount = ether(0.1);

              amountIn = subjectSetAmount.mul(100 + slippageTolerancePercentIssue).div(100);
              await wsteth
                .connect(await impersonateAccount(wstethWhale))
                .transfer(owner.address, amountIn);
            });

            describe(
              inputTokenName === "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let swapDataDebtToCollateral: SwapData = NOOP_SWAPDATA;
                let swapDataInputToken: SwapData = NOOP_SWAPDATA;

                let inputToken: StandardTokenMock | IWETH | IERC20;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;
                let setBalancebefore: BigNumber;
                let inputBalanceBefore: BigNumber;
                // let quotedInputAmount: BigNumber;

                before(async () => {
                  if (inputTokenName === "collateralToken") {
                    inputToken = wsteth;
                  }

                  if (inputTokenName === "ETH") {
                    subjectMaxAmountIn = amountIn;
                  } else {
                    subjectMaxAmountIn = amountIn;
                    await inputToken.approve(flashMintLeveraged.address, subjectMaxAmountIn);
                    subjectInputToken = inputToken.address;
                  }
                  subjectSetToken = setToken.address;
                  setBalancebefore = await setToken.balanceOf(owner.address);
                  inputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  // quotedInputAmount = await subjectQuote();
                  const leveragedTokenData =
                    await flashMintLeveraged.callStatic.getLeveragedTokenData(
                      subjectSetToken,
                      subjectSetAmount,
                      true,
                      isAave,
                    );

                  // Round up to this number of wei;
                  const roundingFactor = ethers.utils.parseEther("0.01");
                  const roundedDebtAmount = leveragedTokenData.debtAmount
                    .div(roundingFactor)
                    .add(1)
                    .mul(roundingFactor);
                  const zeroExResponse = await fetchZeroExData(
                    leveragedTokenData.debtToken,
                    leveragedTokenData.collateralToken,
                    roundedDebtAmount,
                    blockRange,
                    flashMintLeveraged.address,
                    true,
                    forkBlockNumber,
                    chainId,
                  );
                  swapDataDebtToCollateral = {
                    swapTarget: zeroExResponse.transaction.to,
                    callData: zeroExResponse.transaction.data,
                  };

                  if (inputTokenName === "ETH") {
                    const zeroExResponse = await fetchZeroExData(
                      weth.address,
                      leveragedTokenData.collateralToken,
                      // Swap full input amount into collateral
                      // Note: Means the user will get no eth back but instead the excess wsteth
                      subjectMaxAmountIn,
                      blockRange,
                      flashMintLeveraged.address,
                      true,
                      forkBlockNumber,
                      chainId,
                    );
                    swapDataInputToken = {
                      swapTarget: zeroExResponse.transaction.to,
                      callData: zeroExResponse.transaction.data,
                    };
                  }

                  const tx = await subject();
                  // console.log("tx", tx);
                  const receipt = await tx.wait();
                  // console.log("receipt", receipt);
                  gasCosts = receipt.gasUsed.mul(tx.gasPrice);
                });

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
                      isAave,
                      { value: subjectMaxAmountIn, gasLimit: 3_000_000 },
                    );
                  }
                  return flashMintLeveraged.issueExactSetFromERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectInputToken,
                    subjectMaxAmountIn,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                    isAave,
                    { gasLimit: 3_000_000 },
                  );
                }

                // async function subjectQuote() {
                //   return flashMintLeveraged.callStatic.getIssueExactSet(
                //     subjectSetToken,
                //     subjectSetAmount,
                //     subjectMaxAmountIn,
                //     swapDataDebtToCollateral,
                //     swapDataInputToken,
                //   );
                // }

                it("should issue the correct amount of tokens", async () => {
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setObtained = setBalanceAfter.sub(setBalancebefore);
                  expect(setObtained).to.eq(subjectSetAmount);
                });

                it("should spend less than specified max amount", async () => {
                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  let inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  if (inputTokenName === "ETH") {
                    inputSpent = inputSpent.sub(gasCosts);
                  }
                  expect(inputSpent).to.be.gt(0);
                  expect(inputSpent).to.be.lte(subjectMaxAmountIn);
                });

                it.skip("should quote the correct input amount", async () => {
                  // const inputBalanceAfter =
                  //   inputTokenName === "ETH"
                  //     ? await owner.wallet.getBalance()
                  //     : await inputToken.balanceOf(owner.address);
                  // const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  // expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.98)));
                  // expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.02)));
                });
              },
            );

            describe(
              inputTokenName === "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                let swapDataCollateralToDebt: BytesLike;
                const swapDataOutputToken: BytesLike = NOOP_SWAPDATA;

                let outputToken: IERC20 | IWETH;

                let subjectSetToken: Address;
                let subjectMinAmountOut: BigNumber;
                let subjectOutputToken: Address;
                let setBalanceBefore: BigNumber;
                let outputBalanceBefore: BigNumber;
                // let outputAmountQuote: BigNumber;

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.redeemExactSetForETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectMinAmountOut,
                      swapDataCollateralToDebt,
                      swapDataOutputToken,
                      isAave,
                    );
                  }
                  return flashMintLeveraged.redeemExactSetForERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectOutputToken,
                    subjectMinAmountOut,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                    isAave,
                  );
                }

                // async function subjectQuote(): Promise<BigNumber> {
                //   return flashMintLeveraged.callStatic.getRedeemExactSet(
                //     subjectSetToken,
                //     subjectSetAmount,
                //     swapDataCollateralToDebt,
                //     swapDataOutputToken,
                //   );
                // }

                before(async () => {
                  if (inputTokenName === "collateralToken") {
                    // NOTE: We are actually using debt instead of collateral token as output here
                    // This way we can just sell the entire contract balance in collateral tokens to debt token
                    outputToken = weth;
                  }

                  subjectMinAmountOut = subjectSetAmount
                    .mul(100)
                    .div(100 + slippageTolerancePercentRedeem);
                  subjectSetToken = setToken.address;
                  await setToken.approve(flashMintLeveraged.address, subjectSetAmount);

                  if (inputTokenName !== "ETH") {
                    subjectOutputToken = outputToken.address;
                  }
                  setBalanceBefore = await setToken.balanceOf(owner.address);
                  outputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  // outputAmountQuote = await subjectQuote();
                  //
                  const leveragedTokenData =
                    await flashMintLeveraged.callStatic.getLeveragedTokenData(
                      subjectSetToken,
                      subjectSetAmount,
                      true,
                      isAave,
                    );
                  // Round up to this number of wei;
                  const roundingFactor = ethers.utils.parseEther("0.01");
                  const roundedCollateralAmount = leveragedTokenData.collateralAmount
                    .div(roundingFactor)
                    .add(1)
                    .mul(roundingFactor);
                  const zeroExResponse = await fetchZeroExData(
                    leveragedTokenData.collateralToken,
                    leveragedTokenData.debtToken,
                    roundedCollateralAmount,
                    blockRange,
                    flashMintLeveraged.address,
                    true,
                    forkBlockNumber,
                    chainId,
                  );

                  swapDataCollateralToDebt = {
                    swapTarget: zeroExResponse.transaction.to,
                    callData: zeroExResponse.transaction.data,
                  };

                  // if (inputTokenName === "ETH") {
                  //   const expectedReceivedAmount = BigNumber.from(zeroExResponse.buyAmount);
                  //   console.log("expectedReceivedAmount", expectedReceivedAmount.toString());
                  //   const expectedDebtAmountToSellToOutput = expectedReceivedAmount.sub(
                  //     leveragedTokenData.debtAmount,
                  //   );
                  //   console.log(
                  //     "expectedDebtAmountToSellToOutput",
                  //     expectedDebtAmountToSellToOutput.toString(),
                  //   );
                  //   const roundedDebtAmountToSell = expectedDebtAmountToSellToOutput
                  //     .div(roundingFactor)
                  //     .add(1)
                  //     .mul(roundingFactor);

                  //   const zeroExResponseSellDebt = await fetchZeroExData(
                  //     leveragedTokenData.debtToken,
                  //     leveragedTokenData.collateralToken,
                  //     roundedCollateralAmount,
                  //     blockRange,
                  //     flashMintLeveraged.address,
                  //     true,
                  //     forkBlockNumber,
                  //     chainId,
                  //   );
                  // }

                  const tx = await subject();
                  // console.log("tx", tx);
                  const receipt = await tx.wait();
                  // console.log("receipt", receipt);
                  gasCosts = receipt.gasUsed.mul(tx.gasPrice);
                });

                it("should redeem the correct amount of tokens", async () => {
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
                  expect(setRedeemed).to.eq(subjectSetAmount);
                });

                it("should return at least the specified minimum of output tokens", async () => {
                  const outputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  let outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  if (inputTokenName === "ETH") {
                    outputObtained = outputObtained.add(gasCosts);
                  }
                  console.log("outputObtained", outputObtained.toString());
                  expect(outputObtained).to.be.gte(subjectMinAmountOut);
                });

                // TODO: Reactivate after reimplementing quote function
                it.skip("should quote the correct output amount", async () => {
                  // const outputBalanceAfter =
                  //   inputTokenName === "ETH"
                  //     ? await owner.wallet.getBalance()
                  //     : await outputToken.balanceOf(owner.address);
                  // const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  // expect(outputAmountQuote).to.gt(preciseMul(outputObtained, ether(0.5)));
                  // expect(outputAmountQuote).to.lt(preciseMul(outputObtained, ether(1.03)));
                });
              },
            );
          });
        });
      });
    });
  });
}
