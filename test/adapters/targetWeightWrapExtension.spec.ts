import "module-alias/register";

import DeployHelper from "@utils/deploys";
import { SetFixture } from "@utils/fixtures";
import { SetToken } from "@utils/contracts/setV2";
import {
  BaseManagerV2,
  TargetWeightWrapExtension,
  WrapAdapterMock,
} from "@utils/contracts/index";
import { Account, Address, CustomOracleNAVIssuanceSettings, TargetWeightWrapParams } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getWaffleExpect,
  preciseDiv,
} from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

const INITIAL_WETH_UNITS = ether(0.5);
const INITIAL_WRAPPED_UNITS = ether(0.5);
const INITIAL_SUPPLY = ether(10);

describe("TargetWeightWrapExtension", async () => {
  let owner: Account;
  let operator: Account;
  let feeRecipient: Account;

  let deployer: DeployHelper;
  let setV2Setup: SetFixture;

  let setToken: SetToken;
  let baseManager: BaseManagerV2;
  let targetWeightWrapExtension: TargetWeightWrapExtension;

  let wrapAdapter: WrapAdapterMock;
  let wrapAdapterName: string;

  before(async () => {
    [
      owner,
      operator,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // setup mock wrap adapter
    wrapAdapter = await deployer.mocks.deployWrapAdapterMock(owner.address, ether(1000));
    await owner.wallet.sendTransaction({ to: wrapAdapter.address, value: ether(1000) });
    wrapAdapterName = "WRAP_ADAPTER";
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModule.address,
      wrapAdapterName,
      wrapAdapter.address
    );
    const preciseUnitOracle = await deployer.setV2.deployPreciseUnitOracle("Rebasing WETH Oracle");
    await setV2Setup.priceOracle.addAdapter(preciseUnitOracle.address);
    await setV2Setup.priceOracle.addPair(setV2Setup.weth.address, setV2Setup.weth.address, preciseUnitOracle.address);
    await setV2Setup.priceOracle.addPair(wrapAdapter.address, setV2Setup.weth.address, preciseUnitOracle.address);
    await setV2Setup.priceOracle.editMasterQuoteAsset(setV2Setup.weth.address);

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address, wrapAdapter.address],
      [INITIAL_WETH_UNITS, INITIAL_WRAPPED_UNITS],
      [setV2Setup.wrapModule.address, setV2Setup.issuanceModule.address, setV2Setup.navIssuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    const navIssuanceSettings = {
      managerIssuanceHook: ADDRESS_ZERO,
      managerRedemptionHook: ADDRESS_ZERO,
      setValuer: setV2Setup.setValuer.address,
      reserveAssets: [setV2Setup.weth.address],
      feeRecipient: feeRecipient.address,
      managerFees: [ether(0.001), ether(0.002)],
      maxManagerFee: ether(0.02),
      premiumPercentage: ether(0.01),
      maxPremiumPercentage: ether(0.1),
      minSetTokenSupply: ether(5),
    } as CustomOracleNAVIssuanceSettings;

    await setV2Setup.navIssuanceModule.initialize(
      setToken.address,
      navIssuanceSettings
    );

    // Basic issue some set tokens
    await setV2Setup.weth.approve(wrapAdapter.address, MAX_UINT_256);
    await wrapAdapter.mint(setV2Setup.weth.address, INITIAL_SUPPLY);
    await wrapAdapter.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.weth.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, INITIAL_SUPPLY, owner.address);

    // Deploy BaseManager
    baseManager = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      operator.address
    );
    await baseManager.connect(operator.wallet).authorizeInitialization();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectWrapModule: Address;
    let subjectSetValuer: Address;
    let subjectWeth: Address;
    let subjectIsAnyoneAllowedToRebalance: boolean;

    beforeEach(async () => {
      subjectManager = baseManager.address;
      subjectWrapModule = setV2Setup.wrapModule.address;
      subjectSetValuer = setV2Setup.setValuer.address;
      subjectWeth = setV2Setup.weth.address;
      subjectIsAnyoneAllowedToRebalance = false;
    });

    async function subject(): Promise<TargetWeightWrapExtension> {
      return await deployer.extensions.deployTargetWeightWrapExtension(
        subjectManager,
        subjectWrapModule,
        subjectSetValuer,
        subjectWeth,
        subjectIsAnyoneAllowedToRebalance
      );
    }

    it("should set the correct set token address", async () => {
      const wrapExtension = await subject();

      const actualSetToken = await wrapExtension.setToken();
      expect(actualSetToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const wrapExtension = await subject();

      const manager = await wrapExtension.manager();
      expect(manager).to.eq(subjectManager);
    });

    it("should set the correct wrap module address", async () => {
      const wrapExtension = await subject();

      const wrapModule = await wrapExtension.wrapModule();
      expect(wrapModule).to.eq(subjectWrapModule);
    });

    it("should set the correct set valuer address", async () => {
      const wrapExtension = await subject();

      const setValuer = await wrapExtension.setValuer();
      expect(setValuer).to.eq(subjectSetValuer);
    });

    it("should set the correct weth address", async () => {
      const wrapExtension = await subject();

      const weth = await wrapExtension.weth();
      expect(weth).to.eq(subjectWeth);
    });

    it("should set the correct rebalancing permissions", async () => {
      const wrapExtension = await subject();

      const isAnyoneAllowedToRebalance = await wrapExtension.isAnyoneAllowedToRebalance();
      expect(isAnyoneAllowedToRebalance).to.eq(subjectIsAnyoneAllowedToRebalance);
    });
  });

  context("when target weight wrap extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      targetWeightWrapExtension = await deployer.extensions.deployTargetWeightWrapExtension(
        baseManager.address,
        setV2Setup.wrapModule.address,
        setV2Setup.setValuer.address,
        setV2Setup.weth.address,
        false
      );

      await baseManager.connect(operator.wallet).addExtension(targetWeightWrapExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManager.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await targetWeightWrapExtension.connect(subjectCaller.wallet).initialize();
      }

      it("should initialize WrapModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.wrapModule.address);
        expect(isInitialized).to.be.true;
      });

      context("when the operator is not the caller", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when target wrap extension is deployed and initialized", async () => {
      beforeEach(async () => {
        await targetWeightWrapExtension.connect(operator.wallet).initialize();
      });

      describe("#setTargetWeights", async () => {
        let subjectReserveAsset: Address;
        let subjectMinReserveWeight: BigNumber;
        let subjectMaxReserveWeight: BigNumber;
        let subjectTargetAssets: Address[];
        let subjectExecutionParams: TargetWeightWrapParams[];
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectReserveAsset = setV2Setup.weth.address;
          subjectMinReserveWeight = ether(0.45);
          subjectMaxReserveWeight = ether(0.55);
          subjectTargetAssets = [wrapAdapter.address];
          subjectExecutionParams = [
            {
              minTargetWeight: ether(0.45),
              maxTargetWeight: ether(0.55),
              wrapAdapterName: wrapAdapterName,
            } as TargetWeightWrapParams,
          ];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await targetWeightWrapExtension.connect(subjectCaller.wallet).setTargetWeights(
            subjectReserveAsset,
            subjectMinReserveWeight,
            subjectMaxReserveWeight,
            subjectTargetAssets,
            subjectExecutionParams
          );
        }

        it("should set isRebalancing to true", async () => {
          await subject();
          expect(await targetWeightWrapExtension.isRebalancing()).to.be.true;
        });

        it("should set the rebalanceInfo", async () => {
          await subject();

          const rebalanceInfo = await targetWeightWrapExtension.rebalanceInfo();
          const targetAssets = await targetWeightWrapExtension.getTargetAssets();
          expect(rebalanceInfo.reserveAsset).to.eq(subjectReserveAsset);
          expect(rebalanceInfo.minReserveWeight).to.eq(subjectMinReserveWeight);
          expect(rebalanceInfo.maxReserveWeight).to.eq(subjectMaxReserveWeight);
          expect(targetAssets).to.deep.eq(subjectTargetAssets);
        });

        it("should set the target weight wrap parameters", async () => {
          await subject();

          const executionParams = await targetWeightWrapExtension.executionParams(subjectTargetAssets[0]);
          expect(executionParams.minTargetWeight).to.eq(subjectExecutionParams[0].minTargetWeight);
          expect(executionParams.maxTargetWeight).to.eq(subjectExecutionParams[0].maxTargetWeight);
          expect(executionParams.wrapAdapterName).to.eq(subjectExecutionParams[0].wrapAdapterName);
        });

        context("when the operator is not the caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#suspendRebalance", () => {
        let subjectCaller: Account;

        function subject() {
          return targetWeightWrapExtension.connect(subjectCaller.wallet).suspendRebalance();
        }
        beforeEach(async () => {
          subjectCaller = operator;
        });

        it("should suspend the rebalance", async () => {
          await subject();

          expect(await targetWeightWrapExtension.isRebalancing()).to.be.false;
        });

        context("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = feeRecipient;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setIsAnyoneAllowedToRebalance", () => {
        let subjectCaller: Account;
        let subjectIsAnyoneAllowedToRebalance: boolean;

        function subject() {
          return targetWeightWrapExtension.connect(subjectCaller.wallet).setIsAnyoneAllowedToRebalance(subjectIsAnyoneAllowedToRebalance);
        }
        beforeEach(async () => {
          subjectCaller = operator;
        });
        [true, false].forEach((isAnyoneAllowedToRebalance: boolean) => {
          describe(`when setting value to ${isAnyoneAllowedToRebalance}`, () => {
            beforeEach(async () => {
              subjectIsAnyoneAllowedToRebalance = isAnyoneAllowedToRebalance;
              await targetWeightWrapExtension
                .connect(operator.wallet)
                .setIsAnyoneAllowedToRebalance(!isAnyoneAllowedToRebalance);
            });

            it("should update isAnyoneAllowedToRebalance correctly", async () => {
              await subject();
              const actualIsAnyoneAllowedToRebalance = await targetWeightWrapExtension.isAnyoneAllowedToRebalance();
              expect(actualIsAnyoneAllowedToRebalance).to.eq(subjectIsAnyoneAllowedToRebalance);
            });
          });
        });

        context("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = feeRecipient;
            subjectIsAnyoneAllowedToRebalance = false;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      context("when targets are set", async () => {
        beforeEach(async () => {
          await targetWeightWrapExtension.connect(operator.wallet).setTargetWeights(
            setV2Setup.weth.address,
            ether(0.45),
            ether(0.55),
            [wrapAdapter.address],
            [
              {
                minTargetWeight: ether(0.40),
                maxTargetWeight: ether(0.60),
                wrapAdapterName: wrapAdapterName,
              } as TargetWeightWrapParams,
            ]
          );
        });

        describe("#getValuationReserveAsset", async () => {
          async function subject(): Promise<Address> {
            return await targetWeightWrapExtension.getValuationReserveAsset();
          }

          it("should return the correct valuation reserve asset", async () => {
            const actualValuationReserveAsset = await subject();
            expect(actualValuationReserveAsset).to.eq(setV2Setup.weth.address);
          });

          context("when the underlying asset is Ether", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).setTargetWeights(
                await targetWeightWrapExtension.ETH_ADDRESS(),
                ether(0.45),
                ether(0.55),
                [wrapAdapter.address],
                [
                  {
                    minTargetWeight: ether(0.40),
                    maxTargetWeight: ether(0.60),
                    wrapAdapterName: wrapAdapterName,
                  } as TargetWeightWrapParams,
                ]
              );
            });

            it("should return the weth as the valuation reserve asset", async () => {
              const actualValuationReserveAsset = await subject();
              expect(actualValuationReserveAsset).to.eq(setV2Setup.weth.address);
            });
          });

          context("when the underlying asset is USDC", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).setTargetWeights(
                setV2Setup.usdc.address,
                ether(0.45),
                ether(0.55),
                [wrapAdapter.address],
                [
                  {
                    minTargetWeight: ether(0.40),
                    maxTargetWeight: ether(0.60),
                    wrapAdapterName: wrapAdapterName,
                  } as TargetWeightWrapParams,
                ]
              );
            });

            it("should return the weth as the valuation reserve asset", async () => {
              const actualValuationReserveAsset = await subject();
              expect(actualValuationReserveAsset).to.eq(setV2Setup.usdc.address);
            });
          });
        });

        describe("#getReserveValuation", async () => {
          async function subject(): Promise<BigNumber> {
            return await targetWeightWrapExtension.getReserveValuation();
          }

          it("should return the correct reserve valuation", async () => {
            const reserveValuation = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
            const actualReserveValuation = await subject();
            expect(actualReserveValuation).to.eq(reserveValuation);
            expect(actualReserveValuation).to.eq(INITIAL_WETH_UNITS);
          });

          context("when a NAV issuance occurs", async () => {
            beforeEach(async () => {
              await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);
            });

            it("should return the correct reserve valuation", async () => {
              const reserveValuation = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
              const actualReserveValuation = await subject();
              expect(actualReserveValuation).to.eq(reserveValuation);
              expect(actualReserveValuation).to.gt(INITIAL_WETH_UNITS);
            });
          });

          context("when a NAV redemption occurs", async () => {
            beforeEach(async () => {
              await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);
            });

            it("should return the correct reserve valuation", async () => {
              const reserveValuation = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
              const actualReserveValuation = await subject();
              expect(actualReserveValuation).to.eq(reserveValuation);
              expect(actualReserveValuation).to.lt(INITIAL_WETH_UNITS);
            });
          });
        });

        describe("#getTargetAssetValuation", async () => {
          let subjectTargetAsset: Address;

          beforeEach(async () => {
            subjectTargetAsset = wrapAdapter.address;
          });

          async function subject(): Promise<BigNumber> {
            return await targetWeightWrapExtension.getTargetAssetValuation(subjectTargetAsset);
          }

          it("should return the correct target asset valuation", async () => {
            const targetValuation = await setToken.getDefaultPositionRealUnit(wrapAdapter.address);
            const actualTargetValuation = await subject();
            expect(actualTargetValuation).to.eq(targetValuation);
          });

          context("when a NAV issuance occurs", async () => {
            beforeEach(async () => {
              await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);
            });

            it("should return the correct target asset valuation", async () => {
              const targetValuation = await setToken.getDefaultPositionRealUnit(wrapAdapter.address);
              const actualTargetValuation = await subject();
              expect(actualTargetValuation).to.eq(targetValuation);
              expect(actualTargetValuation).to.lt(INITIAL_WRAPPED_UNITS);
            });
          });

          context("when a NAV redemption occurs", async () => {
            beforeEach(async () => {
              await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);
            });

            it("should return the correct target asset valuation", async () => {
              const targetValuation = await setToken.getDefaultPositionRealUnit(wrapAdapter.address);
              const actualTargetValuation = await subject();
              expect(actualTargetValuation).to.eq(targetValuation);
              expect(actualTargetValuation).to.gt(INITIAL_WRAPPED_UNITS);
            });
          });
        });

        describe("#getTotalValuation", async () => {
          async function subject(): Promise<BigNumber> {
            return await targetWeightWrapExtension.getTotalValuation();
          }

          it("should return the correct total valuation", async () => {
            const reserveValuation = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
            const targetValuation = await setToken.getDefaultPositionRealUnit(wrapAdapter.address);
            const totalValuation = reserveValuation.add(targetValuation);

            const actualTotalValuation = await subject();

            expect(actualTotalValuation).to.eq(totalValuation);
          });

          context("when a NAV issuance occurs", async () => {
            beforeEach(async () => {
              await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);
            });

            it("should return the correct total valuation", async () => {
              const reserveValuation = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
              const targetValuation = await setToken.getDefaultPositionRealUnit(wrapAdapter.address);
              const totalValuation = reserveValuation.add(targetValuation);

              const actualTotalValuation = await subject();

              expect(actualTotalValuation).to.eq(totalValuation);
              expect(actualTotalValuation).to.gte(INITIAL_WETH_UNITS.add(INITIAL_WRAPPED_UNITS));
            });
          });

          context("when a NAV redemption occurs", async () => {
            beforeEach(async () => {
              await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);
            });

            it("should return the correct total valuation", async () => {
              const reserveValuation = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
              const targetValuation = await setToken.getDefaultPositionRealUnit(wrapAdapter.address);
              const totalValuation = reserveValuation.add(targetValuation);

              const actualTotalValuation = await subject();

              expect(actualTotalValuation).to.eq(totalValuation);
              expect(actualTotalValuation).to.gte(INITIAL_WETH_UNITS.add(INITIAL_WRAPPED_UNITS));
            });
          });
        });

        describe("#getReserveWeight", async () => {
          async function subject(): Promise<BigNumber> {
            return await targetWeightWrapExtension.getReserveWeight();
          }

          it("should return the correct reserve weight", async () => {
            const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
            const targetBalance = await wrapAdapter.balanceOf(setToken.address);
            const totalBalance = reserveBalance.add(targetBalance);

            const reserveWeight = preciseDiv(reserveBalance, totalBalance);

            const actualReserveWeight = await subject();

            expect(actualReserveWeight).to.eq(reserveWeight);
          });

          context("when a NAV issuance occurs", async () => {
            beforeEach(async () => {
              await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);
            });

            it("should return the correct reserve weight", async () => {
              const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
              const targetBalance = await wrapAdapter.balanceOf(setToken.address);
              const totalBalance = reserveBalance.add(targetBalance);

              const reserveWeight = preciseDiv(reserveBalance, totalBalance);

              const actualReserveWeight = await subject();

              expect(actualReserveWeight).to.eq(reserveWeight);
              expect(actualReserveWeight).to.be.gt(preciseDiv(INITIAL_WETH_UNITS, INITIAL_WETH_UNITS.add(INITIAL_WRAPPED_UNITS)));
            });
          });

          context("when a NAV redemption occurs", async () => {
            beforeEach(async () => {
              await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);
            });

            it("should return the correct reserve weight", async () => {
              const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
              const targetBalance = await wrapAdapter.balanceOf(setToken.address);
              const totalBalance = reserveBalance.add(targetBalance);

              const reserveWeight = preciseDiv(reserveBalance, totalBalance);

              const actualReserveWeight = await subject();

              expect(actualReserveWeight).to.eq(reserveWeight);
              expect(actualReserveWeight).to.be.lt(preciseDiv(INITIAL_WETH_UNITS, INITIAL_WETH_UNITS.add(INITIAL_WRAPPED_UNITS)));
            });
          });
        });

        describe("#getTargetAssetWeight", async () => {
          let subjectTargetAsset: Address;

          beforeEach(async () => {
            subjectTargetAsset = wrapAdapter.address;
          });

          async function subject(): Promise<BigNumber> {
            return await targetWeightWrapExtension.getTargetAssetWeight(subjectTargetAsset);
          }

          it("should return the correct target asset weight", async () => {
            const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
            const targetBalance = await wrapAdapter.balanceOf(setToken.address);
            const totalBalance = reserveBalance.add(targetBalance);

            const targetWeight = preciseDiv(targetBalance, totalBalance);

            const actualTargetWeight = await subject();

            expect(actualTargetWeight).to.eq(targetWeight);
          });

          context("when a NAV issuance occurs", async () => {
            beforeEach(async () => {
              await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);
            });

            it("should return the correct target asset weight", async () => {
              const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
              const targetBalance = await wrapAdapter.balanceOf(setToken.address);
              const totalBalance = reserveBalance.add(targetBalance);

              const targetWeight = preciseDiv(targetBalance, totalBalance);

              const actualTargetWeight = await subject();

              expect(actualTargetWeight).to.eq(targetWeight);
              expect(actualTargetWeight).to.be.lt(preciseDiv(INITIAL_WRAPPED_UNITS, INITIAL_WETH_UNITS.add(INITIAL_WRAPPED_UNITS)));
            });
          });

          context("when a NAV redemption occurs", async () => {
            beforeEach(async () => {
              await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);
            });

            it("should return the correct target asset weight", async () => {
              const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
              const targetBalance = await wrapAdapter.balanceOf(setToken.address);
              const totalBalance = reserveBalance.add(targetBalance);

              const targetWeight = preciseDiv(targetBalance, totalBalance);

              const actualTargetWeight = await subject();

              expect(actualTargetWeight).to.eq(targetWeight);
              expect(actualTargetWeight).to.be.gt(preciseDiv(INITIAL_WRAPPED_UNITS, INITIAL_WETH_UNITS.add(INITIAL_WRAPPED_UNITS)));
            });
          });
        });

        describe("#getTargetAssetAndReserveWeight", async () => {
          let subjectTargetAsset: Address;

          beforeEach(async () => {
            subjectTargetAsset = wrapAdapter.address;
          });

          async function subject(): Promise<[BigNumber, BigNumber]> {
            return await targetWeightWrapExtension.getTargetAssetAndReserveWeight(subjectTargetAsset);
          }

          it("should return the correct weights", async () => {
            const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
            const targetBalance = await wrapAdapter.balanceOf(setToken.address);
            const totalBalance = reserveBalance.add(targetBalance);

            const reserveWeight = preciseDiv(reserveBalance, totalBalance);
            const targetWeight = preciseDiv(targetBalance, totalBalance);

            const [actualTargetWeight, actualReserveWeight] = await subject();

            expect(actualReserveWeight).to.eq(reserveWeight);
            expect(actualTargetWeight).to.eq(targetWeight);
          });

          context("when a NAV issuance occurs", async () => {
            beforeEach(async () => {
              await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);
            });

            it("should return the correct weights", async () => {
              const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
              const targetBalance = await wrapAdapter.balanceOf(setToken.address);
              const totalBalance = reserveBalance.add(targetBalance);

              const reserveWeight = preciseDiv(reserveBalance, totalBalance);
              const targetWeight = preciseDiv(targetBalance, totalBalance);

              const [actualTargetWeight, actualReserveWeight] = await subject();

              expect(actualReserveWeight).to.eq(reserveWeight);
              expect(actualTargetWeight).to.eq(targetWeight);

              expect(actualReserveWeight.sub(INITIAL_WETH_UNITS)).to.be.gte(actualTargetWeight.sub(INITIAL_WRAPPED_UNITS));
            });
          });

          context("when a NAV redemption occurs", async () => {
            beforeEach(async () => {
              await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
              await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);
            });

            it("should return the correct weights", async () => {
              const reserveBalance = await setV2Setup.weth.balanceOf(setToken.address);
              const targetBalance = await wrapAdapter.balanceOf(setToken.address);
              const totalBalance = reserveBalance.add(targetBalance);

              const reserveWeight = preciseDiv(reserveBalance, totalBalance);
              const targetWeight = preciseDiv(targetBalance, totalBalance);

              const [actualTargetWeight, actualReserveWeight] = await subject();

              expect(actualReserveWeight).to.eq(reserveWeight);
              expect(actualTargetWeight).to.eq(targetWeight);

              expect(actualTargetWeight.sub(INITIAL_WRAPPED_UNITS)).to.be.gte(actualReserveWeight.sub(INITIAL_WETH_UNITS));
            });
          });
        });

        describe("#getTargetAssets", async () => {
          async function subject(): Promise<any> {
            return await targetWeightWrapExtension.getTargetAssets();
          }

          it("should return the correct target assets", async () => {
            const targetAssets = await subject();
            expect(targetAssets).to.deep.eq([wrapAdapter.address]);
          });
        });

        describe("#wrap", async () => {
          let subjectTargetAsset: Address;
          let subjectReserveUnits: BigNumber;
          let subjectCaller: Account;

          beforeEach(async () => {
            await setV2Setup.weth.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
            await setV2Setup.navIssuanceModule.issue(setToken.address, setV2Setup.weth.address, INITIAL_SUPPLY, ZERO, owner.address);

            subjectTargetAsset = wrapAdapter.address;
            subjectReserveUnits = ether(0.25);
            subjectCaller = operator;
          });

          async function subject(): Promise<any> {
            return await targetWeightWrapExtension.connect(subjectCaller.wallet).wrap(
              subjectTargetAsset,
              subjectReserveUnits
            );
          }

          it("should wrap the correct number of units", async () => {
            const targetAssetPositionUnitsBefore = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
            const reservePositionUnitsBefore = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

            await subject();

            const targetAssetPositionUnitsAfter = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
            const reservePositionUnitsAfter = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

            const targetAssetPositionUnitChange = targetAssetPositionUnitsAfter.sub(targetAssetPositionUnitsBefore);
            const reservePositionUnitChange = reservePositionUnitsBefore.sub(reservePositionUnitsAfter);

            // 2 wei tolerance
            expect(targetAssetPositionUnitChange).to.be.gte(subjectReserveUnits.sub(2));
            expect(targetAssetPositionUnitChange).to.be.lte(subjectReserveUnits.add(2));
            expect(reservePositionUnitChange).to.be.gte(subjectReserveUnits.sub(2));
            expect(reservePositionUnitChange).to.be.lte(subjectReserveUnits.add(2));
          });

          context("when the underlying asset is Ether", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).setTargetWeights(
                await targetWeightWrapExtension.ETH_ADDRESS(),
                ether(0.45),
                ether(0.55),
                [wrapAdapter.address],
                [
                  {
                    minTargetWeight: ether(0.40),
                    maxTargetWeight: ether(0.60),
                    wrapAdapterName: wrapAdapterName,
                  } as TargetWeightWrapParams,
                ]
              );
            });

            it("should wrap the correct number of units", async () => {
              const targetAssetPositionUnitsBefore = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
              const reservePositionUnitsBefore = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

              await subject();

              const targetAssetPositionUnitsAfter = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
              const reservePositionUnitsAfter = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

              const targetAssetPositionUnitChange = targetAssetPositionUnitsAfter.sub(targetAssetPositionUnitsBefore);
              const reservePositionUnitChange = reservePositionUnitsBefore.sub(reservePositionUnitsAfter);

              // 2 wei tolerance
              expect(targetAssetPositionUnitChange).to.be.gte(subjectReserveUnits.sub(2));
              expect(targetAssetPositionUnitChange).to.be.lte(subjectReserveUnits.add(2));
              expect(reservePositionUnitChange).to.be.gte(subjectReserveUnits.sub(2));
              expect(reservePositionUnitChange).to.be.lte(subjectReserveUnits.add(2));
            });
          });

          context("when isRebalancing is false", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).suspendRebalance();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Rebalancing must be enabled");
            });
          });

          context("when the targetAsset is not in the rebalance", async () => {
            beforeEach(async () => {
              subjectTargetAsset = setV2Setup.weth.address;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Target asset must be in rebalance");
            });
          });

          context("when the target asset is overweight after", async () => {
            beforeEach(async () => {
              subjectReserveUnits = ether(0.5);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Target asset must be not be overweight after");
            });
          });

          context("when the reserve asset is underweight after", async () => {
            beforeEach(async () => {
              subjectReserveUnits = ether(0.35);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Reserve must be not be underweight after");
            });
          });

          context("when the operator is not the caller and isAnyoneAllowedToRebalance is false", async () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be allowed rebalancer");
            });
          });

          context("when the operator is not the caller and isAnyoneAllowedToRebalance is true", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).setIsAnyoneAllowedToRebalance(true);
              subjectCaller = await getRandomAccount();
            });

            it("should not revert", async () => {
              await expect(subject()).to.not.be.reverted;
            });
          });
        });

        describe("#unwrap", async () => {
          let subjectTargetAsset: Address;
          let subjectTargetUnits: BigNumber;
          let subjectCaller: Account;

          beforeEach(async () => {
            await setToken.approve(setV2Setup.navIssuanceModule.address, MAX_UINT_256);
            await setV2Setup.navIssuanceModule.redeem(setToken.address, setV2Setup.weth.address, preciseDiv(INITIAL_SUPPLY, ether(2)), ZERO, owner.address);

            subjectTargetAsset = wrapAdapter.address;
            subjectTargetUnits = ether(0.25);
            subjectCaller = operator;
          });

          async function subject(): Promise<any> {
            return await targetWeightWrapExtension.connect(subjectCaller.wallet).unwrap(
              subjectTargetAsset,
              subjectTargetUnits
            );
          }

          it("should unwrap the correct number of units", async () => {
            const targetAssetPositionUnitsBefore = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
            const reservePositionUnitsBefore = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

            await subject();

            const targetAssetPositionUnitsAfter = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
            const reservePositionUnitsAfter = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

            const targetAssetPositionUnitChange = targetAssetPositionUnitsBefore.sub(targetAssetPositionUnitsAfter);
            const reservePositionUnitChange = reservePositionUnitsAfter.sub(reservePositionUnitsBefore);

            // 2 wei tolerance
            expect(targetAssetPositionUnitChange).to.be.gte(subjectTargetUnits.sub(2));
            expect(targetAssetPositionUnitChange).to.be.lte(subjectTargetUnits.add(2));
            expect(reservePositionUnitChange).to.be.gte(subjectTargetUnits.sub(2));
            expect(reservePositionUnitChange).to.be.lte(subjectTargetUnits.add(2));
          });

          context("when the underlying asset is Ether", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).setTargetWeights(
                await targetWeightWrapExtension.ETH_ADDRESS(),
                ether(0.45),
                ether(0.55),
                [wrapAdapter.address],
                [
                  {
                    minTargetWeight: ether(0.40),
                    maxTargetWeight: ether(0.60),
                    wrapAdapterName: wrapAdapterName,
                  } as TargetWeightWrapParams,
                ]
              );
            });

            it("should unwrap the correct number of units", async () => {
              const targetAssetPositionUnitsBefore = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
              const reservePositionUnitsBefore = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

              await subject();

              const targetAssetPositionUnitsAfter = await setToken.getDefaultPositionRealUnit(subjectTargetAsset);
              const reservePositionUnitsAfter = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);

              const targetAssetPositionUnitChange = targetAssetPositionUnitsBefore.sub(targetAssetPositionUnitsAfter);
              const reservePositionUnitChange = reservePositionUnitsAfter.sub(reservePositionUnitsBefore);

              // 2 wei tolerance
              expect(targetAssetPositionUnitChange).to.be.gte(subjectTargetUnits.sub(2));
              expect(targetAssetPositionUnitChange).to.be.lte(subjectTargetUnits.add(2));
              expect(reservePositionUnitChange).to.be.gte(subjectTargetUnits.sub(2));
              expect(reservePositionUnitChange).to.be.lte(subjectTargetUnits.add(2));
            });
          });

          context("when isRebalancing is false", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).suspendRebalance();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Rebalancing must be enabled");
            });
          });

          context("when the targetAsset is not in the rebalance", async () => {
            beforeEach(async () => {
              subjectTargetAsset = setV2Setup.weth.address;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Target asset must be in rebalance");
            });
          });

          context("when the target asset is underweight after", async () => {
            beforeEach(async () => {
              subjectTargetUnits = ether(0.7);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Target asset must be not be underweight after");
            });
          });

          context("when the reserve asset is overweight after", async () => {
            beforeEach(async () => {
              subjectTargetUnits = ether(0.55);
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Reserve must be not be overweight after");
            });
          });

          context("when the operator is not the caller and isAnyoneAllowedToRebalance is false", async () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be allowed rebalancer");
            });
          });

          context("when the operator is not the caller and isAnyoneAllowedToRebalance is true", async () => {
            beforeEach(async () => {
              await targetWeightWrapExtension.connect(operator.wallet).setIsAnyoneAllowedToRebalance(true);
              subjectCaller = await getRandomAccount();
            });

            it("should not revert", async () => {
              await expect(subject()).to.not.be.reverted;
            });
          });
        });
      });
    });
  });
});
