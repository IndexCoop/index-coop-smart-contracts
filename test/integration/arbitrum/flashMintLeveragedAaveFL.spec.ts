import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { cacheBeforeEach } from "@utils/test";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { FlashMintLeveragedAaveFL } from "@utils/contracts/index";
import { StandardTokenMock, IDebtIssuanceModule, IERC20__factory } from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { impersonateAccount, setBlockNumber, setBalance } from "@utils/test/testingUtils";

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
  describe.only("FlashMintLeveragedAaveFL - Integration Test", async () => {
    const addresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let setToken: StandardTokenMock;
    let aave: StandardTokenMock;

    setBlockNumber(387695000, false);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.aave2x,
      )) as StandardTokenMock;

      aave = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.aave,
      )) as StandardTokenMock;
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
      let flashMintLeveraged: FlashMintLeveragedAaveFL;
      before(async () => {
        console.log("addresses", addresses);
        console.log("args", [
          addresses.tokens.aave,
          ADDRESS_ZERO,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV3,
          addresses.setFork.aaveV3LeverageModule,
          addresses.lending.aaveV3.lendingPool,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
        ]);
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedAaveFL(
          addresses.tokens.aave,
          ADDRESS_ZERO,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV3,
          addresses.setFork.aaveV3LeverageModule,
          addresses.lending.aaveV3.addressProvider,
          ADDRESS_ZERO,
          ADDRESS_ZERO,
        );
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        console.log("returnedAddresses", returnedAddresses);
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
          utils.getAddress(addresses.setFork.debtIssuanceModuleV3),
        );
      });

      describe("When setToken is approved", () => {
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          const aaveWhale = "0x493Ff5E67aFf3CD847cF5C01039C77F341F71aCA";
          await setBalance(aaveWhale, ether(100));
          const aAaveWhale = "0xD5BB24152217BEA7A617525DDFA64ea3B41B9c0a";
          await setBalance(aAaveWhale, ether(100));

          const aaveWhaleSigner = await impersonateAccount(aaveWhale);
          const whaleAave = IERC20__factory.connect(addresses.tokens.aave, aaveWhaleSigner);
          await whaleAave.transfer(owner.address, ether(100));

          const aAaveWhaleSigner = await impersonateAccount(aAaveWhale);
          const whaleaAave = IERC20__factory.connect(addresses.tokens.aAave, aAaveWhaleSigner);
          const aAave = IERC20__factory.connect(addresses.tokens.aAave, owner.wallet);
          await whaleaAave.transfer(owner.address, ether(100));

          await aave.connect(owner.wallet).approve(flashMintLeveraged.address, ether(100));
          const debtIssuanceModule = (await ethers.getContractAt(
            "IDebtIssuanceModule",
            addresses.setFork.debtIssuanceModuleV3,
            owner.wallet,
          )) as IDebtIssuanceModule;
          await aAave.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));

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
              addresses.setFork.debtIssuanceModuleV3,
            ),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(
              flashMintLeveraged.address,
              addresses.setFork.debtIssuanceModuleV3,
            ),
          ).to.equal(MAX_UINT_256);
        });

        ["AAVE"].forEach(inputTokenName => {
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

                let inputToken: StandardTokenMock;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;

                beforeEach(async () => {
                  swapDataDebtToCollateral = {
                    path: [addresses.tokens.usdt, addresses.tokens.aave],
                    fees: [3000],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  swapDataInputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };

                  if (inputTokenName === "AAVE") {
                    inputToken = aave;
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

                let outputToken: StandardTokenMock;

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
                    path: [addresses.tokens.aave, addresses.tokens.usdt],
                    fees: [3000],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  if (inputTokenName === "AAVE") {
                    outputToken = aave;
                    swapDataOutputToken = {
                      path: [],
                      fees: [],
                      pool: ADDRESS_ZERO,
                      exchange: Exchange.None,
                    };
                    outputToken = aave;
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
