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

        describe("When wrappedFCashMock is deployed", () => {
          let wrappedfCashMock: WrappedfCashMock;
          let underlyingTokenBalance: BigNumber;
          let currencyId: number;
          let maturity: number;
          beforeEach(async () => {
            const underlyingAddress =
              underlyingToken.address == setup.weth.address ? ETH_ADDRESS : underlyingToken.address;

            wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(
              assetToken.address,
              underlyingAddress,
              setup.weth.address,
            );

            currencyId = 1;
            maturity = (await ethers.provider.getBlock("latest")).timestamp + 30 * 24 * 3600;

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
          });
          describe("When setToken is deployed", () => {
            let fCashPosition: BigNumber;
            let initialSetBalance: BigNumber;
            let setToken: SetToken;
            beforeEach(async () => {
              fCashPosition = ethers.utils.parseUnits("2", 9);

              setToken = await setup.createSetToken(
                [wrappedfCashMock.address],
                [fCashPosition],
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

              await wrappedfCashMock.mintViaUnderlying(0, underlyingTokenBalance, owner.address, 0);
              await wrappedfCashMock.approve(debtIssuanceModule.address, underlyingTokenBalance);
              await debtIssuanceModule.issue(setToken.address, initialSetBalance, owner.address);
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

                describe("When set token is approved", () => {
                  beforeEach(async () => {
                    await exchangeIssuance.approveSetToken(
                      setToken.address,
                      debtIssuanceModule.address,
                    );
                  });
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
              });
            });
          });
        });
      });
    });
  });
});
