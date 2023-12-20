import "module-alias/register";

import { Address, Account } from "@utils/types";
import { increaseTimeAsync } from "@utils/test";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { OptimisticAuctionRebalanceExtensionV1 } from "@utils/contracts/index";
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
  IIdentifierWhitelist,
  IIdentifierWhitelist__factory,
  IWETH,
  IWETH__factory,
  OptimisticOracleV3Mock,
  OptimisticOracleV3Interface,
  OptimisticOracleV3Interface__factory,
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
import { ethers } from "hardhat";
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
  describe("OptimisticAuctionRebalanceExtensionV1 - Integration Test dsEth", () => {
    const contractAddresses = PRODUCTION_ADDRESSES;
    let owner: Account;
    let methodologist: Account;
    let operator: Signer;

    let deployer: DeployHelper;
    let dsEth: SetToken;
    let baseManager: BaseManagerV2;

    let auctionModule: AuctionRebalanceModuleV1;
    let auctionRebalanceExtension: OptimisticAuctionRebalanceExtensionV1;
    let integrationRegistry: IntegrationRegistry;

    let priceAdapter: ConstantPriceAdapter;

    // UMA contracts
    let optimisticOracleV3: OptimisticOracleV3Interface;
    let optimisticOracleV3Mock: OptimisticOracleV3Mock;
    let identifierWhitelist: IIdentifierWhitelist;

    let collateralAssetAddress: string;

    let useAssetAllowlist: boolean;
    let allowedAssets: Address[];

    let weth: IWETH;
    let minimumBond: BigNumber;

    setBlockNumber(18789000);

    before(async () => {
      [owner, methodologist] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      priceAdapter = ConstantPriceAdapter__factory.connect(
        contractAddresses.setFork.constantPriceAdapter,
        owner.wallet,
      );
      weth = IWETH__factory.connect(contractAddresses.tokens.weth, owner.wallet);
      collateralAssetAddress = weth.address;

      optimisticOracleV3 = OptimisticOracleV3Interface__factory.connect(
        contractAddresses.oracles.uma.optimisticOracleV3,
        owner.wallet,
      );

      optimisticOracleV3Mock = await deployer.mocks.deployOptimisticOracleV3Mock();

      identifierWhitelist = IIdentifierWhitelist__factory.connect(
        contractAddresses.oracles.uma.identifierWhitelist,
        owner.wallet,
      );
      const whitelistOwner = await impersonateAccount(await identifierWhitelist.owner());
      await ethers.provider.send("hardhat_setBalance", [
        await whitelistOwner.getAddress(),
        ethers.utils.parseEther("10").toHexString(),
      ]);
      identifierWhitelist = identifierWhitelist.connect(whitelistOwner);
      minimumBond = await optimisticOracleV3.getMinimumBond(collateralAssetAddress);

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

      auctionRebalanceExtension = await deployer.extensions.deployOptimisticAuctionRebalanceExtensionV1(
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
        let productSettings: any;
        let identifier: string;
        let liveness: BigNumber;
        beforeEach(async () => {
          identifier = utils.formatBytes32String("TestIdentifier"); // TODO: Check how do we ensure that our identifier is supported on UMAs whitelist
          await identifierWhitelist.addSupportedIdentifier(identifier);
          liveness = BigNumber.from(60 * 60); // 7 days
          productSettings = {
            collateral: collateralAssetAddress,
            liveness,
            bondAmount: BigNumber.from(0),
            identifier,
            optimisticOracleV3: optimisticOracleV3.address,
          };
          await auctionRebalanceExtension
            .connect(operator)
            .setProductSettings(
              productSettings,
              utils.arrayify(base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z")),
            );
        });

        context("when the extension is open to rebalances", () => {
          beforeEach(async () => {
            await auctionRebalanceExtension.updateIsOpen(true);
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
            let effectiveBond: BigNumber;
            beforeEach(async () => {
              effectiveBond = productSettings.bondAmount.gt(minimumBond)
                ? productSettings.bondAmount
                : minimumBond;

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
              subjectOldComponentsAuctionParams = subjectOldComponents.map(
                () => sellAllAuctionParam,
              );

              subjectShouldLockSetToken = false;
              subjectRebalanceDuration = BigNumber.from(86400);
              subjectPositionMultiplier = ether(0.999);
              subjectCaller = operator;

              const quantity = utils
                .parseEther("1000")
                .add(effectiveBond)
                .toHexString();
              // set operator balance to effective bond
              await ethers.provider.send("hardhat_setBalance", [
                await subjectCaller.getAddress(),
                quantity,
              ]);
              await weth.connect(subjectCaller).deposit({ value: effectiveBond });
              await weth
                .connect(subjectCaller)
                .approve(auctionRebalanceExtension.address, effectiveBond);
            });
            describe("#startRebalance", () => {
              async function subject(): Promise<ContractTransaction> {
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

              context("when the rebalance has been proposed", () => {
                let proposalId: string;
                beforeEach(async () => {
                  const tx = await auctionRebalanceExtension
                    .connect(subjectCaller)
                    .proposeRebalance(
                      subjectQuoteAsset,
                      subjectOldComponents,
                      subjectNewComponents,
                      subjectNewComponentsAuctionParams,
                      subjectOldComponentsAuctionParams,
                      subjectRebalanceDuration,
                      subjectPositionMultiplier,
                    );
                  const receipt = await tx.wait();

                  //  @ts-ignore
                  const assertEvent = receipt.events[receipt.events.length - 1] as any;
                  proposalId = assertEvent.args._assertionId;
                });
                context("when the liveness period has passed", () => {
                  beforeEach(async () => {
                    await increaseTimeAsync(liveness.add(1));
                  });

                  context("when the rebalance has been executed once already", () => {
                    beforeEach(async () => {
                      await auctionRebalanceExtension
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
                      await auctionRebalanceExtension.updateIsOpen(true);
                    });
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Proposal hash does not exist");
                    });
                    context("when identical rebalanced again but liveness has not passed", () => {
                      beforeEach(async () => {
                        // set operator balance to effective bond
                        await weth.connect(subjectCaller).deposit({ value: effectiveBond });
                        await weth
                          .connect(subjectCaller)
                          .approve(auctionRebalanceExtension.address, effectiveBond);
                        await auctionRebalanceExtension
                          .connect(subjectCaller)
                          .proposeRebalance(
                            subjectQuoteAsset,
                            subjectOldComponents,
                            subjectNewComponents,
                            subjectNewComponentsAuctionParams,
                            subjectOldComponentsAuctionParams,
                            subjectRebalanceDuration,
                            subjectPositionMultiplier,
                          );
                      });
                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith("Assertion not expired");
                      });
                    });
                  });

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

                    const rebalanceComponents = await auctionModule.getRebalanceComponents(
                      dsEth.address,
                    );
                    const aggregateComponents = [...subjectOldComponents, ...subjectNewComponents];

                    for (let i = 0; i < rebalanceComponents.length; i++) {
                      expect(utils.getAddress(rebalanceComponents[i])).to.eq(
                        utils.getAddress(aggregateComponents[i]),
                      );
                    }
                  });
                });

                describe("assertionDisputedCallback", () => {
                  it("should delete the proposal on a disputed callback", async () => {
                    const proposal = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .proposedProduct(proposalId);

                    expect(proposal.product).to.eq(dsEth.address);

                    await weth.connect(subjectCaller).deposit({ value: effectiveBond });
                    await weth.connect(subjectCaller).approve(optimisticOracleV3.address, effectiveBond);
                    await optimisticOracleV3
                      .connect(subjectCaller)
                      .disputeAssertion(proposalId, owner.address);

                    const proposalAfter = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .proposedProduct(utils.formatBytes32String("win"));
                    expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
                  });
                  it("should delete the proposal on a disputed callback from currently set oracle", async () => {
                    await auctionRebalanceExtension.connect(operator).setProductSettings(
                      {
                        collateral: collateralAssetAddress,
                        liveness,
                        bondAmount: BigNumber.from(0),
                        identifier,
                        optimisticOracleV3: optimisticOracleV3Mock.address,
                      },
                      utils.arrayify(
                        base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z"),
                      ),
                    );
                    const proposal = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .proposedProduct(proposalId);

                    expect(proposal.product).to.eq(dsEth.address);

                    await expect(
                      optimisticOracleV3Mock
                        .connect(subjectCaller)
                        .mockAssertionDisputedCallback(
                          auctionRebalanceExtension.address,
                          proposalId,
                        ),
                    ).to.not.be.reverted;
                    const proposalAfter = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .proposedProduct(proposalId);
                    expect(proposalAfter.product).to.eq(ADDRESS_ZERO);
                  });
                });
              });
              describe("assertionResolvedCallback", () => {
                it("should not revert on a resolved callback", async () => {
                  await auctionRebalanceExtension.connect(operator).setProductSettings(
                    {
                      collateral: collateralAssetAddress,
                      liveness,
                      bondAmount: BigNumber.from(0),
                      identifier,
                      optimisticOracleV3: optimisticOracleV3Mock.address,
                    },
                    utils.arrayify(
                      base58ToHexString("Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z"),
                    ),
                  );
                  const tx = await auctionRebalanceExtension
                    .connect(subjectCaller)
                    .proposeRebalance(
                      subjectQuoteAsset,
                      subjectOldComponents,
                      subjectNewComponents,
                      subjectNewComponentsAuctionParams,
                      subjectOldComponentsAuctionParams,
                      subjectRebalanceDuration,
                      subjectPositionMultiplier,
                    );
                  const receipt = await tx.wait();
                  //  @ts-ignore
                  const assertEvent = receipt.events[receipt.events.length - 1] as any;
                  const proposalId = assertEvent.args._assertionId;

                  await optimisticOracleV3Mock
                    .connect(subjectCaller)
                    .mockAssertionResolvedCallback(
                      auctionRebalanceExtension.address,
                      proposalId,
                      true,
                    );
                });
              });
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
