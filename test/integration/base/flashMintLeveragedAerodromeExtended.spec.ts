import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, BytesLike, utils } from "ethers";
import { FlashMintLeveragedAerodrome } from "../../../typechain";
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
  describe("FlashMintLeveragedAerodrome - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let cbbtc: IERC20;
    const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const wethAddress = "0x4200000000000000000000000000000000000006";
    const cbbtcAddress = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
    const btc3XAddress = "0x1F4609133b6dAcc88f2fa85c2d26635554685699";
    const debtIssuanceModuleAddress = "0xa30E87311407dDcF1741901A8F359b6005252F22";
    const controllerAddress = "0x1246553a53Cd2897EB26beE87a0dB0Fb456F39d1";
    const lendingPoolAddress = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
    const aaveV3LeverageModuleAddress = "0xC06a6E4d9D5FF9d64BD19fc243aD9B6E5a672699";
    const aerodromeRouterAddress = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
    const aerodromeFactoryAdddress = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
    const cbbtcWhale = "0x40EbC1Ac8d4Fedd2E144b75fe9C0420BE82750c6";
    const balancerV2VaultAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

    setBlockNumber(24770000, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        btc3XAddress,
      )) as StandardTokenMock;

      cbbtc = (await ethers.getContractAt("IERC20", cbbtcAddress)) as IERC20;
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveragedAerodrome;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedAerodrome(
          wethAddress,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
          controllerAddress,
          debtIssuanceModuleAddress,
          aaveV3LeverageModuleAddress,
          lendingPoolAddress,
          ADDRESS_ZERO,
          ADDRESS_ZERO, // TODO: Check if there is curve calculator deployed on arbi
          balancerV2VaultAddress,
          aerodromeRouterAddress,
          aerodromeFactoryAdddress,
        );

        await flashMintLeveraged.connect(owner.wallet).approveSetToken(btc3XAddress);
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
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let collateralTokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          await flashMintLeveraged.approveSetToken(setToken.address);

          const leveragedTokenData = await flashMintLeveraged.getLeveragedTokenData(
            btc3XAddress,
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
            await collateralAToken.allowance(flashMintLeveraged.address, debtIssuanceModuleAddress),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(flashMintLeveraged.address, debtIssuanceModuleAddress),
          ).to.equal(MAX_UINT_256);
        });

        ["collateralToken"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let amountIn: BigNumber;
            before(async () => {
              amountIn = ether(0.4);
              if (inputTokenName === "collateralToken") {
                amountIn = utils.parseUnits("0.1", 8);
                cbbtc
                  .connect(await impersonateAccount(cbbtcWhale))
                  .transfer(owner.address, utils.parseUnits("0.1", 8));
              }
            });

            describe(
              inputTokenName === "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let subjectSetAmount: BigNumber;
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
                  subjectSetAmount = ether(1);
                  swapDataDebtToCollateral = {
                    path: [usdcAddress, cbbtcAddress],
                    fees: [500],
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
                    inputToken = cbbtc;
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
                  expect(inputSpent).to.be.gt(0);
                  expect(inputSpent).to.be.lte(subjectMaxAmountIn);
                });

                it("should quote the correct input amount", async () => {
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
              inputTokenName === "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                let swapDataCollateralToDebt: SwapData;
                let swapDataOutputToken: SwapData;

                let outputToken: IERC20 | IWETH;

                let subjectSetToken: Address;
                let subjectSetAmount: BigNumber;
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
                  subjectSetAmount = ether(1);
                  swapDataCollateralToDebt = {
                    path: [collateralTokenAddress, usdcAddress],
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
                    outputToken = cbbtc;
                  }

                  subjectMinAmountOut =
                    inputTokenName === "collateralToken"
                      ? utils.parseUnits("0.009", 8)
                      : ether(0.25);
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
                  expect(outputObtained.gte(subjectMinAmountOut)).to.be.true;
                });

                it("should quote the correct output amount", async () => {
                  const outputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);

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
