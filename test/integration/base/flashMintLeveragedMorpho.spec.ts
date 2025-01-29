import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, BytesLike, utils } from "ethers";
import { FlashMintLeveragedMorpho } from "../../../typechain";
import { IWETH, StandardTokenMock, IERC20 } from "../../../typechain";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
  Curve,
  BalancerV2,
  Aerodrome,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  poolIds: BytesLike[];
  exchange: Exchange;
};

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintLeveragedMorpho - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let wsteth: IERC20;
    const wethAddress = "0x4200000000000000000000000000000000000006";
    const wstethAddress = "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452";
    const wsteth15xAddress = "0xc8DF827157AdAf693FCb0c6f305610C28De739FD";
    const debtIssuanceModuleAddress = "0xa30E87311407dDcF1741901A8F359b6005252F22";
    const controllerAddress = "0x1246553a53Cd2897EB26beE87a0dB0Fb456F39d1";
    const morphoLeverageModuleAddress = "0x9534b6EC541aD182FBEE2B0B01D1e4404765b8d7";
    const aerodromeRouterAddress = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
    const aerodromeFactoryAdddress = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
    const wstethWhale = "0x31b7538090C8584FED3a053FD183E202c26f9a3e";
    const balancerV2VaultAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    setBlockNumber(25678000, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        wsteth15xAddress,
      )) as StandardTokenMock;

      wsteth = (await ethers.getContractAt("IERC20", wstethAddress)) as IERC20;
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveragedMorpho;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedMorpho(
          wethAddress,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
          controllerAddress,
          debtIssuanceModuleAddress,
          morphoLeverageModuleAddress,
          ADDRESS_ZERO,
          ADDRESS_ZERO, // TODO: Check if there is curve calculator deployed on arbi
          balancerV2VaultAddress,
          aerodromeRouterAddress,
          aerodromeFactoryAdddress,
        );

        await flashMintLeveraged.connect(owner.wallet).approveSetToken(wsteth15xAddress);
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(wethAddress));
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

          const leveragedTokenData = await flashMintLeveraged.getLeveragedTokenData(
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
            before(async () => {
              subjectSetAmount = ether(0.5);

                amountIn = subjectSetAmount.mul(12).div(10);
                wsteth
                  .connect(await impersonateAccount(wstethWhale))
                  .transfer(owner.address, amountIn);
            });

            describe(
              inputTokenName === "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;

                let inputToken: StandardTokenMock | IWETH | IERC20;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;
                let setBalancebefore: BigNumber;
                let inputBalanceBefore: BigNumber;
                let quotedInputAmount: BigNumber;

                before(async () => {
                  swapDataDebtToCollateral = {
                    path: [wethAddress, wstethAddress],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    poolIds: [],
                    exchange: Exchange.Aerodrome,
                  };

                  swapDataInputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,

                    poolIds: [],
                    exchange: Exchange.None,
                  };

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
                  quotedInputAmount = await subjectQuote();
                  await subject();
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
                    subjectMaxAmountIn,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                  );
                }

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
                let swapDataCollateralToDebt: SwapData;
                let swapDataOutputToken: SwapData;

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

                async function subjectQuote(): Promise<BigNumber> {
                  return flashMintLeveraged.callStatic.getRedeemExactSet(
                    subjectSetToken,
                    subjectSetAmount,
                    swapDataCollateralToDebt,
                    swapDataOutputToken,
                  );
                }

                before(async () => {
                  swapDataCollateralToDebt = {
                    path: [collateralTokenAddress, wethAddress],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    poolIds: [],
                    exchange: Exchange.Aerodrome,
                  };
                  swapDataOutputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    poolIds: [],
                    exchange: Exchange.None,
                  };

                  if (inputTokenName === "collateralToken") {
                    outputToken = wsteth;
                  }

                  subjectMinAmountOut = subjectSetAmount.mul(8).div(10);
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
                  outputAmountQuote = await subjectQuote();
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

                  expect(outputAmountQuote).to.gt(preciseMul(outputObtained, ether(0.93)));
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
