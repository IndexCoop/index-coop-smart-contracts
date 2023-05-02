import "module-alias/register";
import { BigNumber, BigNumberish, Signer } from "ethers";
import { ethers, network } from "hardhat";
import { Address } from "@utils/types";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";

import { getAccounts, getWaffleExpect } from "@utils/index";
import {
  BaseManagerV2,
  FixedRebalanceExtension,
  INotionalTradeModule,
  INotionalTradeModule__factory,
  SetToken__factory,
  IWrappedfCashComplete__factory,
  IWrappedfCashFactory,
  IWrappedfCashFactory__factory,
  IERC20__factory,
  IERC20,
  ICErc20__factory,
  INotionalProxy,
  INotionalProxy__factory,
} from "../../../typechain";
import { ONE_MONTH_IN_SECONDS, ZERO } from "@utils/constants";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { impersonateAccount } from "./utils";
import { setBlockNumber } from "@utils/test/testingUtils";

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
    let wrappedfCashFactory: IWrappedfCashFactory;

    let threeMonthComponent = "0x6Af2a72FB8DeF29cF2cEcc41097EE750C031E5af";
    let sixMonthComponent = "0x8220fA35c63A5e8F1c029f9bb0cbb0292d30b8C4";

    const addresses = PRODUCTION_ADDRESSES;

    let snapshotId: number;

    setBlockNumber(16180859);
    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      const [userAccount] = await getAccounts();
      user = userAccount.wallet;
      setToken = SetToken__factory.connect(addresses.tokens.fixedDai, user);
      const operatorAddress = await setToken.manager();
      operator = await impersonateAccount(operatorAddress);
      wrappedfCashFactory = IWrappedfCashFactory__factory.connect(
        addresses.lending.notional.wrappedfCashFactory,
        operator,
      );

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
        let rebalanceExtension: FixedRebalanceExtension;
        let maturities: BigNumberish[];
        let allocations: BigNumberish[];
        let underlyingToken: Address;
        let assetToken: Address;
        let currencyId: number;
        let assetTokenContract: IERC20;
        let threeMonthAllocation: BigNumber;
        let sixMonthAllocation: BigNumber;
        const minPositions = [parseUnits("20", 8), parseUnits("20", 8)];

        beforeEach(async () => {
          underlyingToken = addresses.tokens.dai;
          assetToken = addresses.tokens.cDAI;
          assetTokenContract = IERC20__factory.connect(assetToken, operator);
          const maturitiesMonths = [3, 6];
          maturities = maturitiesMonths.map(m => ONE_MONTH_IN_SECONDS.mul(m));
          sixMonthAllocation = ether(0.75);
          threeMonthAllocation = ether(0.25);
          allocations = [threeMonthAllocation, sixMonthAllocation];
          rebalanceExtension = await deployer.extensions.deployFixedRebalanceExtension(
            baseManagerV2.address,
            setToken.address,
            addresses.setFork.notionalTradeModule,
            notionalProxy.address,
            wrappedfCashFactory.address,
            underlyingToken,
            assetTokenContract.address,
            maturities,
            allocations,
            minPositions,
          );
          await baseManagerV2.connect(operator).addExtension(rebalanceExtension.address);
          currencyId = await rebalanceExtension.currencyId();
        });
        describe("#constructor", () => {
          it("should set the correct state variables", async () => {
            expect(await rebalanceExtension.setToken()).to.eq(setToken.address);
          });
        });

        describe("#getAbsoluteMaturities", () => {
          function subject() {
            return rebalanceExtension.getAbsoluteMaturities();
          }
          it("should have the same members as componentMaturities", async () => {
            const absoluteMaturities = (await subject()).map((bn: any) => bn.toNumber());
            expect(absoluteMaturities).to.have.same.members(componentMaturities);
          });
        });

        describe("#setAllocations", () => {
          let subjectMaturities: BigNumberish[];
          let subjectAllocations: BigNumberish[];
          const subjectMinPositions = minPositions;
          let caller: Signer;
          beforeEach(() => {
            subjectMaturities = [ONE_MONTH_IN_SECONDS.mul(6), ONE_MONTH_IN_SECONDS.mul(3)];
            subjectAllocations = [ether(0.5), ether(0.5)];
          });

          function subject() {
            return rebalanceExtension
              .connect(caller)
              .setAllocations(subjectMaturities, subjectAllocations, subjectMinPositions);
          }

          describe("when the caller is not the operator", () => {
            beforeEach(async () => {
              caller = user;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });

          describe("when the operator has changed", () => {
            beforeEach(async () => {
              caller = operator;
              baseManagerV2.connect(operator).setOperator(await user.getAddress());
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
          describe("when the caller is the operator", () => {
            beforeEach(async () => {
              caller = operator;
            });
            it("should not revert", async () => {
              await subject();
            });
            it("should set maturities correctly", async () => {
              await subject();
              const [maturities] = await rebalanceExtension.getAllocations();
              expect(maturities).to.deep.equal(subjectMaturities);
            });

            it("should set allocations correctly", async () => {
              await subject();
              const [, allocations] = await rebalanceExtension.getAllocations();
              expect(allocations).to.deep.equal(subjectAllocations);
            });

            it("should set minPositions correctly", async () => {
              await subject();
              const [, , _minPositions] = await rebalanceExtension.getAllocations();
              expect(_minPositions).to.deep.equal(subjectMinPositions);
            });

            describe("when allocations don't add up to 1", () => {
              beforeEach(async () => {
                subjectAllocations = [ether(0.8), ether(0.5)];
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Allocations must sum to 1");
              });
            });

            describe("when maturities and allocations are of different length", () => {
              beforeEach(async () => {
                subjectMaturities = [ONE_MONTH_IN_SECONDS.mul(6)];
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith(
                  "Maturities, minPositions and allocations must be same length",
                );
              });
            });
          });
        });
        describe("#rebalance", () => {
          let subjectShare: BigNumber;
          let subjectMinPositions: BigNumber[];
          let caller: Signer;
          beforeEach(async () => {
            subjectShare = parseEther("1");
            subjectMinPositions = [parseUnits("21", 8), parseUnits("21", 8)];
            caller = user;
          });
          function subject() {
            return rebalanceExtension.connect(caller).rebalance(subjectShare, subjectMinPositions);
          }

          function subjectStatic() {
            return rebalanceExtension
              .connect(caller)
              .callStatic.rebalance(subjectShare, subjectMinPositions);
          }

          async function checkAllocation() {
            const totalValue = parseUnits("100", 8);
            const tolerance = parseUnits("0.75", 8);
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

          describe("when caller is not approved", () => {
            beforeEach(async () => {
              // Even the operator can't call this method if he is not in the allow mapping
              caller = operator;
              await rebalanceExtension.updateCallerStatus([await caller.getAddress()], [false]);
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Address not permitted to call");
            });
          });
          describe("when caller is approved", () => {
            beforeEach(async () => {
              await rebalanceExtension.updateCallerStatus([await caller.getAddress()], [true]);
            });
            describe("when share is too high", () => {
              beforeEach(async () => {
                await setToken.connect(operator).setManager(baseManagerV2.address);
                subjectShare = parseEther("1.1");
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Share cannot exceed 100%");
              });
            });

            describe("when share is zero", () => {
              beforeEach(async () => {
                await setToken.connect(operator).setManager(baseManagerV2.address);
                subjectShare = ZERO;
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Share must be greater than 0");
              });
            });

            describe("when minPositions are too high", () => {
              beforeEach(async () => {
                await setToken.connect(operator).setManager(baseManagerV2.address);
                subjectMinPositions = [parseUnits("100", 8), parseUnits("100", 8)];
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Position below min");
              });
            });

            describe("when minPositions have wrong length", () => {
              beforeEach(async () => {
                await setToken.connect(operator).setManager(baseManagerV2.address);
                subjectMinPositions = [parseUnits("100", 8)];
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith(
                  "Min positions must be same length as maturities",
                );
              });
            });

            describe("when invalid maturity was set", () => {
              beforeEach(async () => {
                await setToken.connect(operator).setManager(baseManagerV2.address);
                await rebalanceExtension.connect(operator).setAllocations([ZERO], [ether(1)], [0]);
                subjectMinPositions = [parseUnits("100", 8)];
              });
              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith(
                  "No active market found for given relative maturity",
                );
              });
            });

            [false, true].forEach(tradeViaUnderlying => {
              describe(`When trading via the ${
                tradeViaUnderlying ? "underlying" : "asset"
              } token`, () => {
                beforeEach(async () => {
                  await rebalanceExtension
                    .connect(operator)
                    .setTradeViaUnderlying(tradeViaUnderlying);
                  await notionalTradeModule
                    .connect(operator)
                    .setRedeemToUnderlying(setToken.address, tradeViaUnderlying);
                });

                describe("when allocations are unchanged", () => {
                  beforeEach(async () => {
                    await setToken.connect(operator).setManager(baseManagerV2.address);
                  });
                  it("should adjust the allocations correctly", async () => {
                    await subject();
                    await checkAllocation();
                  });

                  it("predicted positions should be greater than minimum values passed", async () => {
                    const positionsAfter = await subjectStatic();
                    expect(positionsAfter.length).to.eq(subjectMinPositions.length);
                    for (let i = 0; i < positionsAfter.length; i++) {
                      expect(positionsAfter[i]).to.gte(subjectMinPositions[i]);
                    }
                  });

                  it("predicted positions should be equal to returned current positions after", async () => {
                    const predictedPositions = await subjectStatic();
                    await subject();
                    const positionsAfter = await rebalanceExtension.getCurrentPositions();
                    expect(predictedPositions.length).to.eq(positionsAfter.length);
                    const tolerance = 100;
                    for (let i = 0; i < predictedPositions.length; i++) {
                      expect(predictedPositions[i]).to.gte(positionsAfter[i].sub(tolerance));
                      expect(predictedPositions[i]).to.lte(positionsAfter[i].add(tolerance));
                    }
                  });
                });

                describe("when 3 month position has expired", () => {
                  let threeMonthComponentBefore: string;
                  let sixMonthComponentBefore: string;
                  beforeEach(async () => {
                    threeMonthComponentBefore = threeMonthComponent;
                    sixMonthComponentBefore = sixMonthComponent;

                    subjectMinPositions = [parseUnits("21", 8), parseUnits("21", 8)];
                    await setToken.connect(operator).setManager(baseManagerV2.address);
                    const maturity = await IWrappedfCashComplete__factory.connect(
                      threeMonthComponent,
                      operator,
                    ).getMaturity();
                    await network.provider.send("evm_setNextBlockTimestamp", [maturity + 1]);
                    await network.provider.send("evm_mine"); // this on

                    await notionalProxy.initializeMarkets(currencyId, false);
                    await notionalTradeModule.redeemMaturedPositions(setToken.address);

                    threeMonthComponent = sixMonthComponent;

                    const sixMonthAbsoluteMaturity = await rebalanceExtension.relativeToAbsoluteMaturity(
                      ONE_MONTH_IN_SECONDS.mul(6),
                    );
                    sixMonthComponent = await wrappedfCashFactory.computeAddress(
                      currencyId,
                      sixMonthAbsoluteMaturity,
                    );
                  });
                  afterEach(() => {
                    threeMonthComponent = threeMonthComponentBefore;
                    sixMonthComponent = sixMonthComponentBefore;
                  });
                  it("should adjust the allocations correctly", async () => {
                    await subject();
                    await checkAllocation();
                  });
                  it("predicted positions should be greater than minimum values passed", async () => {
                    const positionsAfter = await subjectStatic();
                    expect(positionsAfter.length).to.eq(subjectMinPositions.length);
                    for (let i = 0; i < positionsAfter.length; i++) {
                      expect(positionsAfter[i]).to.gte(subjectMinPositions[i]);
                    }
                  });

                  it("predicted positions should be equal to returned current positions after", async () => {
                    const predictedPositions = await subjectStatic();
                    await subject();
                    const positionsAfter = await rebalanceExtension.getCurrentPositions();
                    expect(predictedPositions.length).to.eq(positionsAfter.length);
                    const tolerance = 100;
                    for (let i = 0; i < predictedPositions.length; i++) {
                      expect(predictedPositions[i]).to.gte(positionsAfter[i].sub(tolerance));
                      expect(predictedPositions[i]).to.lte(positionsAfter[i].add(tolerance));
                    }
                  });
                });

                describe("when allocation was changed", () => {
                  beforeEach(async () => {
                    await setToken.connect(operator).setManager(baseManagerV2.address);
                    threeMonthAllocation = ether(0.5);
                    sixMonthAllocation = ether(0.5);
                    const maturities = [ONE_MONTH_IN_SECONDS.mul(6), ONE_MONTH_IN_SECONDS.mul(3)];
                    const allocations = [sixMonthAllocation, threeMonthAllocation];
                    await rebalanceExtension
                      .connect(operator)
                      .setAllocations(maturities, allocations, minPositions);
                  });
                  it("should adjust the allocations correctly", async () => {
                    await subject();
                    await checkAllocation();
                  });
                  it("predicted positions should be greater than minimum values passed", async () => {
                    const positionsAfter = await subjectStatic();
                    expect(positionsAfter.length).to.eq(subjectMinPositions.length);
                    for (let i = 0; i < positionsAfter.length; i++) {
                      expect(positionsAfter[i]).to.gte(subjectMinPositions[i]);
                    }
                  });

                  it("predicted positions should be equal to returned current positions after", async () => {
                    const predictedPositions = await subjectStatic();
                    await subject();
                    const positionsAfter = await rebalanceExtension.getCurrentPositions();
                    expect(predictedPositions.length).to.eq(positionsAfter.length);
                    const tolerance = 100;
                    for (let i = 0; i < predictedPositions.length; i++) {
                      expect(predictedPositions[i]).to.gte(positionsAfter[i].sub(tolerance));
                      expect(predictedPositions[i]).to.lte(positionsAfter[i].add(tolerance));
                    }
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
                  it("should adjust the allocations correctly", async () => {
                    await subject();
                    await checkAllocation();
                  });
                  it("predicted positions should be greater than minimum values passed", async () => {
                    const positionsAfter = await subjectStatic();
                    expect(positionsAfter.length).to.eq(subjectMinPositions.length);
                    for (let i = 0; i < positionsAfter.length; i++) {
                      expect(positionsAfter[i]).to.gte(subjectMinPositions[i]);
                    }
                  });

                  it("predicted positions should be equal to returned current positions after", async () => {
                    const predictedPositions = await subjectStatic();
                    await subject();
                    const positionsAfter = await rebalanceExtension.getCurrentPositions();
                    expect(predictedPositions.length).to.eq(positionsAfter.length);
                    const tolerance = 100;
                    for (let i = 0; i < predictedPositions.length; i++) {
                      expect(predictedPositions[i]).to.gte(positionsAfter[i].sub(tolerance));
                      expect(predictedPositions[i]).to.lte(positionsAfter[i].add(tolerance));
                    }
                  });
                });
                describe("when 6 month position was sold in favor of 3 month position", () => {
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
                  it("should adjust the allocations correctly", async () => {
                    await subject();
                    await checkAllocation();
                  });

                  it("predicted positions should be greater than minimum values passed", async () => {
                    const positionsAfter = await subjectStatic();
                    expect(positionsAfter.length).to.eq(subjectMinPositions.length);
                    for (let i = 0; i < positionsAfter.length; i++) {
                      expect(positionsAfter[i]).to.gte(subjectMinPositions[i]);
                    }
                  });

                  it("predicted positions should be equal to returned current positions after", async () => {
                    const predictedPositions = await subjectStatic();
                    await subject();
                    const positionsAfter = await rebalanceExtension.getCurrentPositions();
                    expect(predictedPositions.length).to.eq(positionsAfter.length);
                    const tolerance = 100;
                    for (let i = 0; i < predictedPositions.length; i++) {
                      expect(predictedPositions[i]).to.gte(positionsAfter[i].sub(tolerance));
                      expect(predictedPositions[i]).to.lte(positionsAfter[i].add(tolerance));
                    }
                  });

                  describe("when only partially executing the trade", () => {
                    beforeEach(async () => {
                      subjectShare = ether(0.5);

                      const currentPositions = await rebalanceExtension.getCurrentPositions();
                      expect(currentPositions.length).to.eq(minPositions.length);
                      subjectMinPositions = currentPositions.map((curPosition, i) => {
                        const minPosition = minPositions[i];
                        let weightedDiff;
                        let weightedMinPosition;
                        if (curPosition.gt(minPosition)) {
                          weightedDiff = curPosition
                            .sub(minPosition)
                            .mul(subjectShare)
                            .div(ether(1));

                          weightedMinPosition = curPosition.sub(weightedDiff);
                        } else {
                          weightedDiff = minPosition
                            .sub(curPosition)
                            .mul(subjectShare)
                            .div(ether(1));

                          weightedMinPosition = curPosition.add(weightedDiff);
                        }
                        return weightedMinPosition;
                      });
                    });
                    it("should adjust the allocations correctly", async () => {
                      await subject();
                      const totalValue = parseUnits("100", 8);
                      const tolerance = parseUnits("0.75", 8);
                      const expectedSixMonthPosition = totalValue.mul(
                        sixMonthAllocation.add(
                          ether(1)
                            .sub(sixMonthAllocation)
                            .mul(subjectShare)
                            .div(ether(1)),
                        ),
                      );
                      const expectedThreeMonthPosition = totalValue.mul(
                        threeMonthAllocation.mul(subjectShare).div(ether(1)),
                      );
                      expect(await setToken.getDefaultPositionRealUnit(sixMonthComponent)).to.gt(
                        expectedSixMonthPosition.div(ether(1)).sub(tolerance),
                      );
                      expect(await setToken.getDefaultPositionRealUnit(sixMonthComponent)).to.lt(
                        expectedSixMonthPosition.div(ether(1)).add(tolerance),
                      );
                      expect(await setToken.getDefaultPositionRealUnit(threeMonthComponent)).to.gt(
                        expectedThreeMonthPosition.div(ether(1)).sub(tolerance),
                      );
                      expect(await setToken.getDefaultPositionRealUnit(threeMonthComponent)).to.lt(
                        expectedThreeMonthPosition.div(ether(1)).add(tolerance),
                      );
                    });
                    it("predicted positions should be greater than minimum values passed", async () => {
                      const positionsAfter = await subjectStatic();
                      expect(positionsAfter.length).to.eq(subjectMinPositions.length);
                      for (let i = 0; i < positionsAfter.length; i++) {
                        expect(positionsAfter[i]).to.gte(subjectMinPositions[i]);
                      }
                    });

                    it("predicted positions should be equal to returned current positions after", async () => {
                      const predictedPositions = await subjectStatic();
                      await subject();
                      const positionsAfter = await rebalanceExtension.getCurrentPositions();
                      expect(predictedPositions.length).to.eq(positionsAfter.length);
                      const tolerance = 100;
                      for (let i = 0; i < predictedPositions.length; i++) {
                        expect(predictedPositions[i]).to.gte(positionsAfter[i].sub(tolerance));
                        expect(predictedPositions[i]).to.lte(positionsAfter[i].add(tolerance));
                      }
                    });
                  });
                });
              });
            });
          });
        });

        describe("#getUnderweightPositions", () => {
          function subject() {
            return rebalanceExtension.getUnderweightPositions();
          }
          it("should return correct values (6 months position should slightly be underweighted)", async () => {
            const [underweightPositions, , absoluteMaturities] = await subject();
            expect(underweightPositions[0]).to.equal(ZERO);
            expect(underweightPositions[1]).to.be.gt(ZERO);
            expect(absoluteMaturities.map((bn: BigNumber) => bn.toNumber())).to.have.same.members(
              componentMaturities,
            );
          });
          describe("when 3 month position was sold", () => {
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
            it("should return correct values (both fCash positions should be underweighted)", async () => {
              const [underweightPositions, , absoluteMaturities] = await subject();
              expect(underweightPositions[0]).to.be.gt(ZERO);
              expect(underweightPositions[1]).to.be.gt(ZERO);
              expect(absoluteMaturities.map((bn: BigNumber) => bn.toNumber())).to.have.same.members(
                componentMaturities,
              );
            });
          });
        });

        describe("#getTotalAllocation", () => {
          function subject() {
            return rebalanceExtension.getTotalAllocation();
          }
          describe("when extension is set to trade via asset token (cToken)", () => {
            it("should return correct value (ca. 100 USD worth of cToken)", async () => {
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

          describe("when extension is set to trade via underlying token", () => {
            beforeEach(async () => {
              await rebalanceExtension.connect(operator).setTradeViaUnderlying(true);
            });
            it("should return correct value (ca. 100 USD worth of underlying)", async () => {
              const totalFCashPosition = await subject();
              const expectedTotalUnderlyingPosition = parseUnits("100", 18);
              expect(totalFCashPosition).to.be.gt(expectedTotalUnderlyingPosition.mul(95).div(100));
              expect(totalFCashPosition).to.be.lt(
                expectedTotalUnderlyingPosition.mul(105).div(100),
              );
            });
          });
        });
      });
    });
  });
}
