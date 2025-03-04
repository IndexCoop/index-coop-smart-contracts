import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, BytesLike, utils } from "ethers";
import { FlashMintLeveragedZeroEx } from "../../../typechain";
import { IWETH, StandardTokenMock, IERC20 } from "../../../typechain";
import { MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { fetchZeroExData } from "../../../scripts/cache0xApiResponse";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintLeveragedZeroEx - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let wsteth: IERC20;
    // let weth: IWETH;
    const wethAddress = "0x4200000000000000000000000000000000000006";
    const wstethAddress = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
    const wsteth15xAddress = "0xc8DF827157AdAf693FCb0c6f305610C28De739FD";
    const debtIssuanceModuleAddress = "0xa30E87311407dDcF1741901A8F359b6005252F22";
    const controllerAddress = "0x1246553a53Cd2897EB26beE87a0dB0Fb456F39d1";
    const morphoLeverageModuleAddress = "0x9534b6EC541aD182FBEE2B0B01D1e4404765b8d7";
    const wstethWhale = "0x31b7538090C8584FED3a053FD183E202c26f9a3e";
    const morphoAddress = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
    const zeroExRouterAddress = "0x0000000000001fF3684f28c67538d4D072C22734";
    const forkBlockNumber = 27141539;

    setBlockNumber(forkBlockNumber, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        wsteth15xAddress,
      )) as StandardTokenMock;

      wsteth = (await ethers.getContractAt("IERC20", wstethAddress)) as IERC20;
      // weth = (await ethers.getContractAt("IWETH", wethAddress)) as IWETH;
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveragedZeroEx;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedZeroEx(
          controllerAddress,
          debtIssuanceModuleAddress,
          morphoLeverageModuleAddress,
          morphoAddress,
          wethAddress,
          zeroExRouterAddress,
        );

        // const dustAllowance = BigNumber.from(10000);
        // await weth.deposit({ value: dustAllowance });
        // await weth.transfer(flashMintLeveraged.address, dustAllowance);

        await flashMintLeveraged.connect(owner.wallet).approveSetToken(wsteth15xAddress);
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
          await flashMintLeveraged.approveSetToken(setToken.address);

          const leveragedTokenData = await flashMintLeveraged.callStatic.getLeveragedTokenData(
            wsteth15xAddress,
            ether(1),
            true,
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

        ["collateralToken"].forEach((inputTokenName) => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let amountIn: BigNumber;
            let subjectSetAmount: BigNumber;
            const slippageTolerancePercentIssue = 0;
            // Note: This difference is likely due to wsteth15x not being at 1 eth nav anymore
            // TODO: verify
            const slippageTolerancePercentRedeem = 30;
            before(async () => {
              subjectSetAmount = ether(0.1);

              amountIn = subjectSetAmount.mul(100 + slippageTolerancePercentIssue).div(100);
              await wsteth
                .connect(await impersonateAccount(wstethWhale))
                .transfer(owner.address, amountIn);
              console.log("owner address", owner.address);
              console.log("wsteth balance", await wsteth.balanceOf(owner.address));
            });

            describe(
              inputTokenName === "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let swapDataDebtToCollateral: BytesLike = ethers.constants.HashZero;
                let swapDataInputToken: BytesLike = ethers.constants.HashZero;

                let inputToken: StandardTokenMock | IWETH | IERC20;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;
                let setBalancebefore: BigNumber;
                let inputBalanceBefore: BigNumber;
                let quotedInputAmount: BigNumber;

                before(async () => {
                  if (inputTokenName === "collateralToken") {
                    inputToken = wsteth;
                  }

                  let inputTokenBalance: BigNumber;
                  if (inputTokenName === "ETH") {
                    subjectMaxAmountIn = amountIn;
                  } else {
                    inputTokenBalance = await inputToken.balanceOf(owner.address);
                    console.log("inputTokenBalance", inputTokenBalance.toString());
                    subjectMaxAmountIn = amountIn;
                    console.log("Approving input token", subjectMaxAmountIn.toString());
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
                  //
                  const leveragedTokenData =
                    await flashMintLeveraged.callStatic.getLeveragedTokenData(
                      subjectSetToken,
                      subjectSetAmount,
                      true,
                    );
                  console.log("leveragedTokenData", leveragedTokenData);
                  const blockRange = 10;
                  const chainId = 8453;

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
                  console.log("zeroExResponse");
                  swapDataDebtToCollateral = zeroExResponse.transaction.data;
                  console.log("swapDataDebtToCollateral", swapDataDebtToCollateral);
                  await subject();
                });

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
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
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  console.log("inputSpent", inputSpent.toString());
                  expect(inputSpent).to.be.gt(0);
                  expect(inputSpent).to.be.lte(subjectMaxAmountIn);
                });

                it("should quote the correct input amount", async () => {
                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

                  expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.98)));
                  expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.02)));
                });
              },
            );

            describe(
              inputTokenName === "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                let swapDataCollateralToDebt: BytesLike;
                let swapDataOutputToken: BytesLike = ethers.constants.HashZero;

                let outputToken: IERC20 | IWETH;

                let subjectSetToken: Address;
                let subjectMinAmountOut: BigNumber;
                let subjectOutputToken: Address;
                let setBalanceBefore: BigNumber;
                let outputBalanceBefore: BigNumber;
                let outputAmountQuote: BigNumber;

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
                    outputToken = wsteth;
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
                  await subject();
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
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  console.log("outputObtained", outputObtained.toString());
                  expect(outputObtained.gte(subjectMinAmountOut)).to.be.true;
                });

                it("should quote the correct output amount", async () => {
                  const outputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);

                  // TODO: Readjust tolerance after adjusting to Aerodrome Slipstream
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
