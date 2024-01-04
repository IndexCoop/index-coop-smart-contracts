import "module-alias/register";

import { Address, Account } from "@utils/types";
import { base58ToHexString } from "@utils/common";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  GlobalOptimisticAuctionRebalanceExtension, DelegatedManager, ManagerCore,
  ConstantPriceAdapter, OptimisticOracleV3Mock, StandardTokenMock
} from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  bitcoin,
  usdc,
  getTransactionTimestamp,
  getRandomAccount,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction, utils } from "ethers";

const expect = getWaffleExpect();

describe("GlobalOptimisticAuctionRebalanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let factory: Account;


  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let managerCore: ManagerCore;
  let delegatedManager: DelegatedManager;

  let auctionRebalanceExtension: GlobalOptimisticAuctionRebalanceExtension;

  let priceAdapter: ConstantPriceAdapter;

  let optimisticOracleV3Mock: OptimisticOracleV3Mock;

  let optimisticOracleV3MockUpgraded: OptimisticOracleV3Mock;

  let collateralAsset: StandardTokenMock;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      factory,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    priceAdapter = await deployer.setV2.deployConstantPriceAdapter();
    optimisticOracleV3Mock = await deployer.mocks.deployOptimisticOracleV3Mock();
    optimisticOracleV3MockUpgraded = await deployer.mocks.deployOptimisticOracleV3Mock();
    collateralAsset = await deployer.mocks.deployStandardTokenMock(owner.address, 18);

    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.auctionModule.address,
      "ConstantPriceAdapter",
      priceAdapter.address
    );

    managerCore = await deployer.managerCore.deployManagerCore();
    auctionRebalanceExtension = await deployer.globalExtensions.deployGlobalOptimisticAuctionRebalanceExtension(
      managerCore.address,
      setV2Setup.auctionModule.address
    );


    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address],
      [ether(100), bitcoin(.01), ether(.1)],
      [setV2Setup.auctionModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    delegatedManager = await deployer.manager.deployDelegatedManager(
      setToken.address,
      factory.address,
      methodologist.address,
      [auctionRebalanceExtension.address],
      [operator.address],
      [setV2Setup.dai.address, setV2Setup.weth.address],
      true
    );
    await setToken.setManager(delegatedManager.address);

    await managerCore.initialize([auctionRebalanceExtension.address], [factory.address]);
    await managerCore.connect(factory.wallet).addManager(delegatedManager.address);


  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", () => {
    let subjectManagerCore: Address;
    let subjectAuctionRebalanceModule: Address;

    beforeEach(async () => {
      subjectManagerCore = managerCore.address;
      subjectAuctionRebalanceModule = setV2Setup.auctionModule.address;
    });

    async function subject(): Promise<GlobalOptimisticAuctionRebalanceExtension> {
      const extension = await deployer.globalExtensions.deployGlobalOptimisticAuctionRebalanceExtension(
        subjectManagerCore,
        subjectAuctionRebalanceModule
      );
      await delegatedManager.addExtensions([extension.address]);
      return extension;
    }

    it("should set the correct manager core", async () => {
      const auctionExtension = await subject();

      const actualManagerCore = await auctionExtension.managerCore();
      expect(actualManagerCore).to.eq(subjectManagerCore);
    });

    it("should set the correct auction rebalance module address", async () => {
      const auctionExtension = await subject();

      const actualAuctionRebalanceModule = await auctionExtension.auctionModule();
      expect(actualAuctionRebalanceModule).to.eq(subjectAuctionRebalanceModule);
    });
    it("should be able to initialize extension and module at the same time", async () => {
      const auctionExtension = await subject();
      await expect(auctionExtension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address)).to.not.be.reverted;
    });

    it("should revert if module is initialized and extension is not", async () => {
      const extension = await deployer.globalExtensions.deployGlobalOptimisticAuctionRebalanceExtension(
        subjectManagerCore,
        subjectAuctionRebalanceModule
      );
      await expect(extension.connect(owner.wallet).initializeModule(delegatedManager.address)).to.be.revertedWith("Extension must be initialized");
    });

    it("should revert if module is initialized without being added", async () => {
      const extension = await deployer.globalExtensions.deployGlobalOptimisticAuctionRebalanceExtension(
        subjectManagerCore,
        subjectAuctionRebalanceModule
      );
      await expect(extension.connect(owner.wallet).initializeModuleAndExtension(delegatedManager.address)).to.be.revertedWith("Extension must be pending");
    });

    it("should revert if extension is initialized without being added", async () => {
      const extension = await deployer.globalExtensions.deployGlobalOptimisticAuctionRebalanceExtension(
        subjectManagerCore,
        subjectAuctionRebalanceModule
      );
      await expect(extension.connect(owner.wallet).initializeExtension(delegatedManager.address)).to.be.revertedWith("Extension must be pending");
    });

  });

  context("when auction rebalance extension is deployed and module needs to be initialized", () => {
    let subjectCaller: Account;
    let subjectDelegatedManager: Address;

    beforeEach(async () => {
      subjectCaller = owner;
      subjectDelegatedManager = delegatedManager.address;
      await auctionRebalanceExtension.connect(subjectCaller.wallet).initializeExtension(delegatedManager.address);
    });

    describe("#initializeModule", () => {

      async function subject() {
        return await auctionRebalanceExtension.connect(subjectCaller.wallet).initializeModule(subjectDelegatedManager);
      }

      it("should initialize AuctionRebalanceModule", async () => {
        await subject();
        const isInitialized = await setToken.isInitializedModule(setV2Setup.auctionModule.address);
        expect(isInitialized).to.be.true;
      });

      it("should set the correct delegated manager for the given setToken", async () => {
        await subject();
        const actualManager = await auctionRebalanceExtension.setManagers(setToken.address);
        expect(actualManager).to.eq(delegatedManager.address);
      });

      describe("when the initializer is not the owner", () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be owner");
        });
      });
    });

    context("when auction rebalance extension is deployed and initialized.", () => {
      beforeEach(async () => {
        await auctionRebalanceExtension.connect(owner.wallet).initializeModule(delegatedManager.address);
      });

      context("when the product settings have been set", () => {
        beforeEach(async () => {
          await auctionRebalanceExtension.connect(operator.wallet).setProductSettings(setToken.address, {
            collateral: collateralAsset.address,
            liveness: BigNumber.from(0),
            bondAmount: BigNumber.from(0),
            identifier: utils.formatBytes32String(""),
            optimisticOracleV3: optimisticOracleV3Mock.address,
          }, utils.arrayify(base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z")));

        });

        context("when a rebalance has been proposed", () => {
          let subjectQuoteAsset: Address;
          let subjectOldComponents: Address[];
          let subjectNewComponents: Address[];
          let subjectNewComponentsAuctionParams: any[];
          let subjectOldComponentsAuctionParams: any[];
          let subjectShouldLockSetToken: boolean;
          let subjectRebalanceDuration: BigNumber;
          let subjectPositionMultiplier: BigNumber;
          let subjectCaller: Account;
          let subjectSetToken: Address;
          beforeEach(async () => {
            subjectQuoteAsset = setV2Setup.weth.address;

            subjectOldComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address];
            subjectNewComponents = [setV2Setup.usdc.address];

            subjectNewComponentsAuctionParams = [
              {
                targetUnit: usdc(100),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
            ];

            subjectOldComponentsAuctionParams = [
              {
                targetUnit: ether(50),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
              {
                targetUnit: bitcoin(.01),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
              {
                targetUnit: ether(.1),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
            ];

            subjectShouldLockSetToken = true;
            subjectRebalanceDuration = BigNumber.from(86400);
            subjectPositionMultiplier = ether(.999);
            subjectCaller = operator;
            subjectSetToken = setToken.address;
          });
          describe("#startRebalance", () => {


            async function subject(): Promise<ContractTransaction> {
              await auctionRebalanceExtension.connect(subjectCaller.wallet).proposeRebalance(
                subjectSetToken,
                subjectQuoteAsset,
                subjectOldComponents,
                subjectNewComponents,
                subjectNewComponentsAuctionParams,
                subjectOldComponentsAuctionParams,
                subjectShouldLockSetToken,
                subjectRebalanceDuration,
                subjectPositionMultiplier
              );
              return auctionRebalanceExtension.connect(subjectCaller.wallet).startRebalance(
                subjectSetToken,
                subjectQuoteAsset,
                subjectOldComponents,
                subjectNewComponents,
                subjectNewComponentsAuctionParams,
                subjectOldComponentsAuctionParams,
                subjectShouldLockSetToken,
                subjectRebalanceDuration,
                subjectPositionMultiplier
              );
            }

            it("should set the auction execution params correctly", async () => {
              await subject();
              expect(1).to.eq(1);

              const aggregateComponents = [...subjectOldComponents, ...subjectNewComponents];
              const aggregateAuctionParams = [...subjectOldComponentsAuctionParams, ...subjectNewComponentsAuctionParams];

              for (let i = 0; i < aggregateAuctionParams.length; i++) {
                const executionInfo = await setV2Setup.auctionModule.executionInfo(setToken.address, aggregateComponents[i]);
                expect(executionInfo.targetUnit).to.eq(aggregateAuctionParams[i].targetUnit);
                expect(executionInfo.priceAdapterName).to.eq(aggregateAuctionParams[i].priceAdapterName);
                expect(executionInfo.priceAdapterConfigData).to.eq(aggregateAuctionParams[i].priceAdapterConfigData);
              }
            });

            it("should set the rebalance info correctly", async () => {
              const txnTimestamp = await getTransactionTimestamp(subject());

              const rebalanceInfo = await setV2Setup.auctionModule.rebalanceInfo(setToken.address);

              expect(rebalanceInfo.quoteAsset).to.eq(subjectQuoteAsset);
              expect(rebalanceInfo.rebalanceStartTime).to.eq(txnTimestamp);
              expect(rebalanceInfo.rebalanceDuration).to.eq(subjectRebalanceDuration);
              expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
              expect(rebalanceInfo.raiseTargetPercentage).to.eq(ZERO);

              const rebalanceComponents = await setV2Setup.auctionModule.getRebalanceComponents(setToken.address);
              const aggregateComponents = [...subjectOldComponents, ...subjectNewComponents];

              for (let i = 0; i < rebalanceComponents.length; i++) {
                expect(rebalanceComponents[i]).to.eq(aggregateComponents[i]);
              }
            });

            describe("when there are no new components", () => {
              beforeEach(async () => {
                subjectNewComponents = [];
                subjectNewComponentsAuctionParams = [];
              });

              it("should set the auction execution params correctly", async () => {
                await subject();

                for (let i = 0; i < subjectOldComponents.length; i++) {
                  const executionInfo = await setV2Setup.auctionModule.executionInfo(setToken.address, subjectOldComponents[i]);
                  expect(executionInfo.targetUnit).to.eq(subjectOldComponentsAuctionParams[i].targetUnit);
                  expect(executionInfo.priceAdapterName).to.eq(subjectOldComponentsAuctionParams[i].priceAdapterName);
                  expect(executionInfo.priceAdapterConfigData).to.eq(subjectOldComponentsAuctionParams[i].priceAdapterConfigData);
                }
              });

              it("should set the rebalance info correctly", async () => {
                const txnTimestamp = await getTransactionTimestamp(subject());

                const rebalanceInfo = await setV2Setup.auctionModule.rebalanceInfo(setToken.address);

                expect(rebalanceInfo.quoteAsset).to.eq(subjectQuoteAsset);
                expect(rebalanceInfo.rebalanceStartTime).to.eq(txnTimestamp);
                expect(rebalanceInfo.rebalanceDuration).to.eq(subjectRebalanceDuration);
                expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
                expect(rebalanceInfo.raiseTargetPercentage).to.eq(ZERO);

                const rebalanceComponents = await setV2Setup.auctionModule.getRebalanceComponents(setToken.address);
                for (let i = 0; i < rebalanceComponents.length; i++) {
                  expect(rebalanceComponents[i]).to.eq(subjectOldComponents[i]);
                }
              });
            });

            describe("when old components are passed in different order", () => {
              beforeEach(async () => {
                subjectOldComponents = [setV2Setup.dai.address, setV2Setup.weth.address, setV2Setup.wbtc.address];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Mismatch: old and current components");
              });
            });

            describe("when old components array is shorter than current components array", () => {
              beforeEach(async () => {
                subjectOldComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address];
                subjectOldComponentsAuctionParams = [
                  {
                    targetUnit: ether(50),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
                  },
                  {
                    targetUnit: bitcoin(.01),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
                  },
                ];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Mismatch: old and current components length");
              });
            });

            describe("when old components array is longer than current components array", () => {
              beforeEach(async () => {
                const price = await priceAdapter.getEncodedData(ether(1));
                subjectOldComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address, setV2Setup.usdc.address];
                subjectOldComponentsAuctionParams = [
                  {
                    targetUnit: ether(50),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  },
                  {
                    targetUnit: bitcoin(.01),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  },
                  {
                    targetUnit: ether(.1),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  },
                  {
                    targetUnit: usdc(100),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  },
                ];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Mismatch: old and current components length");
              });
            });

            describe("when not all old components have an entry", () => {
              beforeEach(async () => {
                subjectOldComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.usdc.address];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Mismatch: old and current components");
              });
            });

            describe("when the caller is not the operator", () => {
              beforeEach(async () => {
                subjectCaller = await getRandomAccount();
              });

              it("should not revert", async () => {
                await expect(subject()).not.to.be.reverted;
              });
            });
          });
          describe("assertionDisputedCallback", () => {
            it("should delete the proposal on a disputed callback", async () => {
              await auctionRebalanceExtension.connect(subjectCaller.wallet).proposeRebalance(
                subjectSetToken,
                subjectQuoteAsset,
                subjectOldComponents,
                subjectNewComponents,
                subjectNewComponentsAuctionParams,
                subjectOldComponentsAuctionParams,
                subjectShouldLockSetToken,
                subjectRebalanceDuration,
                subjectPositionMultiplier
              );
              const proposal = await auctionRebalanceExtension.connect(subjectCaller.wallet).proposedProduct(utils.formatBytes32String("win"));
              expect(proposal.product).to.eq(subjectSetToken);

              await expect(optimisticOracleV3Mock.connect(subjectCaller.wallet).mockAssertionDisputedCallback(
                auctionRebalanceExtension.address, utils.formatBytes32String("win")
              )).to.not.be.reverted;

              const proposalAfter = await auctionRebalanceExtension.connect(subjectCaller.wallet).proposedProduct(utils.formatBytes32String("win"));
              expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
            });
            it("should delete the proposal on a disputed callback from currently set oracle", async () => {
              await auctionRebalanceExtension.connect(subjectCaller.wallet).proposeRebalance(
                subjectSetToken,
                subjectQuoteAsset,
                subjectOldComponents,
                subjectNewComponents,
                subjectNewComponentsAuctionParams,
                subjectOldComponentsAuctionParams,
                subjectShouldLockSetToken,
                subjectRebalanceDuration,
                subjectPositionMultiplier
              );
              await auctionRebalanceExtension.connect(operator.wallet).setProductSettings(setToken.address, {
                collateral: collateralAsset.address,
                liveness: BigNumber.from(0),
                bondAmount: BigNumber.from(0),
                identifier: utils.formatBytes32String(""),
                optimisticOracleV3: optimisticOracleV3MockUpgraded.address,
              }, utils.arrayify(base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z")));
              const proposal = await auctionRebalanceExtension.connect(subjectCaller.wallet).proposedProduct(utils.formatBytes32String("win"));
              expect(proposal.product).to.eq(subjectSetToken);
              await expect(optimisticOracleV3Mock.connect(subjectCaller.wallet).mockAssertionDisputedCallback(
                auctionRebalanceExtension.address, utils.formatBytes32String("win")
              )).to.not.be.reverted;
              const proposalAfter = await auctionRebalanceExtension.connect(subjectCaller.wallet).proposedProduct(utils.formatBytes32String("win"));
              expect(proposalAfter.product).to.eq(ADDRESS_ZERO);

            });
          });
          describe("assertionResolvedCallback", () => {
            it("should not revert on a resolved callback", async () => {
              await auctionRebalanceExtension.connect(subjectCaller.wallet).proposeRebalance(
                subjectSetToken,
                subjectQuoteAsset,
                subjectOldComponents,
                subjectNewComponents,
                subjectNewComponentsAuctionParams,
                subjectOldComponentsAuctionParams,
                subjectShouldLockSetToken,
                subjectRebalanceDuration,
                subjectPositionMultiplier
              );
              await expect(optimisticOracleV3Mock.connect(subjectCaller.wallet).mockAssertionResolvedCallback(
                auctionRebalanceExtension.address, utils.formatBytes32String("win"), true)
              ).to.not.be.reverted;
            });
          });

        });
        describe("#setRaiseTargetPercentage", () => {
          let subjectRaiseTargetPercentage: BigNumber;
          let subjectCaller: Account;

          beforeEach(async () => {
            subjectRaiseTargetPercentage = ether(.001);
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension.connect(subjectCaller.wallet).setRaiseTargetPercentage(
              setToken.address,
              subjectRaiseTargetPercentage,
            );
          }

          it("should correctly set the raiseTargetPercentage", async () => {
            await subject();

            const actualRaiseTargetPercentage = (await setV2Setup.auctionModule.rebalanceInfo(setToken.address)).raiseTargetPercentage;

            expect(actualRaiseTargetPercentage).to.eq(subjectRaiseTargetPercentage);
          });

          describe("when the caller is not the operator", async () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be approved operator");
            });
          });
        });

        describe("#setBidderStatus", () => {
          let subjectBidders: Address[];
          let subjectStatuses: boolean[];
          let subjectCaller: Account;

          beforeEach(async () => {
            subjectBidders = [methodologist.address];
            subjectStatuses = [true];
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension.connect(subjectCaller.wallet).setBidderStatus(
              setToken.address,
              subjectBidders,
              subjectStatuses
            );
          }

          it("should correctly set the bidder status", async () => {
            await subject();

            const isCaller = await setV2Setup.auctionModule.isAllowedBidder(setToken.address, subjectBidders[0]);

            expect(isCaller).to.be.true;
          });

          describe("when the caller is not the operator", () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be approved operator");
            });
          });
        });

        describe("#setAnyoneBid", () => {
          let subjectStatus: boolean;
          let subjectCaller: Account;

          beforeEach(async () => {
            subjectStatus = true;
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension.connect(subjectCaller.wallet).setAnyoneBid(
              setToken.address,
              subjectStatus
            );
          }

          it("should correctly set anyone bid", async () => {
            await subject();

            const anyoneBid = await setV2Setup.auctionModule.permissionInfo(setToken.address);

            expect(anyoneBid).to.be.true;
          });

          describe("when the caller is not the operator", () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be approved operator");
            });
          });
        });

        describe("#removeExtension", () => {
          async function subject() {
            return await delegatedManager.connect(owner.wallet).removeExtensions([auctionRebalanceExtension.address]);
          }
          it("should remove the extension", async () => {
            const setManagerBeforeRemove = auctionRebalanceExtension.setManagers(setToken.address);
            await subject();
            const setManagerAfterRemove = auctionRebalanceExtension.setManagers(setToken.address);

            expect(setManagerBeforeRemove).to.not.eq(setManagerAfterRemove);
          });
        });
      });
    });
  });
});
