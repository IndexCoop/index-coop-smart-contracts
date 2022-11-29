import "module-alias/register";
import { BigNumber, BigNumberish, Signer } from "ethers";
import { network } from "hardhat";
import { Address } from "@utils/types";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import { ethers } from "hardhat";

import { getAccounts, getWaffleExpect } from "@utils/index";
import {
  BaseManagerV2,
  FixedRebalanceExtension,
  INotionalTradeModule,
  INotionalTradeModule__factory,
  SetToken__factory,
  IWrappedfCashComplete__factory,
  IERC20__factory,
  IERC20,
  ICErc20__factory,
  INotionalProxy,
  INotionalProxy__factory,
} from "../../../typechain";
import { ONE_MONTH_IN_SECONDS, ZERO } from "@utils/constants";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();

const { parseUnits, parseEther } = ethers.utils;

if (process.env.INTEGRATIONTEST) {
  describe("FixedRebalanceExtension", () => {
    let deployer: DeployHelper;
    let operator: Signer;
    let user: Signer;
    let setToken: SetToken;
    let notionalTradeModule: INotionalTradeModule;
    let componentMaturities: number[];
    let componentPositions: any[];
    let notionalProxy: INotionalProxy;

    const threeMonthComponent = "0x6Af2a72FB8DeF29cF2cEcc41097EE750C031E5af";
    const sixMonthComponent = "0x8220fA35c63A5e8F1c029f9bb0cbb0292d30b8C4";

    const addresses = PRODUCTION_ADDRESSES;

    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      const [userAccount] = await getAccounts();
      user = userAccount.wallet;
      setToken = SetToken__factory.connect(addresses.tokens.fixedDai, user);
      const operatorAddress = await setToken.manager();
      operator = await impersonateAccount(operatorAddress);
      notionalProxy = INotionalProxy__factory.connect(
        addresses.lending.notional.notionalV2,
        operator,
      );
      notionalTradeModule = INotionalTradeModule__factory.connect(
        addresses.setFork.notionalTradeModule,
        operator,
      );

      componentMaturities = await Promise.all(
        (await setToken.getComponents()).map(c => {
          const wrappedfCash = IWrappedfCashComplete__factory.connect(c, operator);
          return wrappedfCash.getMaturity();
        }),
      );

      componentPositions = await setToken.getPositions();

      setToken.connect(operator);

      deployer = new DeployHelper(operator);
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    // async function logPositions(label: string) {
    //   const positionsAfter = await setToken.getPositions();
    //   console.log(
    //     label,
    //     positionsAfter.map((p: any) => {
    //       return {
    //         component: p.component,
    //         unit: p.unit.toString(),
    //       };
    //     }),
    //   );
    // }

    describe("When token control is transferred to manager contract", () => {
      let baseManagerV2: BaseManagerV2;

      beforeEach(async () => {
        baseManagerV2 = await deployer.manager.deployBaseManagerV2(
          setToken.address,
          await operator.getAddress(),
          await operator.getAddress(),
        );
        await baseManagerV2.authorizeInitialization();
      });
      describe("When extension is deployed", () => {
        let rolloverExtension: FixedRebalanceExtension;
        let validMaturities: BigNumberish[];
        let maturities: BigNumberish[];
        let allocations: BigNumberish[];
        let underlyingToken: Address;
        let assetToken: Address;
        let currencyId: number;
        let assetTokenContract: IERC20;
        let threeMonthAllocation: BigNumber;
        let sixMonthAllocation: BigNumber;
        beforeEach(async () => {
          underlyingToken = addresses.tokens.dai;
          assetToken = addresses.tokens.cDAI;
          assetTokenContract = IERC20__factory.connect(assetToken, operator);
          const maturitiesMonths = [3, 6];
          maturities = maturitiesMonths.map(m => ONE_MONTH_IN_SECONDS.mul(m));
          validMaturities = maturities;
          sixMonthAllocation = ether(0.75);
          threeMonthAllocation = ether(0.25);
          allocations = [threeMonthAllocation, sixMonthAllocation];
          rolloverExtension = await deployer.extensions.deployFixedRebalanceExtension(
            baseManagerV2.address,
            setToken.address,
            addresses.setFork.notionalTradeModule,
            notionalProxy.address,
            addresses.lending.notional.wrappedfCashFactory,
            underlyingToken,
            assetTokenContract.address,
            maturities,
            allocations,
            validMaturities,
          );
          await baseManagerV2.connect(operator).addExtension(rolloverExtension.address);
          currencyId = await rolloverExtension.currencyId();
        });

        describe("#getAbsoluteMaturities", () => {
          function subject() {
            return rolloverExtension.getAbsoluteMaturities();
          }
          it("should work", async () => {
            const absoluteMaturities = (await subject()).map((bn: any) => bn.toNumber());
            expect(absoluteMaturities).to.have.same.members(componentMaturities);
          });
        });

        describe("#setValidMaturities", () => {
          let subjectMaturities: BigNumberish[];
          let caller: Signer;
          beforeEach(() => {
            subjectMaturities = [ONE_MONTH_IN_SECONDS.mul(3)];
          });

          function subject() {
            return rolloverExtension.connect(caller).setValidMaturities(subjectMaturities);
          }

          describe("when the caller is not the owner", () => {
            beforeEach(async () => {
              caller = user;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
          describe("when the caller is the owner", () => {
            beforeEach(async () => {
              caller = operator;
            });
            it("should work", async () => {
              await subject();
            });
            it("should set valid maturities correctly", async () => {
              await subject();
              const validMaturities = await rolloverExtension.getValidMaturities();
              expect(validMaturities).to.deep.equal(subjectMaturities);
            });
            describe("when the maturities are ordered incorrectly", () => {
              beforeEach(async () => {
                subjectMaturities = [ONE_MONTH_IN_SECONDS.mul(3), ONE_MONTH_IN_SECONDS];
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith(
                  "validMaturities must be in ascending order",
                );
              });
            });
          });
        });

        describe("#setMaturities", () => {
          let subjectMaturities: BigNumberish[];
          let subjectAllocations: BigNumberish[];
          let caller: Signer;
          beforeEach(() => {
            subjectMaturities = [ONE_MONTH_IN_SECONDS.mul(6), ONE_MONTH_IN_SECONDS.mul(3)];
            subjectAllocations = [ether(0.5), ether(0.5)];
          });

          function subject() {
            return rolloverExtension
              .connect(caller)
              .setAllocations(subjectMaturities, subjectAllocations);
          }

          describe("when the caller is not the owner", () => {
            beforeEach(async () => {
              caller = user;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
          describe("when the caller is the owner", () => {
            beforeEach(async () => {
              caller = operator;
            });
            it("should work", async () => {
              await subject();
            });
            it("should set maturities correctly", async () => {
              await subject();
              const [maturities] = await rolloverExtension.getAllocations();
              expect(maturities).to.deep.equal(subjectMaturities);
            });

            it("should set allocations correctly", async () => {
              await subject();
              const [, allocations] = await rolloverExtension.getAllocations();
              expect(allocations).to.deep.equal(subjectAllocations);
            });
          });
        });
        describe("#rebalance", () => {
          const subjectShare = parseEther("1");
          function subject() {
            return rolloverExtension.rebalance(subjectShare);
          }

          async function checkAllocation() {
            const totalValue = parseUnits("100", 8);
            const tolerance = parseUnits("0.5", 8);
            expect(await setToken.getDefaultPositionRealUnit(assetToken)).to.lt(10000);
            expect(await setToken.getDefaultPositionRealUnit(sixMonthComponent)).to.gt(
              totalValue
                .mul(sixMonthAllocation)
                .div(ether(1))
                .sub(tolerance),
            );
            expect(await setToken.getDefaultPositionRealUnit(sixMonthComponent)).to.lt(
              totalValue
                .mul(sixMonthAllocation)
                .div(ether(1))
                .add(tolerance),
            );
            expect(await setToken.getDefaultPositionRealUnit(threeMonthComponent)).to.gt(
              totalValue
                .mul(threeMonthAllocation)
                .div(ether(1))
                .sub(tolerance),
            );
            expect(await setToken.getDefaultPositionRealUnit(threeMonthComponent)).to.lt(
              totalValue
                .mul(threeMonthAllocation)
                .div(ether(1))
                .add(tolerance),
            );
          }
          [true, false].forEach(tradeViaUnderlying => {
            describe(`When trading via the ${
              tradeViaUnderlying ? "underlying" : "asset"
            } token`, () => {
              beforeEach(async () => {
                await rolloverExtension.connect(operator).setTradeViaUnderlying(tradeViaUnderlying);
              });
              describe("when allocations are unchanged", () => {
                beforeEach(async () => {
                  await setToken.connect(operator).setManager(baseManagerV2.address);
                });
                it("should work", async () => {
                  await subject();
                  await checkAllocation();
                });
              });

              describe("when allocation was changed", () => {
                beforeEach(async () => {
                  await setToken.connect(operator).setManager(baseManagerV2.address);
                  threeMonthAllocation = ether(0.5);
                  sixMonthAllocation = ether(0.5);
                  const maturities = [ONE_MONTH_IN_SECONDS.mul(6), ONE_MONTH_IN_SECONDS.mul(3)];
                  const allocations = [sixMonthAllocation, threeMonthAllocation];
                  await rolloverExtension.connect(operator).setAllocations(maturities, allocations);
                });
                it("should work", async () => {
                  await subject();
                  await checkAllocation();
                });
              });

              describe("when fcash position was reduced", () => {
                const redeemPositionIndex = 1;
                beforeEach(async () => {
                  await notionalTradeModule
                    .connect(operator)
                    .redeemFixedFCashForToken(
                      setToken.address,
                      currencyId,
                      componentMaturities[redeemPositionIndex],
                      componentPositions[redeemPositionIndex].unit,
                      tradeViaUnderlying ? underlyingToken : assetToken,
                      0,
                    );
                  await setToken.connect(operator).setManager(baseManagerV2.address);
                });
                it("should work", async () => {
                  await subject();
                  await checkAllocation();
                });
              });
              describe("when fcash position was moved", () => {
                const redeemPositionIndex = 1;
                beforeEach(async () => {
                  await notionalTradeModule
                    .connect(operator)
                    .redeemFixedFCashForToken(
                      setToken.address,
                      currencyId,
                      componentMaturities[redeemPositionIndex],
                      componentPositions[redeemPositionIndex].unit,
                      assetToken,
                      0,
                    );
                  const obtainedAssetTokenPosition = await setToken.getDefaultPositionRealUnit(
                    assetToken,
                  );
                  await notionalTradeModule
                    .connect(operator)
                    .mintFCashForFixedToken(
                      setToken.address,
                      currencyId,
                      componentMaturities[(redeemPositionIndex + 1) % 2],
                      0,
                      assetToken,
                      obtainedAssetTokenPosition,
                    );
                  await setToken.connect(operator).setManager(baseManagerV2.address);
                });
                it("should work", async () => {
                  await subject();
                  await checkAllocation();
                });
              });
            });
          });
        });

        describe("#getUnderweightPositions", () => {
          function subject() {
            return rolloverExtension.getUnderweightPositions();
          }
          it("should work", async () => {
            const [underweightPositions, , absoluteMaturities] = await subject();
            expect(underweightPositions[0]).to.equal(ZERO);
            expect(underweightPositions[1]).to.be.gt(ZERO);
            expect(absoluteMaturities.map((bn: BigNumber) => bn.toNumber())).to.have.same.members(
              componentMaturities,
            );
          });
          describe("when fcash position was reduced", () => {
            const redeemPositionIndex = 1;
            beforeEach(async () => {
              await notionalTradeModule
                .connect(operator)
                .redeemFixedFCashForToken(
                  setToken.address,
                  currencyId,
                  componentMaturities[redeemPositionIndex],
                  componentPositions[redeemPositionIndex].unit,
                  assetToken,
                  0,
                );
              await setToken.connect(operator).setManager(baseManagerV2.address);
            });
            it("should work", async () => {
              const [, , absoluteMaturities] = await subject();
              expect(absoluteMaturities.map((bn: BigNumber) => bn.toNumber())).to.have.same.members(
                componentMaturities,
              );
            });
          });
        });

        describe("#getTotalAllocation", () => {
          function subject() {
            return rolloverExtension.getTotalAllocation();
          }
          it("should work", async () => {
            const totalFCashPosition = await subject();
            const expectedPositionInFCash = parseUnits("100", 8);
            const exchangeRate = await ICErc20__factory.connect(
              assetToken,
              operator,
            ).exchangeRateStored();
            const expectedTotalFCashPosition = expectedPositionInFCash
              .mul(parseUnits("1", 28))
              .div(exchangeRate);
            expect(totalFCashPosition).to.be.gt(expectedTotalFCashPosition.mul(95).div(100));
            expect(totalFCashPosition).to.be.lt(expectedTotalFCashPosition.mul(105).div(100));
          });
        });
      });
    });
  });
}
