import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/index";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { ExchangeIssuanceLeveraged } from "@utils/contracts/index";
import {
  ICurveAddressProvider,
  ICurveRegistryExchange,
  IWETH,
  StandardTokenMock,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
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
  describe("ExchangeIssuanceLeveraged - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let stEth: StandardTokenMock;
    let setToken: StandardTokenMock;
    let weth: IWETH;

    // const collateralTokenAddress = addresses.tokens.stEth;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      stEth = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.stEth,
      )) as StandardTokenMock;

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.icEth,
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
      let exchangeIssuance: ExchangeIssuanceLeveraged;
      before(async () => {
        exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.set.controller,
          addresses.set.debtIssuanceModuleV2,
          addresses.set.aaveLeverageModule,
          addresses.lending.aave.addressProvider,
          addresses.dexes.curve.addressProvider,
          addresses.dexes.curve.calculator,
        );
      });

      it("weth address is set correctly", async () => {
        expect(await exchangeIssuance.WETH()).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        expect(await exchangeIssuance.sushiRouter()).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        // TODO: Review / Fix misleading name quick vs. uniV2
        expect(await exchangeIssuance.quickRouter()).to.eq(
          utils.getAddress(addresses.dexes.uniV2.router),
        );
      });

      it("uniV3 router address is set correctly", async () => {
        expect(await exchangeIssuance.uniV3Router()).to.eq(
          utils.getAddress(addresses.dexes.uniV3.router),
        );
      });

      it("controller address is set correctly", async () => {
        expect(await exchangeIssuance.setController()).to.eq(
          utils.getAddress(addresses.set.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await exchangeIssuance.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.set.debtIssuanceModuleV2),
        );
      });

      describe("When setToken is approved", () => {
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let collateralTokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          await exchangeIssuance.approveSetToken(setToken.address);

          const leveragedTokenData = await exchangeIssuance.getLeveragedTokenData(
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
              exchangeIssuance.address,
              addresses.set.debtIssuanceModuleV2,
            ),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(exchangeIssuance.address, addresses.set.debtIssuanceModuleV2),
          ).to.equal(MAX_UINT_256);
        });

        ["collateralToken", "WETH"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let subjectSetAmount: BigNumber;
            let amountIn: BigNumber;
            beforeEach(async () => {
              amountIn = ether(2);
              subjectSetAmount = ether(1.234567891011121314);
            });
            describe("#issueExactSetFromERC20", () => {
              let swapDataDebtToCollateral: SwapData;
              let swapDataInputToken: SwapData;

              let inputToken: StandardTokenMock | IWETH;

              let subjectSetToken: Address;
              let subjectMaxAmountIn: BigNumber;
              let subjectInputToken: Address;

              let curveRegistryExchange: ICurveRegistryExchange;
              beforeEach(async () => {
                const addressProvider = (await ethers.getContractAt(
                  "ICurveAddressProvider",
                  addresses.dexes.curve.addressProvider,
                )) as ICurveAddressProvider;
                curveRegistryExchange = (await ethers.getContractAt(
                  "ICurveRegistryExchange",
                  await addressProvider.get_address(2),
                )) as ICurveRegistryExchange;

                swapDataDebtToCollateral = {
                  path: [addresses.dexes.curve.ethAddress, collateralTokenAddress],
                  fees: [],
                  pool: addresses.dexes.curve.pools.stEthEth,
                  exchange: Exchange.Curve,
                };

                if (inputTokenName == "collateralToken") {
                  inputToken = stEth;
                  swapDataInputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };

                  const minAmountOut = amountIn.div(2);

                  await curveRegistryExchange.exchange(
                    addresses.dexes.curve.pools.stEthEth,
                    addresses.dexes.curve.ethAddress,
                    addresses.tokens.stEth,
                    amountIn,
                    minAmountOut,
                    { value: amountIn },
                  );
                } else {
                  inputToken = weth;
                  swapDataInputToken = {
                    path: [addresses.dexes.curve.ethAddress, addresses.tokens.stEth],
                    fees: [],
                    pool: addresses.dexes.curve.pools.stEthEth,
                    exchange: Exchange.Curve,
                  };

                  await weth.deposit({ value: amountIn });
                }

                const inputTokenBalance = await inputToken.balanceOf(owner.address);
                subjectMaxAmountIn = inputTokenBalance;
                subjectInputToken = inputToken.address;
                subjectSetToken = setToken.address;

                await inputToken.approve(exchangeIssuance.address, subjectMaxAmountIn);
              });

              async function subject() {
                return exchangeIssuance.issueExactSetFromERC20(
                  subjectSetToken,
                  subjectSetAmount,
                  subjectInputToken,
                  subjectMaxAmountIn,
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
                const inputBalanceBefore = await inputToken.balanceOf(owner.address);
                await subject();
                const inputBalanceAfter = await inputToken.balanceOf(owner.address);
                const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                expect(inputSpent.gt(0)).to.be.true;
                expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
              });
            });

            describe("#redeemExactSetForERC20", () => {
              let swapDataCollateralToDebt: SwapData;
              let swapDataOutputToken: SwapData;

              let outputToken: StandardTokenMock | IWETH;

              let subjectSetToken: Address;
              let subjectMinAmountOut: BigNumber;
              let subjectOutputToken: Address;

              async function subject() {
                return exchangeIssuance.redeemExactSetForERC20(
                  subjectSetToken,
                  subjectSetAmount,
                  subjectOutputToken,
                  subjectMinAmountOut,
                  swapDataCollateralToDebt,
                  swapDataOutputToken,
                );
              }

              beforeEach(async () => {
                swapDataCollateralToDebt = {
                  path: [collateralTokenAddress, addresses.dexes.curve.ethAddress],
                  fees: [],
                  pool: addresses.dexes.curve.pools.stEthEth,
                  exchange: Exchange.Curve,
                };

                if (inputTokenName == "collateralToken") {
                  outputToken = stEth;
                  swapDataOutputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };
                } else {
                  outputToken = weth;
                  swapDataOutputToken = {
                    path: [addresses.tokens.stEth, addresses.dexes.curve.ethAddress],
                    fees: [],
                    pool: addresses.dexes.curve.pools.stEthEth,
                    exchange: Exchange.Curve,
                  };

                  await weth.deposit({ value: amountIn });
                }

                subjectMinAmountOut = subjectSetAmount.div(2);
                subjectOutputToken = outputToken.address;
                subjectSetToken = setToken.address;

                await setToken.approve(exchangeIssuance.address, subjectSetAmount);
              });

              it("should redeem the correct amount of tokens", async () => {
                const setBalanceBefore = await setToken.balanceOf(owner.address);
                await subject();
                const setBalanceAfter = await setToken.balanceOf(owner.address);
                const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
                expect(setRedeemed).to.eq(subjectSetAmount);
              });

              it("should return at least the specified minimum of output tokens", async () => {
                const outputBalanceBefore = await outputToken.balanceOf(owner.address);
                await subject();
                const outputBalanceAfter = await outputToken.balanceOf(owner.address);
                const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                expect(outputObtained.gte(subjectMinAmountOut)).to.be.true;
              });
            });
          });
        });
      });
    });
  });
}
