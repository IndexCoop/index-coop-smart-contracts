import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  BaseManager,
  ConstantPriceAdapter,
OptimisticAuctionRebalanceExtension,
  OptimisticOracleV3Mock,
  StandardTokenMock,
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
import base58 from "bs58";

const expect = getWaffleExpect();

function bufferToHex(buffer: Uint8Array) {
  let hexStr = "";

  for (let i = 0; i < buffer.length; i++) {
    const hex = (buffer[i] & 0xff).toString(16);
    hexStr += hex.length === 1 ? "0" + hex : hex;
  }

  return hexStr;
}

// Base58 decoding function (make sure you have a proper Base58 decoding function)
function base58ToHexString(base58String: string) {
  const bytes = base58.decode(base58String); // Decode base58 to a buffer
  const hexString = bufferToHex(bytes.slice(2)); // Convert buffer to hex, excluding the first 2 bytes
  return "0x" + hexString;
}

describe("OptimisticAuctionRebalanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let baseManager: BaseManager;

  let auctionRebalanceExtension: OptimisticAuctionRebalanceExtension;

  let priceAdapter: ConstantPriceAdapter;

  let optimisticOracleV3Mock: OptimisticOracleV3Mock;

  let optimisticOracleV3MockUpgraded: OptimisticOracleV3Mock;

  let collateralAsset: StandardTokenMock;

  let useAssetAllowlist: boolean;
  let allowedAssets: Address[];

  before(async () => {
    [owner, methodologist, operator] = await getAccounts();

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
      priceAdapter.address,
    );

    useAssetAllowlist = false;
    allowedAssets = [];

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address],
      [ether(100), bitcoin(0.01), ether(0.1)],
      [setV2Setup.auctionModule.address, setV2Setup.issuanceModule.address],
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      operator.address,
      methodologist.address,
    );
    baseManager = baseManager.connect(operator.wallet);
    await setToken.setManager(baseManager.address);

    auctionRebalanceExtension = await deployer.extensions.deployOptimisticAuctionRebalanceExtension(
      baseManager.address,
      setV2Setup.auctionModule.address,
      useAssetAllowlist,
      allowedAssets,
    );
    auctionRebalanceExtension = auctionRebalanceExtension.connect(operator.wallet);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", () => {
    let subjectBaseManager: Address;
    let subjectAuctionRebalanceModule: Address;
      let subjectUseAssetAllowlist: boolean;
      let subjectAllowedAssets: Address[];

    beforeEach(async () => {
      subjectBaseManager = baseManager.address;
      subjectAuctionRebalanceModule = setV2Setup.auctionModule.address;
        subjectUseAssetAllowlist = false;
        subjectAllowedAssets = [];
    });

    async function subject(): Promise<OptimisticAuctionRebalanceExtension> {
      let extension = await deployer.extensions.deployOptimisticAuctionRebalanceExtension(
        subjectBaseManager,
        subjectAuctionRebalanceModule,
          subjectUseAssetAllowlist,
          allowedAssets,
      );
      extension = extension.connect(operator.wallet);
      await baseManager.addAdapter(extension.address);
      return extension;
    }

    it("should set the correct manager core", async () => {
      const auctionExtension = await subject();

      const actualBaseManager = await auctionExtension.manager();
      expect(actualBaseManager).to.eq(subjectBaseManager);
    });

    it("should set the correct auction rebalance module address", async () => {
      const auctionExtension = await subject();

      const actualAuctionRebalanceModule = await auctionExtension.auctionModule();
      expect(actualAuctionRebalanceModule).to.eq(subjectAuctionRebalanceModule);
    });
    it("should be able to initialize extension and module at the same time", async () => {
      const auctionExtension = await subject();
      await expect(
        auctionExtension
          .initialize(),
      ).to.not.be.reverted;
    });

    it("should revert if module is initialized without being added", async () => {
      const extension = await deployer.extensions.deployOptimisticAuctionRebalanceExtension(
        subjectBaseManager,
        subjectAuctionRebalanceModule,
          subjectUseAssetAllowlist,
          subjectAllowedAssets,
      );
      await expect(
        extension.connect(operator.wallet).initialize(),
      ).to.be.revertedWith("Must be adapter");
    });

    it("should revert if extension is initialized without being added", async () => {
      const extension = await deployer.extensions.deployOptimisticAuctionRebalanceExtension(
        subjectBaseManager,
        subjectAuctionRebalanceModule,
          subjectUseAssetAllowlist,
          allowedAssets,
      );
      await expect(
        extension.connect(operator.wallet).initialize(),
      ).to.be.revertedWith("Must be adapter");
    });
  });

  context("when auction rebalance extension is added as adapter and needs to be initialized", () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = operator;
      await baseManager.addAdapter(auctionRebalanceExtension.address);
    });

    describe("#initialize", () => {
      async function subject() {
        return await auctionRebalanceExtension
          .connect(subjectCaller.wallet)
          .initialize();
      }

      it("should initialize AuctionRebalanceModule", async () => {
        await subject();
        const isInitialized = await setToken.isInitializedModule(setV2Setup.auctionModule.address);
        expect(isInitialized).to.be.true;
      });

      describe("when the initializer is not the owner", () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when auction rebalance extension is deployed and initialized.", () => {
      beforeEach(async () => {
        await auctionRebalanceExtension
          .connect(operator.wallet)
          .initialize();
      });

      context("when the product settings have been set", () => {
        beforeEach(async () => {
          await auctionRebalanceExtension.connect(operator.wallet).setProductSettings(
            {
              collateral: collateralAsset.address,
              liveness: BigNumber.from(0),
              bondAmount: BigNumber.from(0),
              identifier: utils.formatBytes32String(""),
              optimisticOracleV3: optimisticOracleV3Mock.address,
            },
            utils.arrayify(base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z")),
          );
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
          beforeEach(async () => {
            subjectQuoteAsset = setV2Setup.weth.address;

            subjectOldComponents = [
              setV2Setup.dai.address,
              setV2Setup.wbtc.address,
              setV2Setup.weth.address,
            ];
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
                targetUnit: bitcoin(0.01),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
              {
                targetUnit: ether(0.1),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
            ];

            subjectShouldLockSetToken = true;
            subjectRebalanceDuration = BigNumber.from(86400);
            subjectPositionMultiplier = ether(0.999);
            subjectCaller = operator;
          });
          describe("#startRebalance", () => {
            async function subject(): Promise<ContractTransaction> {
              await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposeRebalance(
                  subjectQuoteAsset,
                  subjectOldComponents,
                  subjectNewComponents,
                  subjectNewComponentsAuctionParams,
                  subjectOldComponentsAuctionParams,
                  subjectShouldLockSetToken,
                  subjectRebalanceDuration,
                  subjectPositionMultiplier,
                );
              return auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .startRebalance(
                  subjectQuoteAsset,
                  subjectOldComponents,
                  subjectNewComponents,
                  subjectNewComponentsAuctionParams,
                  subjectOldComponentsAuctionParams,
                  subjectShouldLockSetToken,
                  subjectRebalanceDuration,
                  subjectPositionMultiplier,
                );
            }

            it("should set the auction execution params correctly", async () => {
              await subject();
              expect(1).to.eq(1);

              const aggregateComponents = [...subjectOldComponents, ...subjectNewComponents];
              const aggregateAuctionParams = [
                ...subjectOldComponentsAuctionParams,
                ...subjectNewComponentsAuctionParams,
              ];

              for (let i = 0; i < aggregateAuctionParams.length; i++) {
                const executionInfo = await setV2Setup.auctionModule.executionInfo(
                  setToken.address,
                  aggregateComponents[i],
                );
                expect(executionInfo.targetUnit).to.eq(aggregateAuctionParams[i].targetUnit);
                expect(executionInfo.priceAdapterName).to.eq(
                  aggregateAuctionParams[i].priceAdapterName,
                );
                expect(executionInfo.priceAdapterConfigData).to.eq(
                  aggregateAuctionParams[i].priceAdapterConfigData,
                );
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

              const rebalanceComponents = await setV2Setup.auctionModule.getRebalanceComponents(
                setToken.address,
              );
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
                  const executionInfo = await setV2Setup.auctionModule.executionInfo(
                    setToken.address,
                    subjectOldComponents[i],
                  );
                  expect(executionInfo.targetUnit).to.eq(
                    subjectOldComponentsAuctionParams[i].targetUnit,
                  );
                  expect(executionInfo.priceAdapterName).to.eq(
                    subjectOldComponentsAuctionParams[i].priceAdapterName,
                  );
                  expect(executionInfo.priceAdapterConfigData).to.eq(
                    subjectOldComponentsAuctionParams[i].priceAdapterConfigData,
                  );
                }
              });

              it("should set the rebalance info correctly", async () => {
                const txnTimestamp = await getTransactionTimestamp(subject());

                const rebalanceInfo = await setV2Setup.auctionModule.rebalanceInfo(
                  setToken.address,
                );

                expect(rebalanceInfo.quoteAsset).to.eq(subjectQuoteAsset);
                expect(rebalanceInfo.rebalanceStartTime).to.eq(txnTimestamp);
                expect(rebalanceInfo.rebalanceDuration).to.eq(subjectRebalanceDuration);
                expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
                expect(rebalanceInfo.raiseTargetPercentage).to.eq(ZERO);

                const rebalanceComponents = await setV2Setup.auctionModule.getRebalanceComponents(
                  setToken.address,
                );
                for (let i = 0; i < rebalanceComponents.length; i++) {
                  expect(rebalanceComponents[i]).to.eq(subjectOldComponents[i]);
                }
              });
            });

            describe("when old components are passed in different order", () => {
              beforeEach(async () => {
                subjectOldComponents = [
                  setV2Setup.dai.address,
                  setV2Setup.weth.address,
                  setV2Setup.wbtc.address,
                ];
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
                    targetUnit: bitcoin(0.01),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
                  },
                ];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith(
                  "Mismatch: old and current components length",
                );
              });
            });

            describe("when old components array is longer than current components array", () => {
              beforeEach(async () => {
                const price = await priceAdapter.getEncodedData(ether(1));
                subjectOldComponents = [
                  setV2Setup.dai.address,
                  setV2Setup.wbtc.address,
                  setV2Setup.weth.address,
                  setV2Setup.usdc.address,
                ];
                subjectOldComponentsAuctionParams = [
                  {
                    targetUnit: ether(50),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  },
                  {
                    targetUnit: bitcoin(0.01),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  },
                  {
                    targetUnit: ether(0.1),
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
                await expect(subject()).to.be.revertedWith(
                  "Mismatch: old and current components length",
                );
              });
            });

            describe("when not all old components have an entry", () => {
              beforeEach(async () => {
                subjectOldComponents = [
                  setV2Setup.dai.address,
                  setV2Setup.wbtc.address,
                  setV2Setup.usdc.address,
                ];
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
              await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposeRebalance(
                  subjectQuoteAsset,
                  subjectOldComponents,
                  subjectNewComponents,
                  subjectNewComponentsAuctionParams,
                  subjectOldComponentsAuctionParams,
                  subjectShouldLockSetToken,
                  subjectRebalanceDuration,
                  subjectPositionMultiplier,
                );
              const proposal = await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposal.product).to.eq(setToken.address);

              await expect(
                optimisticOracleV3Mock
                  .connect(subjectCaller.wallet)
                  .mockAssertionDisputedCallback(
                    auctionRebalanceExtension.address,
                    utils.formatBytes32String("win"),
                  ),
              ).to.not.be.reverted;

              const proposalAfter = await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
            });
            it("should delete the proposal on a disputed callback from currently set oracle", async () => {
              await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposeRebalance(
                  subjectQuoteAsset,
                  subjectOldComponents,
                  subjectNewComponents,
                  subjectNewComponentsAuctionParams,
                  subjectOldComponentsAuctionParams,
                  subjectShouldLockSetToken,
                  subjectRebalanceDuration,
                  subjectPositionMultiplier,
                );
              await auctionRebalanceExtension.connect(operator.wallet).setProductSettings(
                {
                  collateral: collateralAsset.address,
                  liveness: BigNumber.from(0),
                  bondAmount: BigNumber.from(0),
                  identifier: utils.formatBytes32String(""),
                  optimisticOracleV3: optimisticOracleV3MockUpgraded.address,
                },
                utils.arrayify(base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z")),
              );
              const proposal = await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposal.product).to.eq(setToken.address);
              await expect(
                optimisticOracleV3Mock
                  .connect(subjectCaller.wallet)
                  .mockAssertionDisputedCallback(
                    auctionRebalanceExtension.address,
                    utils.formatBytes32String("win"),
                  ),
              ).to.not.be.reverted;
              const proposalAfter = await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
            });
          });
          describe("assertionResolvedCallback", () => {
            it("should not revert on a resolved callback", async () => {
              await auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposeRebalance(
                  subjectQuoteAsset,
                  subjectOldComponents,
                  subjectNewComponents,
                  subjectNewComponentsAuctionParams,
                  subjectOldComponentsAuctionParams,
                  subjectShouldLockSetToken,
                  subjectRebalanceDuration,
                  subjectPositionMultiplier,
                );
              await expect(
                optimisticOracleV3Mock
                  .connect(subjectCaller.wallet)
                  .mockAssertionResolvedCallback(
                    auctionRebalanceExtension.address,
                    utils.formatBytes32String("win"),
                    true,
                  ),
              ).to.not.be.reverted;
            });
          });
        });
        describe("#setRaiseTargetPercentage", () => {
          let subjectRaiseTargetPercentage: BigNumber;
          let subjectCaller: Account;

          beforeEach(async () => {
            subjectRaiseTargetPercentage = ether(0.001);
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension
              .connect(subjectCaller.wallet)
              .setRaiseTargetPercentage( subjectRaiseTargetPercentage);
          }

          it("should correctly set the raiseTargetPercentage", async () => {
            await subject();

            const actualRaiseTargetPercentage = (
              await setV2Setup.auctionModule.rebalanceInfo(setToken.address)
            ).raiseTargetPercentage;

            expect(actualRaiseTargetPercentage).to.eq(subjectRaiseTargetPercentage);
          });

          describe("when the caller is not the operator", async () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
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
            return await auctionRebalanceExtension
              .connect(subjectCaller.wallet)
              .setBidderStatus( subjectBidders, subjectStatuses);
          }

          it("should correctly set the bidder status", async () => {
            await subject();

            const isCaller = await setV2Setup.auctionModule.isAllowedBidder(
              setToken.address,
              subjectBidders[0],
            );

            expect(isCaller).to.be.true;
          });

          describe("when the caller is not the operator", () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
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
            return await auctionRebalanceExtension
              .connect(subjectCaller.wallet)
              .setAnyoneBid(subjectStatus);
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
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
        });
      });
    });
  });
});
