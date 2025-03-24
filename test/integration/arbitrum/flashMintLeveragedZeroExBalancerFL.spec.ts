import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { impersonateAccount, setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, BytesLike, utils } from "ethers";
import {
  AaveV3LeverageModule,
  FlashMintLeveragedZeroExBalancerFL,
  IDebtIssuanceModule,
} from "../../../typechain";
import { IWETH, StandardTokenMock, IERC20 } from "../../../typechain";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { fetchZeroExData } from "../../../scripts/cache0xApiResponse";
import PRODUCTION_ADDRESS, { PRODUCTION_ADDRESSES } from "./addresses";

const expect = getWaffleExpect();
type SwapData = { swapTarget: string; callData: BytesLike };

const NOOP_SWAPDATA = {
  swapTarget: ethers.constants.AddressZero,
  callData: ethers.constants.HashZero,
};

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintLeveragedZeroExBalancerFLBalancerFL - Integration Test", async () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: StandardTokenMock;
    let weth: IWETH;
    const wethAddress = PRODUCTION_ADDRESS.tokens.weth;
    const eth2XAddress = PRODUCTION_ADDRESS.tokens.ETH2X;
    const debtIssuanceModuleAddress = PRODUCTION_ADDRESSES.setFork.debtIssuanceModuleV3;
    const controllerAddress = PRODUCTION_ADDRESSES.setFork.controller;
    const morphoLeverageModuleAddress = ADDRESS_ZERO;
    const aaveLeverageModuleAddress = PRODUCTION_ADDRESSES.setFork.aaveV3LeverageModule;
    const wethWhale = "0xC3E5607Cd4ca0D5Fe51e09B60Ed97a0Ae6F874dd";
    const balancerVaultAddress = PRODUCTION_ADDRESSES.dexes.balancerv2.vault;
    const zeroExRouterAddress = "0x0000000000001fF3684f28c67538d4D072C22734";
    const aaveV3PoolAddress = PRODUCTION_ADDRESSES.lending.aaveV3.lendingPool;
    const forkBlockNumber = 318923600;
    const blockRange = 100;
    const chainId = 42161;
    const isAave = true;

    setBlockNumber(forkBlockNumber, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        eth2XAddress,
      )) as StandardTokenMock;

      weth = (await ethers.getContractAt("IWETH", wethAddress)) as IWETH;
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveragedZeroExBalancerFL;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedZeroExBalancerFL(
          controllerAddress,
          debtIssuanceModuleAddress,
          morphoLeverageModuleAddress,
          aaveLeverageModuleAddress,
          balancerVaultAddress,
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
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          await flashMintLeveraged.approveSetToken(setToken.address, isAave);

          const debtIssuanceModule = (await ethers.getContractAt(
            "IDebtIssuanceModule",
            PRODUCTION_ADDRESSES.setFork.debtIssuanceModuleV3,
            owner.wallet,
          )) as IDebtIssuanceModule;

          const aaveLeverageModule = (await ethers.getContractAt(
            "IAaveV3LeverageModule",
            PRODUCTION_ADDRESSES.setFork.aaveV3LeverageModule,
            owner.wallet,
          )) as AaveV3LeverageModule;
          await aaveLeverageModule.sync(eth2XAddress);

          const [components, equityPositions, debtPositions] =
            await debtIssuanceModule.getRequiredComponentIssuanceUnits(eth2XAddress, ether(1));
          console.log({ components, equityPositions, debtPositions });

          const leveragedTokenData = await flashMintLeveraged.callStatic.getLeveragedTokenData(
            eth2XAddress,
            ether(1),
            true,
            isAave,
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

        it("should adjust collateral atoken allowance correctly", async () => {
          expect(
            await collateralAToken.allowance(flashMintLeveraged.address, debtIssuanceModuleAddress),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(flashMintLeveraged.address, debtIssuanceModuleAddress),
          ).to.equal(MAX_UINT_256);
        });

        [
          "collateralToken",
          // ,"ETH"
        ].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let amountIn: BigNumber;
            let subjectSetAmount: BigNumber;
            const slippageTolerancePercentIssue = 0;
            let gasCosts: BigNumber;
            // Note: This difference is likely due to eth2X not being at 1 eth nav anymore
            // TODO: verify
            // const slippageTolerancePercentRedeem = 30;
            before(async () => {
              subjectSetAmount = ether(0.1);

              amountIn = subjectSetAmount.mul(100 + slippageTolerancePercentIssue).div(100);
              await weth
                .connect(await impersonateAccount(wethWhale))
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
                    inputToken = weth;
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
                  const roundingFactor = leveragedTokenData.debtAmount.div(10000);
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
                  console.log("zeroExResponse", zeroExResponse);
                  swapDataDebtToCollateral = {
                    swapTarget: zeroExResponse.transaction.to,
                    callData: zeroExResponse.transaction.data,
                  };

                  if (inputTokenName === "ETH") {
                    const zeroExResponse = await fetchZeroExData(
                      weth.address,
                      leveragedTokenData.collateralToken,
                      // Swap full input amount into collateral
                      // Note: Means the user will get no eth back but instead the excess weth
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
                let swapDataCollateralToDebt: SwapData;
                const swapDataOutputToken: SwapData = NOOP_SWAPDATA;

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

                  // TODO: Adjust after having switched to fixed output swap
                  subjectMinAmountOut = ether(0);
                  // subjectMinAmountOut = subjectSetAmount
                  //   .mul(100)
                  //   .div(100 + slippageTolerancePercentRedeem);
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
                  const roundingFactor = leveragedTokenData.collateralAmount.div(10000);
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
