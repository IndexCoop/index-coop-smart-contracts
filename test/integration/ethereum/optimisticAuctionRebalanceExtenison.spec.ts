import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  OptimisticAuctionRebalanceExtension,
  OptimisticOracleV3Mock,
} from "@utils/contracts/index";
import {
  AuctionRebalanceModuleV1,
  AuctionRebalanceModuleV1__factory,
  ConstantPriceAdapter,
  ConstantPriceAdapter__factory,
  SetToken,
  SetToken__factory,
  BaseManagerV2,
  BaseManagerV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
} from "../../../typechain";
import DeployHelper from "@utils/deploys";
import { impersonateAccount } from "./utils";
import { PRODUCTION_ADDRESSES } from "./addresses";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  usdc,
  getTransactionTimestamp,
  getRandomAccount,
} from "@utils/index";
import { BigNumber, ContractTransaction, utils, Signer } from "ethers";
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

if (process.env.INTEGRATIONTEST) {
  describe("OptimisticAuctionRebalanceExtension - Integration Test dsEth", () => {
    const contractAddresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let methodologist: Account;
    let operator: Signer;

    let deployer: DeployHelper;
    let dsEth: SetToken;
    let baseManager: BaseManagerV2;

    let auctionModule: AuctionRebalanceModuleV1;
    let auctionRebalanceExtension: OptimisticAuctionRebalanceExtension;
    let integrationRegistry: IntegrationRegistry;

    let priceAdapter: ConstantPriceAdapter;

    let optimisticOracleV3Mock: OptimisticOracleV3Mock;

    let optimisticOracleV3MockUpgraded: OptimisticOracleV3Mock;

    let collateralAssetAddress: string;

    let useAssetAllowlist: boolean;
    let allowedAssets: Address[];

    before(async () => {
      [owner, methodologist] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      priceAdapter = ConstantPriceAdapter__factory.connect(
        contractAddresses.setFork.constantPriceAdapter,
        owner.wallet,
      );
      optimisticOracleV3Mock = await deployer.mocks.deployOptimisticOracleV3Mock();
      optimisticOracleV3MockUpgraded = await deployer.mocks.deployOptimisticOracleV3Mock();
      collateralAssetAddress = contractAddresses.tokens.weth;

      integrationRegistry = IntegrationRegistry__factory.connect(
        contractAddresses.setFork.integrationRegistry,
        owner.wallet,
      );
      const integrationRegistryOwner = await impersonateAccount(await integrationRegistry.owner());
      integrationRegistry = integrationRegistry.connect(integrationRegistryOwner);

      auctionModule = AuctionRebalanceModuleV1__factory.connect(
        contractAddresses.setFork.auctionModuleV1,
        owner.wallet,
      );

      useAssetAllowlist = false;
      allowedAssets = [];

      dsEth = SetToken__factory.connect(contractAddresses.tokens.dsEth, owner.wallet);

      baseManager = BaseManagerV2__factory.connect(await dsEth.manager(), owner.wallet);
      operator = await impersonateAccount(await baseManager.operator());
      baseManager = baseManager.connect(operator);

      auctionRebalanceExtension = await deployer.extensions.deployOptimisticAuctionRebalanceExtension(
        baseManager.address,
        auctionModule.address,
        useAssetAllowlist,
        allowedAssets,
      );
      auctionRebalanceExtension = auctionRebalanceExtension.connect(operator);
    });

    addSnapshotBeforeRestoreAfterEach();

    context("when auction rebalance extension is added as extension", () => {

      beforeEach(async () => {
        await baseManager.addExtension(auctionRebalanceExtension.address);
      });

      context("when the product settings have been set", () => {
        beforeEach(async () => {
          await auctionRebalanceExtension.connect(operator).setProductSettings(
            {
              collateral: collateralAssetAddress,
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
          let subjectCaller: Signer;
          beforeEach(async () => {
            subjectQuoteAsset = contractAddresses.tokens.weth;

            subjectOldComponents = await dsEth.getComponents();
            subjectNewComponents = [contractAddresses.tokens.USDC];

            subjectNewComponentsAuctionParams = [
              {
                targetUnit: usdc(100),
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
              },
            ];

            const sellAllAuctionParam = {
              targetUnit: ether(0),
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.005)),
            };
            subjectOldComponentsAuctionParams = subjectOldComponents.map(() => sellAllAuctionParam);

            subjectShouldLockSetToken = true;
            subjectRebalanceDuration = BigNumber.from(86400);
            subjectPositionMultiplier = ether(0.999);
            subjectCaller = operator;
          });
          describe("#startRebalance", () => {
            async function subject(): Promise<ContractTransaction> {
              await auctionRebalanceExtension
                .connect(subjectCaller)
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
                .connect(subjectCaller)
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
                const executionInfo = await auctionModule.executionInfo(
                  dsEth.address,
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

              const rebalanceInfo = await auctionModule.rebalanceInfo(dsEth.address);

              expect(utils.getAddress(rebalanceInfo.quoteAsset)).to.eq(
                utils.getAddress(subjectQuoteAsset),
              );
              expect(rebalanceInfo.rebalanceStartTime).to.eq(txnTimestamp);
              expect(rebalanceInfo.rebalanceDuration).to.eq(subjectRebalanceDuration);
              expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
              expect(rebalanceInfo.raiseTargetPercentage).to.eq(ZERO);

              const rebalanceComponents = await auctionModule.getRebalanceComponents(dsEth.address);
              const aggregateComponents = [...subjectOldComponents, ...subjectNewComponents];

              for (let i = 0; i < rebalanceComponents.length; i++) {
                expect(utils.getAddress(rebalanceComponents[i])).to.eq(
                  utils.getAddress(aggregateComponents[i]),
                );
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
                  const executionInfo = await auctionModule.executionInfo(
                    dsEth.address,
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

                const rebalanceInfo = await auctionModule.rebalanceInfo(dsEth.address);

                expect(utils.getAddress(rebalanceInfo.quoteAsset)).to.eq(
                  utils.getAddress(subjectQuoteAsset),
                );
                expect(rebalanceInfo.rebalanceStartTime).to.eq(txnTimestamp);
                expect(rebalanceInfo.rebalanceDuration).to.eq(subjectRebalanceDuration);
                expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
                expect(rebalanceInfo.raiseTargetPercentage).to.eq(ZERO);

                const rebalanceComponents = await auctionModule.getRebalanceComponents(
                  dsEth.address,
                );
                for (let i = 0; i < rebalanceComponents.length; i++) {
                  expect(rebalanceComponents[i]).to.eq(subjectOldComponents[i]);
                }
              });
            });

            describe("when old components are passed in different order", () => {
              beforeEach(async () => {
                subjectOldComponents = [
                  contractAddresses.tokens.dai,
                  contractAddresses.tokens.weth,
                  contractAddresses.tokens.wbtc,
                ];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Mismatch: old and current components");
              });
            });

            describe("when old components array is shorter than current components array", () => {
              beforeEach(async () => {
                const setComponents = await dsEth.getComponents();
                subjectOldComponents = setComponents.slice(0, setComponents.length - 1);
                const priceAdapterConfigData = await priceAdapter.getEncodedData(ether(0.005));
                subjectOldComponentsAuctionParams = subjectOldComponents.map(() => {
                  return {
                    targetUnit: ether(50),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData,
                  };
                });
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
                const setComponents = await dsEth.getComponents();
                subjectOldComponents = [
                    ...setComponents,
                    contractAddresses.tokens.dai,
                ];
                subjectOldComponentsAuctionParams = subjectOldComponents.map(() => {
                  return {
                    targetUnit: ether(50),
                    priceAdapterName: "ConstantPriceAdapter",
                    priceAdapterConfigData: price,
                  };
                });
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
                  contractAddresses.tokens.dai,
                  contractAddresses.tokens.wbtc,
                  contractAddresses.tokens.USDC,
                ];
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Mismatch: old and current components");
              });
            });

            describe("when the caller is not the operator", () => {
              beforeEach(async () => {
                subjectCaller = (await getRandomAccount()).wallet;
              });

              it("should not revert", async () => {
                await expect(subject()).not.to.be.reverted;
              });
            });
          });
          describe("assertionDisputedCallback", () => {
            it("should delete the proposal on a disputed callback", async () => {
              await auctionRebalanceExtension
                .connect(subjectCaller)
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
                .connect(subjectCaller)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposal.product).to.eq(dsEth.address);

              await expect(
                optimisticOracleV3Mock
                  .connect(subjectCaller)
                  .mockAssertionDisputedCallback(
                    auctionRebalanceExtension.address,
                    utils.formatBytes32String("win"),
                  ),
              ).to.not.be.reverted;

              const proposalAfter = await auctionRebalanceExtension
                .connect(subjectCaller)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
            });
            it("should delete the proposal on a disputed callback from currently set oracle", async () => {
              await auctionRebalanceExtension
                .connect(subjectCaller)
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
              await auctionRebalanceExtension.connect(operator).setProductSettings(
                {
                  collateral: collateralAssetAddress,
                  liveness: BigNumber.from(0),
                  bondAmount: BigNumber.from(0),
                  identifier: utils.formatBytes32String(""),
                  optimisticOracleV3: optimisticOracleV3MockUpgraded.address,
                },
                utils.arrayify(base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z")),
              );
              const proposal = await auctionRebalanceExtension
                .connect(subjectCaller)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposal.product).to.eq(dsEth.address);
              await expect(
                optimisticOracleV3Mock
                  .connect(subjectCaller)
                  .mockAssertionDisputedCallback(
                    auctionRebalanceExtension.address,
                    utils.formatBytes32String("win"),
                  ),
              ).to.not.be.reverted;
              const proposalAfter = await auctionRebalanceExtension
                .connect(subjectCaller)
                .proposedProduct(utils.formatBytes32String("win"));
              expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
            });
          });
          describe("assertionResolvedCallback", () => {
            it("should not revert on a resolved callback", async () => {
              await auctionRebalanceExtension
                .connect(subjectCaller)
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
                  .connect(subjectCaller)
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
          let subjectCaller: Signer;

          beforeEach(async () => {
            subjectRaiseTargetPercentage = ether(0.001);
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension
              .connect(subjectCaller)
              .setRaiseTargetPercentage(subjectRaiseTargetPercentage);
          }

          it("should correctly set the raiseTargetPercentage", async () => {
            await subject();

            const actualRaiseTargetPercentage = (await auctionModule.rebalanceInfo(dsEth.address))
              .raiseTargetPercentage;

            expect(actualRaiseTargetPercentage).to.eq(subjectRaiseTargetPercentage);
          });

          describe("when the caller is not the operator", async () => {
            beforeEach(async () => {
              subjectCaller = (await getRandomAccount()).wallet;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
        });

        describe("#setBidderStatus", () => {
          let subjectBidders: Address[];
          let subjectStatuses: boolean[];
          let subjectCaller: Signer;

          beforeEach(async () => {
            subjectBidders = [methodologist.address];
            subjectStatuses = [true];
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension
              .connect(subjectCaller)
              .setBidderStatus(subjectBidders, subjectStatuses);
          }

          it("should correctly set the bidder status", async () => {
            await subject();

            const isCaller = await auctionModule.isAllowedBidder(dsEth.address, subjectBidders[0]);

            expect(isCaller).to.be.true;
          });

          describe("when the caller is not the operator", () => {
            beforeEach(async () => {
              subjectCaller = (await getRandomAccount()).wallet;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
        });

        describe("#setAnyoneBid", () => {
          let subjectStatus: boolean;
          let subjectCaller: Signer;

          beforeEach(async () => {
            subjectStatus = true;
            subjectCaller = operator;
          });

          async function subject(): Promise<ContractTransaction> {
            return await auctionRebalanceExtension
              .connect(subjectCaller)
              .setAnyoneBid(subjectStatus);
          }

          it("should correctly set anyone bid", async () => {
            await subject();

            const anyoneBid = await auctionModule.permissionInfo(dsEth.address);

            expect(anyoneBid).to.be.true;
          });

          describe("when the caller is not the operator", () => {
            beforeEach(async () => {
              subjectCaller = (await getRandomAccount()).wallet;
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be operator");
            });
          });
        });

        describe("#removeExtension", () => {
          async function subject() {
            return await baseManager
              .connect(operator)
              .removeExtension(auctionRebalanceExtension.address);
          }
          it("should remove the extension", async () => {
            expect(await baseManager.isExtension(auctionRebalanceExtension.address)).to.be.true;
            await subject();
            expect(await baseManager.isExtension(auctionRebalanceExtension.address)).to.be.false;
          });
        });
      });
    });
  });
}
