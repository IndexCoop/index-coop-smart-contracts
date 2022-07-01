import "module-alias/register";
import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";
import { Account, Address } from "@utils/types";
import {
  DebtIssuanceModule,
  ExchangeIssuanceNotional,
  NotionalTradeModuleMock,
  StandardTokenMock,
  WrappedfCashMock,
  WrappedfCashFactoryMock,
} from "@utils/contracts/index";
import { UniswapV2Router02 } from "@utils/contracts/uniswap";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/index";
import {
  getAccounts,
  getSetFixture,
  getCompoundFixture,
  getWaffleExpect,
  getUniswapFixture,
  getUniswapV3Fixture,
} from "@utils/index";
import { CompoundFixture, SetFixture, UniswapFixture, UniswapV3Fixture } from "@utils/fixtures";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { CERc20 } from "@utils/contracts/compound";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

const emptySwapData: SwapData = {
  path: [],
  fees: [],
  pool: ADDRESS_ZERO,
  exchange: Exchange.None,
};

describe("ExchangeIssuanceNotional", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let manager: Account;
  let setV2Setup: SetFixture;

  let quickswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let uniswapV3Setup: UniswapV3Fixture;

  let debtIssuanceModule: DebtIssuanceModule;

  let compoundSetup: CompoundFixture;
  let cTokenInitialMantissa: BigNumber;

  let wethAddress: Address;
  let wbtcAddress: Address;
  let daiAddress: Address;
  let quickswapRouter: UniswapV2Router02;
  let sushiswapRouter: UniswapV2Router02;
  let uniswapV3RouterAddress: Address;
  let uniswapV3QuoterAddress: Address;
  let curveCalculatorAddress: Address;
  let curveAddressProviderAddress: Address;

  before(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    debtIssuanceModule = setV2Setup.debtIssuanceModule;

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    cTokenInitialMantissa = ether(200000000);

    wethAddress = setV2Setup.weth.address;
    wbtcAddress = setV2Setup.wbtc.address;
    daiAddress = setV2Setup.dai.address;

    quickswapSetup = getUniswapFixture(owner.address);
    await quickswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    uniswapV3Setup = getUniswapV3Fixture(owner.address);
    await uniswapV3Setup.initialize(
      owner,
      setV2Setup.weth,
      3000,
      setV2Setup.wbtc,
      40000,
      setV2Setup.dai,
    );

    uniswapV3RouterAddress = uniswapV3Setup.swapRouter.address;
    await uniswapV3Setup.createNewPair(setV2Setup.weth, setV2Setup.usdc, 3000, 3000);

    await setV2Setup.weth.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
    await setV2Setup.usdc.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
    await uniswapV3Setup.addLiquidityWide(
      setV2Setup.weth,
      setV2Setup.usdc,
      3000,
      ether(100),
      usdc(300_000),
      owner.address,
    );

    quickswapRouter = quickswapSetup.router;
    sushiswapRouter = sushiswapSetup.router;
    curveCalculatorAddress = ADDRESS_ZERO;
    curveAddressProviderAddress = ADDRESS_ZERO;
    uniswapV3QuoterAddress = ADDRESS_ZERO;
  });

  describe("when general mocks are deployed", async () => {
    let wrappedfCashFactoryMock: WrappedfCashFactoryMock;
    let snapshotId: number;
    before(async () => {
      wrappedfCashFactoryMock = await deployer.mocks.deployWrappedfCashFactoryMock();
    });

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });


    ["dai", "weth"].forEach((underlyingTokenName) => {
      describe(`When underlying token is ${underlyingTokenName}`, () => {
        let assetToken: CERc20;
        let underlyingToken: StandardTokenMock;

        beforeEach(async () => {
          // @ts-ignore
          underlyingToken = setV2Setup[underlyingTokenName];
          assetToken = await compoundSetup.createAndEnableCToken(
            underlyingToken.address,
            cTokenInitialMantissa,
            compoundSetup.comptroller.address,
            compoundSetup.interestRateModel.address,
            "Compound UnderlyingToken",
            "cUNDERLYINGTOKEN",
            8,
            ether(0.75), // 75% collateral factor
            ether(1),
          );
          await underlyingToken.approve(assetToken.address, ethers.constants.MaxUint256);
          await assetToken.mint(ether(100));
        });

        describe("When wrappedFCashMocks are deployed", () => {
          let wrappedfCashMocks: Array<WrappedfCashMock>;
          let underlyingTokenBalance: BigNumber;
          let currencyId: number;
          let maturities: Array<number>;
          beforeEach(async () => {
            const underlyingAddress =
              underlyingToken.address == setV2Setup.weth.address
                ? ADDRESS_ZERO
                : underlyingToken.address;
            currencyId = 1;
            maturities = [30, 90];
            wrappedfCashMocks = [];

            for (const maturityDays of maturities) {
              const wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(
                assetToken.address,
                underlyingAddress,
                setV2Setup.weth.address,
              );

              const maturity =
                (await ethers.provider.getBlock("latest")).timestamp + maturityDays * 24 * 3600;

              await wrappedfCashMock.initialize(currencyId, maturity);

              await wrappedfCashFactoryMock.registerWrapper(
                currencyId,
                maturity,
                wrappedfCashMock.address,
              );

              underlyingTokenBalance = ether(100);
              await underlyingToken.transfer(owner.address, underlyingTokenBalance);
              await underlyingToken.approve(wrappedfCashMock.address, underlyingTokenBalance);

              await wrappedfCashMock.mintViaUnderlying(
                underlyingTokenBalance,
                underlyingTokenBalance,
                owner.address,
                0,
              );
              wrappedfCashMocks.push(wrappedfCashMock);
            }
          });
          describe("When setToken is deployed", () => {
            let fCashPosition: BigNumber;
            let underlyingPosition: BigNumber;
            let initialSetBalance: BigNumber;
            let setToken: SetToken;
            beforeEach(async () => {
              fCashPosition = ethers.utils.parseUnits("2", 9);
              underlyingPosition = ethers.utils.parseEther("1");

              setToken = await setV2Setup.createSetToken(
                [...wrappedfCashMocks.map((mock) => mock.address), underlyingToken.address],
                [...wrappedfCashMocks.map(() => fCashPosition), underlyingPosition],
                [debtIssuanceModule.address],
                manager.address,
              );

              expect(await setToken.isPendingModule(debtIssuanceModule.address)).to.be.true;

              // Initialize debIssuance module
              await debtIssuanceModule.connect(manager.wallet).initialize(
                setToken.address,
                ether(0.1),
                ether(0), // No issue fee
                ether(0), // No redeem fee
                owner.address,
                ADDRESS_ZERO,
              );

              initialSetBalance = underlyingTokenBalance.div(10);

              for (const wrappedfCashMock of wrappedfCashMocks) {
                await underlyingToken.approve(
                  wrappedfCashMock.address,
                  ethers.constants.MaxUint256,
                );
                await wrappedfCashMock.setMintTokenSpent(1);
                await wrappedfCashMock.mintViaUnderlying(
                  0,
                  underlyingTokenBalance,
                  owner.address,
                  0,
                );
                await wrappedfCashMock.setMintTokenSpent(0);
                await wrappedfCashMock.approve(
                  debtIssuanceModule.address,
                  ethers.constants.MaxUint256,
                );
              }
              await assetToken.approve(debtIssuanceModule.address, ethers.constants.MaxUint256);
              await debtIssuanceModule.issue(setToken.address, initialSetBalance, owner.address);
            });

            describe("When exchangeIssuance is deployed", () => {
              let exchangeIssuance: ExchangeIssuanceNotional;
              let notionalTradeModule: NotionalTradeModuleMock;
              beforeEach(async () => {
                notionalTradeModule = await deployer.mocks.deployNotionalTradeModuleMock();
                exchangeIssuance = await deployer.extensions.deployExchangeIssuanceNotional(
                  setV2Setup.weth.address,
                  setV2Setup.controller.address,
                  wrappedfCashFactoryMock.address,
                  notionalTradeModule.address,
                  quickswapRouter.address,
                  sushiswapRouter.address,
                  uniswapV3RouterAddress,
                  uniswapV3QuoterAddress,
                  curveAddressProviderAddress,
                  curveCalculatorAddress,
                );
              });

              describe("#getFilteredComponentsRedemption", () => {
                let subjectSetToken: Address;
                let subjectSetAmount: BigNumber;
                let subjectIssuanceModule: Address;
                let subjectIsDebtIssuance: boolean;
                let redeemAmount: BigNumber;
                beforeEach(async () => {
                  subjectSetToken = setToken.address;
                  subjectSetAmount = ethers.utils.parseEther("1");
                  subjectIssuanceModule = debtIssuanceModule.address;
                  subjectIsDebtIssuance = true;
                  redeemAmount = ethers.utils.parseEther("1.5");
                  for (const wrappedfCashMock of wrappedfCashMocks) {
                    await wrappedfCashMock.setRedeemTokenReturned(redeemAmount);
                  }
                });
                function subject() {
                  return exchangeIssuance.getFilteredComponentsRedemption(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectIssuanceModule,
                    subjectIsDebtIssuance,
                  );
                }
                it("should return correct components", async () => {
                  const [filteredComponents] = await subject();
                  expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                    ethers.utils.getAddress(underlyingToken.address),
                  );
                  expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                });
                it("should return correct units", async () => {
                  const [, filteredUnits] = await subject();
                  const expectedAmount = redeemAmount
                    .mul(wrappedfCashMocks.length)
                    .add(underlyingPosition);
                  expect(filteredUnits[0]).to.eq(expectedAmount);
                });
              });

              describe("#getFilteredComponentsIssuance", () => {
                let subjectSetToken: Address;
                let subjectSetAmount: BigNumber;
                let subjectIssuanceModule: Address;
                let subjectIsDebtIssuance: boolean;
                let mintAmount: BigNumber;
                beforeEach(async () => {
                  subjectSetToken = setToken.address;
                  subjectSetAmount = ethers.utils.parseEther("1");
                  subjectIssuanceModule = debtIssuanceModule.address;
                  subjectIsDebtIssuance = true;
                  mintAmount = ethers.utils.parseEther("1");
                  for (const wrappedfCashMock of wrappedfCashMocks) {
                    await wrappedfCashMock.setMintTokenSpent(mintAmount);
                  }
                });
                function subject() {
                  return exchangeIssuance.getFilteredComponentsIssuance(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectIssuanceModule,
                    subjectIsDebtIssuance,
                  );
                }
                it("should return correct components", async () => {
                  const [filteredComponents] = await subject();
                  expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                    ethers.utils.getAddress(underlyingToken.address),
                  );
                  expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                });
                it("should return correct units", async () => {
                  const [, filteredUnits] = await subject();
                  const expectedAmount = mintAmount
                    .mul(wrappedfCashMocks.length)
                    .add(underlyingPosition);
                  expect(filteredUnits[0]).to.eq(expectedAmount);
                });
              });

              describe("When set token is approved", () => {
                beforeEach(async () => {
                  await exchangeIssuance.approveSetToken(
                    setToken.address,
                    debtIssuanceModule.address,
                  );
                });
                describe("#issueExactSetFromToken", () => {
                  let subjectSetToken: Address;
                  let subjectInputToken: Address;
                  let subjectSetAmount: BigNumber;
                  let subjectMaxAmountInputToken: BigNumber;
                  let subjectComponentQuotes: SwapData[];
                  let subjectIssuanceModule: Address;
                  let subjectIsDebtIssuance: boolean;
                  let caller: Account;

                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    subjectSetAmount = ethers.utils.parseEther("1");
                    subjectIssuanceModule = debtIssuanceModule.address;
                    subjectIsDebtIssuance = true;
                    subjectComponentQuotes = [];
                    caller = owner;
                  });

                  function subject() {
                    return exchangeIssuance
                      .connect(caller.wallet)
                      .issueExactSetFromToken(
                        subjectSetToken,
                        subjectInputToken,
                        subjectSetAmount,
                        subjectMaxAmountInputToken,
                        subjectComponentQuotes,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                      );
                  }

                  ["underlyingToken", "usdc"].forEach((tokenType: string) => {
                    describe(`When issuing from ${tokenType}`, () => {
                      let inputToken: CERc20 | StandardTokenMock;
                      beforeEach(async () => {
                        inputToken =
                          // @ts-ignore
                          tokenType == "underlyingToken" ? underlyingToken : setV2Setup[tokenType];

                        await inputToken.approve(
                          exchangeIssuance.address,
                          ethers.constants.MaxUint256,
                        );
                        subjectInputToken = inputToken.address;
                        subjectMaxAmountInputToken = (
                          await inputToken.balanceOf(caller.address)
                        ).div(10);
                        for (const wrappedfCashMock of wrappedfCashMocks) {
                          await wrappedfCashMock.setMintTokenSpent(
                            subjectMaxAmountInputToken.div(wrappedfCashMocks.length + 1),
                          );
                        }
                        expect(subjectMaxAmountInputToken).to.be.gt(0);

                        const [
                          filteredComponents,
                        ] = await exchangeIssuance.getFilteredComponentsIssuance(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                        );
                        subjectComponentQuotes = filteredComponents.map((component: Address) => {
                          return {
                            path: [inputToken.address, component],
                            fees: [3000],
                            pool: ADDRESS_ZERO,
                            exchange: Exchange.UniV3,
                          };
                        });
                      });

                      it("should issue correct amount of set token", async () => {
                        const balanceBefore = await setToken.balanceOf(caller.address);
                        await subject();
                        const issuedAmount = (await setToken.balanceOf(caller.address)).sub(
                          balanceBefore,
                        );
                        expect(issuedAmount).to.eq(subjectSetAmount);
                      });

                      it("should spend correct amount of input token", async () => {
                        const balanceBefore = await inputToken.balanceOf(caller.address);
                        await subject();
                        const spentAmount = balanceBefore.sub(
                          await inputToken.balanceOf(caller.address),
                        );
                        expect(spentAmount).to.be.lte(subjectMaxAmountInputToken);
                      });
                    });
                  });
                });
                describe("#redeemExactSetForToken", () => {
                  let subjectSetToken: Address;
                  let subjectOutputToken: Address;
                  let subjectSetAmount: BigNumber;
                  let subjectMinAmountOutputToken: BigNumber;
                  let subjectComponentQuotes: SwapData[];
                  let subjectIssuanceModule: Address;
                  let subjectIsDebtIssuance: boolean;
                  let caller: Account;
                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    subjectSetAmount = ethers.utils.parseEther("1");
                    subjectIssuanceModule = debtIssuanceModule.address;
                    subjectIsDebtIssuance = true;
                    subjectMinAmountOutputToken = BigNumber.from(0);
                    subjectComponentQuotes = [];
                    caller = owner;
                  });
                  function subject() {
                    return exchangeIssuance
                      .connect(caller.wallet)
                      .redeemExactSetForToken(
                        subjectSetToken,
                        subjectOutputToken,
                        subjectSetAmount,
                        subjectMinAmountOutputToken,
                        subjectComponentQuotes,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                      );
                  }
                  describe("When caller has enough set token to redeem", () => {
                    beforeEach(async () => {
                      await underlyingToken
                        .connect(caller.wallet)
                        .approve(exchangeIssuance.address, ethers.constants.MaxUint256);

                      console.log("Issuing some set for the caller");
                      const [
                        filteredComponents,
                      ] = await exchangeIssuance.getFilteredComponentsIssuance(
                        subjectSetToken,
                        subjectSetAmount,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                      );
                      const swapData = filteredComponents.map(() => emptySwapData);
                      await exchangeIssuance
                        .connect(caller.wallet)
                        .issueExactSetFromToken(
                          setToken.address,
                          underlyingToken.address,
                          subjectSetAmount,
                          await underlyingToken.balanceOf(caller.address),
                          swapData,
                          debtIssuanceModule.address,
                          true,
                        );
                      await setToken.approve(exchangeIssuance.address, ethers.constants.MaxUint256);
                    });
                    ["underlyingToken", "usdc"].forEach((tokenType) => {
                      describe(`When redeeming to ${tokenType}`, () => {
                        let redeemAmountReturned: BigNumber;
                        let outputToken: CERc20 | StandardTokenMock;
                        beforeEach(async () => {
                          outputToken =
                            tokenType == "underlyingToken"
                              ? underlyingToken
                              : // @ts-ignore
                                setV2Setup[tokenType];
                          subjectOutputToken = outputToken.address;
                          redeemAmountReturned = BigNumber.from(1000);
                          subjectMinAmountOutputToken =
                            tokenType == "underlyingToken"
                              ? redeemAmountReturned
                              : (await outputToken.balanceOf(owner.address)).div(100);
                          for (const wrappedfCashMock of wrappedfCashMocks) {
                            await wrappedfCashMock.setRedeemTokenReturned(redeemAmountReturned);
                            await outputToken.transfer(
                              wrappedfCashMock.address,
                              redeemAmountReturned,
                            );
                          }

                          const [
                            filteredComponents,
                          ] = await exchangeIssuance.getFilteredComponentsIssuance(
                            subjectSetToken,
                            subjectSetAmount,
                            subjectIssuanceModule,
                            subjectIsDebtIssuance,
                          );
                          subjectComponentQuotes = filteredComponents.map((component: Address) => {
                            return {
                              path: [component, outputToken.address],
                              fees: [3000],
                              pool: ADDRESS_ZERO,
                              exchange: Exchange.UniV3,
                            };
                          });
                        });
                        it("should redeem correct amount of set token", async () => {
                          const balanceBefore = await setToken.balanceOf(caller.address);
                          await subject();
                          const redeemedAmount = balanceBefore.sub(
                            await setToken.balanceOf(caller.address),
                          );
                          expect(redeemedAmount).to.eq(subjectSetAmount);
                        });
                        it("should return correct amount of output token", async () => {
                          const balanceBefore = await outputToken.balanceOf(caller.address);
                          await subject();
                          const balanceAfter = await outputToken.balanceOf(caller.address);
                          const returnedAmount = balanceAfter.sub(balanceBefore);
                          expect(returnedAmount).to.gte(subjectMinAmountOutputToken);
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
