import "module-alias/register";

import { Address, Account, TransformInfo, ContractTransaction } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256, ONE, TWO, ZERO } from "@utils/constants";
import {
  CTokenMock,
  IPRebalanceExtension,
  IndexExchangeAdapterMock,
  BaseManagerV2,
  StandardTokenMock,
  TransformHelperMock
} from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAddress,
  getWaffleExpect,
  preciseDiv,
  preciseMul,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("IPRebalanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let allowedCaller: Account;
  let randomCaller: Account;

  let setV2Setup: SetFixture;
  let deployer: DeployHelper;

  let setToken: SetToken;

  let DAI: StandardTokenMock;
  let cDAI: CTokenMock;
  let yDAI: CTokenMock;
  let USDC: StandardTokenMock;
  let cUSDC: CTokenMock;

  let exchangeAdapter: IndexExchangeAdapterMock;
  let compTransformHelper: TransformHelperMock;
  let yearnTransformHelper: TransformHelperMock;

  let baseManagerV2: BaseManagerV2;
  let ipRebalanceExtension: IPRebalanceExtension;

  before(async () => {
    [
      owner,
      operator,
      methodologist,
      allowedCaller,
      randomCaller,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // Setup Component Tokens
    USDC = setV2Setup.usdc;
    DAI = setV2Setup.dai;
    cDAI = await deployer.mocks.deployCTokenMock(18, DAI.address, ether(1.001914841));
    yDAI = await deployer.mocks.deployCTokenMock(18, DAI.address, ether(1.001491489));
    cUSDC = await deployer.mocks.deployCTokenMock(18, USDC.address, ether(1.001914841));

    // Mint cDAI and yDAI
    await DAI.approve(cDAI.address, MAX_UINT_256);
    await DAI.approve(yDAI.address, MAX_UINT_256);
    await cDAI.mint(ether(10000));
    await yDAI.mint(ether(10000));

    // Setup CompoundWrapV2Adapter
    const compoundWrapV2Adapter = await deployer.setV2.deployCompoundWrapV2Adapter();
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModuleV2.address,
      "CompoundWrapV2Adapter",
      compoundWrapV2Adapter.address
    );

    // Setup IndexExchangeAdapterMock
    exchangeAdapter = await deployer.mocks.deployIndexExchangeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.generalIndexModule.address,
      "IndexExchangeAdapterMock",
      exchangeAdapter.address
    );

    // Setup SetToken
    setToken = await setV2Setup.createSetToken(
      [USDC.address, DAI.address, cDAI.address, yDAI.address],
      [ether(25), ether(20), ether(25), ether(30)],
      [setV2Setup.generalIndexModule.address, setV2Setup.issuanceModule.address, setV2Setup.wrapModuleV2.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    await setV2Setup.wrapModuleV2.initialize(
      setToken.address,
      { gasLimit: 2_000_000 }
    );

    await setV2Setup.generalIndexModule.initialize(setToken.address);

    // Issue some set tokens
    await USDC.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await DAI.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await cDAI.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await yDAI.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5.11234), owner.address);

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();
    await setToken.setManager(baseManagerV2.address);

    // Deploy IPRebalanceExtension
    ipRebalanceExtension = await deployer.extensions.deployIPRebalanceExtension(baseManagerV2.address, setV2Setup.generalIndexModule.address);
    await ipRebalanceExtension.connect(operator.wallet).updateCallerStatus([allowedCaller.address], [true]);
    await baseManagerV2.connect(operator.wallet).addExtension(ipRebalanceExtension.address);

    // Deploy TransferHelpers
    compTransformHelper = await deployer.mocks.deployTransformHelperMock(
      await cDAI.exchangeRate(),
      setV2Setup.wrapModuleV2.address,
      "CompoundWrapV2Adapter"
    );
    yearnTransformHelper = await deployer.mocks.deployTransformHelperMock(
      await yDAI.exchangeRate(),
      setV2Setup.wrapModuleV2.address,
      "CompoundWrapV2Adapter"
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectGeneralIndexModule: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectGeneralIndexModule = setV2Setup.generalIndexModule.address;
    });

    async function subject(): Promise<IPRebalanceExtension> {
      return await deployer.extensions.deployIPRebalanceExtension(subjectManager, subjectGeneralIndexModule);
    }

    it("should set the state variables", async () => {
      const extension = await subject();

      expect(await extension.manager()).to.eq(subjectManager);
      expect(await extension.generalIndexModule()).to.eq(subjectGeneralIndexModule);
    });
  });

  describe("#startRebalanceWithUnits", async () => {
    async function subject(): Promise<ContractTransaction> {
      return await ipRebalanceExtension.connect(operator.wallet).startRebalanceWithUnits([], [], ether(1));
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("use startIPRebalance instead");
    });
  });

  describe("#setTransformData", async () => {
    let subjectTransformComponent: Address;
    let subjectTransformInfo: TransformInfo;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTransformComponent = await getRandomAddress();
      subjectTransformInfo = {
        underlyingComponent: await getRandomAddress(),
        transformHelper: await getRandomAddress(),
      };
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return await ipRebalanceExtension.connect(subjectCaller.wallet).setTransformInfo(subjectTransformComponent, subjectTransformInfo);
    }

    it("should set the transform info entry correctly", async () => {
      await subject();

      const transformInfo = await ipRebalanceExtension.transformComponentInfo(subjectTransformComponent);

      expect(transformInfo.underlyingComponent).to.eq(subjectTransformInfo.underlyingComponent);
      expect(transformInfo.transformHelper).to.eq(subjectTransformInfo.transformHelper);
    });

    context("when caller is not operator", async () => {
      beforeEach(() => {
        subjectCaller = randomCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    context("when transform info has already been set", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TransformInfo already set");
      });
    });
  });

  describe("#updateTransformData", async () => {
    let subjectTransformComponent: Address;
    let subjectTransformInfo: TransformInfo;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTransformComponent = await getRandomAddress();
      subjectTransformInfo = {
        underlyingComponent: await getRandomAddress(),
        transformHelper: await getRandomAddress(),
      };
      subjectCaller = operator;

      const originalTransformInfo = {
        underlyingComponent: await getRandomAddress(),
        transformHelper: await getRandomAddress(),
      };
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(subjectTransformComponent, originalTransformInfo);
    });

    async function subject(): Promise<ContractTransaction> {
      return await ipRebalanceExtension.connect(subjectCaller.wallet).updateTransformInfo(subjectTransformComponent, subjectTransformInfo);
    }

    it("should set the transform info entry correctly", async () => {
      await subject();

      const transformInfo = await ipRebalanceExtension.transformComponentInfo(subjectTransformComponent);

      expect(transformInfo.underlyingComponent).to.eq(subjectTransformInfo.underlyingComponent);
      expect(transformInfo.transformHelper).to.eq(subjectTransformInfo.transformHelper);
    });

    context("when caller is not operator", async () => {
      beforeEach(() => {
        subjectCaller = randomCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    context("when transform info has not been set", async () => {
      beforeEach(async () => {
        subjectTransformComponent = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TransformInfo not set yet");
      });
    });
  });

  context("when transform helpers have been properly set", async () => {
    beforeEach(async () => {
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(cDAI.address, {
        underlyingComponent: DAI.address,
        transformHelper: compTransformHelper.address,
      });
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(cUSDC.address, {
        underlyingComponent: USDC.address,
        transformHelper: compTransformHelper.address,
      });
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(yDAI.address, {
        underlyingComponent: DAI.address,
        transformHelper: yearnTransformHelper.address,
      });
    });

    describe("#startIPRebalance", async () => {
      let subjectSetComponents: Address[];
      let subjectTargetUnitsUnderlying: BigNumber[];
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetComponents = [USDC.address, DAI.address, cDAI.address, yDAI.address];
        subjectTargetUnitsUnderlying = [ether(10), ether(15), ether(15), ether(60)];
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await ipRebalanceExtension.connect(subjectCaller.wallet).startIPRebalance(subjectSetComponents, subjectTargetUnitsUnderlying);
      }

      it("should set the number of untransforms", async () => {
        await subject();

        expect(await ipRebalanceExtension.untransforms()).to.eq(1);
      });

      it("should set the untransformUnits", async () => {
        await subject();

        const yDaiUntransformUnits = await ipRebalanceExtension.untransformUnits(yDAI.address);
        const cDaiUntransformUnits = await ipRebalanceExtension.untransformUnits(cDAI.address);

        const cDaiUnits = await setToken.getDefaultPositionRealUnit(cDAI.address);
        const cDaiExchangeRate = await compTransformHelper.getExchangeRate(DAI.address, cDAI.address);
        const targetCDaiUnderlyingUnits = subjectTargetUnitsUnderlying[2];
        const targetCDaiUnits = preciseMul(targetCDaiUnderlyingUnits, cDaiExchangeRate);

        const expectedYDaiUntransformUnits = ZERO;
        const expectedCDaiUntransformUnits = cDaiUnits.sub(targetCDaiUnits);

        expect(yDaiUntransformUnits).to.eq(expectedYDaiUntransformUnits);
        expect(cDaiUntransformUnits).to.eq(expectedCDaiUntransformUnits);
      });

      it("should set the rebalance params", async () => {
        await subject();

        const usdcTargetUnderlying = await ipRebalanceExtension.rebalanceParams(USDC.address);
        const daiTargetUnderlying = await ipRebalanceExtension.rebalanceParams(DAI.address);
        const cDaiTargetUnderlying = await ipRebalanceExtension.rebalanceParams(cDAI.address);
        const yDaiTargetUnderlying = await ipRebalanceExtension.rebalanceParams(yDAI.address);

        expect(usdcTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[0]);
        expect(daiTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[1]);
        expect(cDaiTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[2]);
        expect(yDaiTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[3]);
      });

      it("should set the component list", async () => {
        await subject();

        expect(await ipRebalanceExtension.setComponentList(0)).to.eq(USDC.address);
        expect(await ipRebalanceExtension.setComponentList(1)).to.eq(DAI.address);
        expect(await ipRebalanceExtension.setComponentList(2)).to.eq(cDAI.address);
        expect(await ipRebalanceExtension.setComponentList(3)).to.eq(yDAI.address);
      });

      context("when removing a transform component", async () => {
        beforeEach(() => {
          subjectTargetUnitsUnderlying = [ether(10), ether(15), ether(0), ether(60)];
        });

        it("should set untransformUnits for removed component to max unit256", async () => {
          await subject();

          expect(await ipRebalanceExtension.untransformUnits(cDAI.address)).to.eq(MAX_UINT_256);
        });
      });

      context("when component list and target list lengths don't match", async () => {
        beforeEach(() => {
          subjectSetComponents = [DAI.address];
          subjectTargetUnitsUnderlying = [ether(1), ether(2)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("length mismatch");
        });
      });

      context("when caller is not operator", async () => {
        beforeEach(() => {
          subjectCaller = randomCaller;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when startIPRebalance has been called", async () => {
      beforeEach(async () => {
        const components = [USDC.address, cUSDC.address, DAI.address, cDAI.address, yDAI.address];
        const targetUnitsUnderlying = [ether(0), ether(10), ether(15), ether(15), ether(60)];

        await ipRebalanceExtension.connect(operator.wallet).startIPRebalance(components, targetUnitsUnderlying);
      });

      describe("#batchExecuteUntransform", async () => {
        let subjectTransformComponents: Address[];
        let subjectUntransformData: string[];
        let subjectCaller: Account;

        beforeEach(() => {
          subjectTransformComponents = [cDAI.address];
          subjectUntransformData = [EMPTY_BYTES];
          subjectCaller = allowedCaller;
        });

        async function subject(): Promise<ContractTransaction> {
          return await ipRebalanceExtension.connect(subjectCaller.wallet).batchExecuteUntransform(
            subjectTransformComponents,
            subjectUntransformData
          );
        }

        it("should untransform the correct unit amounts", async () => {
          await subject();

          const expectCDaiUnits = preciseMul(ether(15), await compTransformHelper.exchangeRate());
          const actualCDaiUnits = await setToken.getDefaultPositionRealUnit(cDAI.address);

          expect(actualCDaiUnits).to.eq(expectCDaiUnits);
        });

        it("should decrement the untransforms counter", async () => {
          const initUntransforms = await ipRebalanceExtension.untransforms();
          await subject();
          const finalUntransforms = await ipRebalanceExtension.untransforms();

          expect(initUntransforms.sub(finalUntransforms)).to.eq(ONE);
        });

        it("should set the untransformUnits amount for the component to 0", async () => {
          const initUntransformUnits = await ipRebalanceExtension.untransformUnits(cDAI.address);
          await subject();
          const finalUntransformUnits = await ipRebalanceExtension.untransformUnits(cDAI.address);

          expect(initUntransformUnits).to.not.eq(ZERO);
          expect(finalUntransformUnits).to.eq(ZERO);
        });

        context("when it is the final untransform", async () => {
          it("should initialize the rebalance through the GeneralIndexModule", async () => {
            await subject();

            const daiTargetUnits = (await setV2Setup.generalIndexModule.executionInfo(setToken.address, DAI.address)).targetUnit;
            const usdcTargetUnits = (await setV2Setup.generalIndexModule.executionInfo(setToken.address, USDC.address)).targetUnit;
            const cDaiTargetUnits = (await setV2Setup.generalIndexModule.executionInfo(setToken.address, cDAI.address)).targetUnit;
            const yDaiTargetUnits = (await setV2Setup.generalIndexModule.executionInfo(setToken.address, yDAI.address)).targetUnit;
            const cUsdcTargetUnits = (await setV2Setup.generalIndexModule.executionInfo(setToken.address, cUSDC.address)).targetUnit;

            const yDaiExchangeRate = await yearnTransformHelper.getExchangeRate(DAI.address, yDAI.address);

            const expectedDaiUnits = ether(15 + 60)                         // cDaiUnderlyingEnd + yDaiUnderlyingEnd
              .sub(ether(15).add(preciseDiv(ether(30), yDaiExchangeRate)))  // cDaiUnderlyingCurrent + yDaiUnderlyingCurrent
              .add(ether(15));                                              // daiFinal

            expect(cDaiTargetUnits).to.eq(await setToken.getDefaultPositionRealUnit(cDAI.address));
            expect(yDaiTargetUnits).to.eq(await setToken.getDefaultPositionRealUnit(yDAI.address));
            expect(cUsdcTargetUnits).to.eq(await setToken.getDefaultPositionRealUnit(cUSDC.address));
            expect(usdcTargetUnits).to.eq(ether(10));
            expect(daiTargetUnits).to.eq(expectedDaiUnits);
          });
        });

        context("when removing a transform component", async () => {
          beforeEach(async () => {
            const components = [USDC.address, DAI.address, cDAI.address, yDAI.address];
            const targetUnitsUnderlying = [ether(10), ether(15), ether(0), ether(60)];

            await ipRebalanceExtension.connect(operator.wallet).startIPRebalance(components, targetUnitsUnderlying);
          });

          it("should untransform all units of the component", async () => {
            await subject();

            expect(await setToken.getDefaultPositionRealUnit(cDAI.address)).to.eq(ZERO);
          });
        });

        context("when caller is not an allowed caller", async () => {
          beforeEach(() => {
            subjectCaller = randomCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });

        context("when transformComponents and untransformData lengths do not match", async () => {
          beforeEach(() => {
            subjectUntransformData = [EMPTY_BYTES, EMPTY_BYTES];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("length mismatch");
          });
        });

        context("when component should not be untransformed", async () => {
          beforeEach(async () => {
            subjectTransformComponents = [USDC.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("nothing to untransform");
          });
        });

        context("when shouldUntransform is false", async () => {
          beforeEach(async () => {
            await compTransformHelper.setShouldTransformUntransform(false);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("untransform unavailable");
          });
        });
      });

      context("when final untransform is complete", async () => {
        beforeEach(async () => {
          await ipRebalanceExtension.connect(allowedCaller.wallet).batchExecuteUntransform(
            [cDAI.address],
            [EMPTY_BYTES]
          );
        });

        context("when trading is complete", async () => {
          beforeEach(async () => {
            await ipRebalanceExtension.connect(operator.wallet).setTraderStatus(
              [allowedCaller.address],
              [true]
            );
            await ipRebalanceExtension.connect(operator.wallet).setTradeMaximums(
              [DAI.address, USDC.address],
              [MAX_UINT_256, MAX_UINT_256]
            );
            await ipRebalanceExtension.connect(operator.wallet).setExchanges(
              [DAI.address, USDC.address],
              ["IndexExchangeAdapterMock", "IndexExchangeAdapterMock"]
            );

            await setV2Setup.weth.transfer(exchangeAdapter.address, ether(1.1));
            await setV2Setup.generalIndexModule.connect(allowedCaller.wallet).trade(setToken.address, USDC.address, MAX_UINT_256);

            const currentDai = await DAI.balanceOf(setToken.address);
            const targetDaiUnit = (await setV2Setup.generalIndexModule.executionInfo(setToken.address, DAI.address)).targetUnit;
            const targetDai = preciseMul(targetDaiUnit, await setToken.totalSupply());
            const daiDiff = targetDai.sub(currentDai);
            await DAI.transfer(exchangeAdapter.address, daiDiff);
            await setV2Setup.generalIndexModule.connect(allowedCaller.wallet).tradeRemainingWETH(setToken.address, DAI.address, daiDiff);
          });

          describe("#setTradesComplete", async () => {
            let subjectCaller: Account;

            beforeEach(() => {
              subjectCaller = operator;
            });

            async function subject(): Promise<ContractTransaction> {
              return await ipRebalanceExtension.connect(subjectCaller.wallet).setTradesComplete();
            }

            it("should set the number of transforms", async () => {
              await subject();

              expect(await ipRebalanceExtension.transforms()).to.eq(TWO);
            });

            it("should set the transformUnits", async () => {
              await subject();

              const targetYDaiUnitsUnderlying = ether(60);
              const currentYDaiUnits = await setToken.getDefaultPositionRealUnit(yDAI.address);
              const exchangeRate = await yearnTransformHelper.getExchangeRate(DAI.address, yDAI.address);
              const currentYDaiUnitsUnderlying = preciseDiv(currentYDaiUnits, exchangeRate);
              const expectedTransformUnits = targetYDaiUnitsUnderlying.sub(currentYDaiUnitsUnderlying);

              expect(await ipRebalanceExtension.transformUnits(yDAI.address)).to.eq(expectedTransformUnits);
            });

            context("when caller is not operator", async () => {
              beforeEach(() => {
                subjectCaller = randomCaller;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Must be operator");
              });
            });
          });

          context("when setTradesComplete has been called", async () => {
            beforeEach(async () => {
              await ipRebalanceExtension.connect(operator.wallet).setTradesComplete();
            });

            describe("#batchExecuteTransform", async () => {
              let subjectTransformComponents: Address[];
              let subjectTransformData: string[];
              let subjectCaller: Account;

              beforeEach(() => {
                subjectTransformComponents = [yDAI.address];
                subjectTransformData = [EMPTY_BYTES];
                subjectCaller = allowedCaller;
              });

              async function subject(): Promise<ContractTransaction> {
                return await ipRebalanceExtension.connect(subjectCaller.wallet).batchExecuteTransform(
                  subjectTransformComponents,
                  subjectTransformData
                );
              }

              it("should transform the correct unit amounts", async () => {
                await subject();

                const targetYDaiUnderlyingUnits = ether(60);
                const exchangeRate = await yearnTransformHelper.getExchangeRate(DAI.address, yDAI.address);
                const expectedYDaiUnits = preciseMul(targetYDaiUnderlyingUnits, exchangeRate);

                const currentYDaiUnits = await setToken.getDefaultPositionRealUnit(yDAI.address);

                expect(currentYDaiUnits).to.eq(expectedYDaiUnits);
              });

              it("should decrement the transforms counter", async () => {
                const initTransforms = await ipRebalanceExtension.transforms();
                await subject();
                const finalTransforms = await ipRebalanceExtension.transforms();

                expect(initTransforms.sub(finalTransforms)).to.eq(ONE);
              });

              it("should set the transform amount for the component to 0", async () => {
                const initTransformUnits = await ipRebalanceExtension.transformUnits(yDAI.address);
                await subject();
                const finalTransformUnits = await ipRebalanceExtension.transformUnits(yDAI.address);

                expect(initTransformUnits).to.not.eq(ZERO);
                expect(finalTransformUnits).to.eq(ZERO);
              });

              context("when it is the final transform", async () => {
                beforeEach(async () => {
                  await subject();
                  subjectTransformComponents = [cUSDC.address];
                });

                it("should set tradesComplete to false", async () => {
                  await subject();

                  expect(await ipRebalanceExtension.tradesComplete()).to.eq(false);
                });

                it("should have the correct component units", async () => {
                  await subject();

                  const cDaiUnits = await setToken.getDefaultPositionRealUnit(cDAI.address);
                  const cDaiExchangeRate = await compTransformHelper.getExchangeRate(DAI.address, cDAI.address);
                  const cDaiUnderlyingUnits = preciseDiv(cDaiUnits, cDaiExchangeRate);

                  const cUsdcUnits = await setToken.getDefaultPositionRealUnit(cUSDC.address);
                  const cUsdcExchangeRate = await compTransformHelper.getExchangeRate(DAI.address, cUSDC.address);
                  const cUsdcUnderlyingUnits = preciseDiv(cUsdcUnits, cUsdcExchangeRate);

                  const yDaiUnits = await setToken.getDefaultPositionRealUnit(yDAI.address);
                  const yDaiExchangeRate = await yearnTransformHelper.getExchangeRate(DAI.address, yDAI.address);
                  const yDaiUnderlyingUnits = preciseDiv(yDaiUnits, yDaiExchangeRate);

                  const daiUnits = await setToken.getDefaultPositionRealUnit(DAI.address);
                  const usdcUnits = await setToken.getDefaultPositionRealUnit(USDC.address);

                  // TODO: investigate rounding error
                  expect(daiUnits).to.eq(ether(15).sub(2));
                  expect(usdcUnits).to.eq(ether(0));
                  expect(cDaiUnderlyingUnits).to.eq(ether(15));
                  expect(yDaiUnderlyingUnits).to.eq(ether(60));
                  expect(cUsdcUnderlyingUnits).to.eq(ether(10));
                });
              });

              context("when caller is not an allowed caller", async () => {
                beforeEach(() => {
                  subjectCaller = randomCaller;
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("Address not permitted to call");
                });
              });

              context("when transformComponents and transformData lengths do not match", async () => {
                beforeEach(() => {
                  subjectTransformData = [EMPTY_BYTES, EMPTY_BYTES];
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("length mismatch");
                });
              });

              context("when component should not be transformed", async () => {
                beforeEach(async () => {
                  subjectTransformComponents = [USDC.address];
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("nothing to transform");
                });
              });

              context("when shouldTransform is false", async () => {
                beforeEach(async () => {
                  await yearnTransformHelper.setShouldTransformUntransform(false);
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("transform unavailable");
                });
              });
            });
          });
        });
      });
    });
  });
});