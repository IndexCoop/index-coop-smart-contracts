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
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import { getAccounts, getSetFixture, getCompoundFixture, getWaffleExpect } from "@utils/index";
import { CompoundFixture, SetFixture } from "@utils/fixtures";
import { ADDRESS_ZERO } from "@utils/constants";
import { CERc20 } from "@utils/contracts/compound";

const expect = getWaffleExpect();

const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("ExchangeIssuanceNotional", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let manager: Account;
  let setup: SetFixture;

  let debtIssuanceModule: DebtIssuanceModule;

  let compoundSetup: CompoundFixture;
  let cTokenInitialMantissa: BigNumber;

  before(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSetFixture(owner.address);
    await setup.initialize();

    debtIssuanceModule = setup.debtIssuanceModule;

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    cTokenInitialMantissa = ether(200000000);
  });

  describe("when factory mock is deployed", async () => {
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

    ["dai", "weth"].forEach(underlyingTokenName => {
      describe(`When underlying token is ${underlyingTokenName}`, () => {
        let assetToken: CERc20;
        let underlyingToken: StandardTokenMock;

        beforeEach(async () => {
          // @ts-ignore
          underlyingToken = setup[underlyingTokenName];
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
              underlyingToken.address == setup.weth.address ? ETH_ADDRESS : underlyingToken.address;
            currencyId = 1;
            maturities = [30, 90];
            wrappedfCashMocks = [];

            for (const maturityDays of maturities) {
              console.log("Adding maturity", maturityDays);
              const wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(
                assetToken.address,
                underlyingAddress,
                setup.weth.address,
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
              console.log("Added maturity");
            }
          });
          describe("When setToken is deployed", () => {
            let fCashPosition: BigNumber;
            let initialSetBalance: BigNumber;
            let setToken: SetToken;
            beforeEach(async () => {
              fCashPosition = ethers.utils.parseUnits("2", 9);

              setToken = await setup.createSetToken(
                wrappedfCashMocks.map(mock => mock.address),
                wrappedfCashMocks.map(() => fCashPosition),
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
                await wrappedfCashMock.mintViaUnderlying(
                  0,
                  underlyingTokenBalance,
                  owner.address,
                  0,
                );
                await wrappedfCashMock.approve(
                  debtIssuanceModule.address,
                  ethers.constants.MaxUint256,
                );
              }
              console.log("Issuing some set");
              await debtIssuanceModule.issue(setToken.address, initialSetBalance, owner.address);
              console.log("Issued some set");
            });

            describe("When exchangeIssuance is deployed", () => {
              let exchangeIssuance: ExchangeIssuanceNotional;
              let notionalTradeModule: NotionalTradeModuleMock;
              beforeEach(async () => {
                notionalTradeModule = await deployer.mocks.deployNotionalTradeModuleMock();
                exchangeIssuance = await deployer.extensions.deployExchangeIssuanceNotional(
                  setup.weth.address,
                  setup.controller.address,
                  wrappedfCashFactoryMock.address,
                  notionalTradeModule.address,
                );
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
                  let subjectIssuanceModule: Address;
                  let subjectIsDebtIssuance: boolean;
                  let caller: Account;

                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    subjectSetAmount = ethers.utils.parseEther("1");
                    subjectIssuanceModule = debtIssuanceModule.address;
                    subjectIsDebtIssuance = true;
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
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                      );
                  }

                  ["assetToken", "underlyingToken"].forEach(tokenType => {
                    describe(`When issuing from ${tokenType}`, () => {
                      let inputToken: CERc20 | StandardTokenMock;
                      beforeEach(async () => {
                        inputToken = tokenType == "assetToken" ? assetToken : underlyingToken;
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
                            subjectMaxAmountInputToken.div(wrappedfCashMocks.length),
                          );
                        }
                        expect(subjectMaxAmountInputToken).to.be.gt(0);
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
                        expect(spentAmount).to.eq(subjectMaxAmountInputToken);
                      });
                    });
                  });
                });
                describe("#redeemExactSetForToken", () => {
                  let subjectSetToken: Address;
                  let subjectOutputToken: Address;
                  let subjectSetAmount: BigNumber;
                  let subjectMinAmountOutputToken: BigNumber;
                  let subjectIssuanceModule: Address;
                  let subjectIsDebtIssuance: boolean;
                  let caller: Account;
                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    subjectSetAmount = ethers.utils.parseEther("1");
                    subjectIssuanceModule = debtIssuanceModule.address;
                    subjectIsDebtIssuance = true;
                    subjectMinAmountOutputToken = BigNumber.from(0);
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
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                      );
                  }
                  describe("When caller has enough set token to redeem", () => {
                    beforeEach(async () => {
                      await assetToken
                        .connect(caller.wallet)
                        .approve(exchangeIssuance.address, ethers.constants.MaxUint256);
                      await exchangeIssuance
                        .connect(caller.wallet)
                        .issueExactSetFromToken(
                          setToken.address,
                          assetToken.address,
                          subjectSetAmount,
                          0,
                          debtIssuanceModule.address,
                          true,
                        );
                      await setToken.approve(exchangeIssuance.address, ethers.constants.MaxUint256);
                    });
                    ["assetToken", "underlyingToken"].forEach(tokenType => {
                      describe(`When redeeming to ${tokenType}`, () => {
                        let redeemAmountReturned: BigNumber;
                        let outputToken: CERc20 | StandardTokenMock;
                        beforeEach(async () => {
                          outputToken = tokenType == "assetToken" ? assetToken : underlyingToken;
                          subjectOutputToken = outputToken.address;
                          redeemAmountReturned = BigNumber.from(1000);
                          subjectMinAmountOutputToken = redeemAmountReturned;
                          wrappedfCashMocks.forEach(async wrappedfCashMock => {
                            await wrappedfCashMock.setRedeemTokenReturned(redeemAmountReturned);
                            await outputToken.transfer(
                              wrappedfCashMock.address,
                              redeemAmountReturned,
                            );
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
                          expect(returnedAmount).to.eq(redeemAmountReturned);
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
