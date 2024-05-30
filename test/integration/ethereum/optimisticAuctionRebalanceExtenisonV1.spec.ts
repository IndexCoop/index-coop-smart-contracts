import "module-alias/register";

import { Address, Account } from "@utils/types";
import { increaseTimeAsync } from "@utils/test";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ONE_HOUR_IN_SECONDS, ZERO } from "@utils/constants";
import { OptimisticAuctionRebalanceExtensionV1 } from "@utils/contracts/index";
import {
  AuctionRebalanceModuleV1,
  AuctionRebalanceModuleV1__factory,
  BoundedStepwiseLinearPriceAdapter,
  BoundedStepwiseLinearPriceAdapter__factory,
  SetToken,
  SetToken__factory,
  BaseManagerV2,
  BaseManagerV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  IIdentifierWhitelist,
  IIdentifierWhitelist__factory,
  IERC20,
  IERC20__factory,
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
  getTransactionTimestamp,
  getRandomAccount,
} from "@utils/index";
import { BigNumber, ContractTransaction, utils, Signer } from "ethers";
import { ethers } from "hardhat";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("OptimisticAuctionRebalanceExtensionV1 - Integration Test dsEth", () => {
    const contractAddresses = PRODUCTION_ADDRESSES;

    const rules = "Rules stored on ipfs under hash: Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z";
    const liveness = BigNumber.from(60 * 60 * 24 * 2); // 2 days
    const minimumBond = ether(140); // 140 INDEX Minimum Bond

    let owner: Account;
    let methodologist: Account;
    let operator: Signer;

    let deployer: DeployHelper;
    let dsEth: SetToken;
    let baseManager: BaseManagerV2;

    let auctionModule: AuctionRebalanceModuleV1;
    let auctionRebalanceExtension: OptimisticAuctionRebalanceExtensionV1;
    let integrationRegistry: IntegrationRegistry;

    let priceAdapter: BoundedStepwiseLinearPriceAdapter;

    // UMA contracts
    let optimisticOracleV3: OptimisticOracleV3Interface;
    let optimisticOracleV3Mock: OptimisticOracleV3Mock;
    let identifierWhitelist: IIdentifierWhitelist;

    let collateralAssetAddress: string;

    let useAssetAllowlist: boolean;
    let allowedAssets: Address[];

    let indexToken: IERC20;

    setBlockNumber(18924016);

    before(async () => {
      [owner, methodologist] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      priceAdapter = BoundedStepwiseLinearPriceAdapter__factory.connect(
        contractAddresses.setFork.linearPriceAdapter,
        owner.wallet,
      );
      indexToken = IERC20__factory.connect(contractAddresses.tokens.index, owner.wallet);
      collateralAssetAddress = indexToken.address;

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

      useAssetAllowlist = true;
      allowedAssets = [contractAddresses.tokens.swETH, contractAddresses.tokens.ETHx]; // New dsETH components

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

    async function getIndexTokens(receiver: string, amount: BigNumber): Promise<void> {
      const INDEX_TOKEN_WHALE = "0x9467cfADC9DE245010dF95Ec6a585A506A8ad5FC";
      const indexWhaleSinger = await impersonateAccount(INDEX_TOKEN_WHALE);
      await indexToken.connect(indexWhaleSinger).transfer(receiver, amount);
    }

    addSnapshotBeforeRestoreAfterEach();

    context("when auction rebalance extension is added as extension", () => {
      beforeEach(async () => {
        await baseManager.addExtension(auctionRebalanceExtension.address);
      });

      context("when the product settings have been set", () => {
        let productSettings: any;
        let identifier: string;

        beforeEach(async () => {
          identifier = "0x4153534552545f54525554480000000000000000000000000000000000000000"; // ASSERT_TTH identifier

          productSettings = {
            collateral: collateralAssetAddress,
            liveness,
            bondAmount: minimumBond,
            identifier,
            optimisticOracleV3: optimisticOracleV3.address,
          };

          await auctionRebalanceExtension
            .connect(operator)
            .setProductSettings(productSettings, rules);
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

              subjectNewComponents = [
                contractAddresses.tokens.swETH,
                contractAddresses.tokens.ETHx,
              ];
              subjectNewComponentsAuctionParams = [
                {
                  // swETH: https://etherscan.io/address/0xf951E335afb289353dc249e82926178EaC7DEd78#readProxyContract#F6
                  targetUnit: "155716754710815260",
                  priceAdapterName: "BoundedStepwiseLinearPriceAdapter",
                  priceAdapterConfigData: await priceAdapter.getEncodedData(
                    ether(1.043),
                    ether(0.0005),
                    ONE_HOUR_IN_SECONDS,
                    false,
                    ether(1.05),
                    ether(1.043),
                  ),
                },
                {
                  // ETHx: https://etherscan.io/address/0xcf5ea1b38380f6af39068375516daf40ed70d299#readProxyContract#F5
                  targetUnit: "162815732702576500",
                  priceAdapterName: "BoundedStepwiseLinearPriceAdapter",
                  priceAdapterConfigData: await priceAdapter.getEncodedData(
                    ether(1.014),
                    ether(0.0005),
                    ONE_HOUR_IN_SECONDS,
                    false,
                    ether(1.02),
                    ether(1.014),
                  ),
                },
              ];

              subjectOldComponentsAuctionParams = [
                { // wstETH: https://etherscan.io/address/0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0#readContract#F10
                  targetUnit: "148503139447300450",
                  priceAdapterName: "BoundedStepwiseLinearPriceAdapter",
                  priceAdapterConfigData: await priceAdapter.getEncodedData(
                    ether(1.155),
                    ether(0.001),
                    ONE_HOUR_IN_SECONDS,
                    true,
                    ether(1.155),
                    ether(1.149),
                  ),
                },
                { // rETH: https://etherscan.io/address/0xae78736Cd615f374D3085123A210448E74Fc6393#readContract#F6
                  targetUnit: "233170302540761920",
                  priceAdapterName: "BoundedStepwiseLinearPriceAdapter",
                  priceAdapterConfigData: await priceAdapter.getEncodedData(
                    ether(1.097),
                    ether(0.001),
                    ONE_HOUR_IN_SECONDS,
                    true,
                    ether(1.097),
                    ether(1.091),
                  ),
                },
                { // sfrxETH: https://etherscan.io/address/0xac3E018457B222d93114458476f3E3416Abbe38F#readContract#F20
                  targetUnit: "123631627061020350",
                  priceAdapterName: "BoundedStepwiseLinearPriceAdapter",
                  priceAdapterConfigData: await priceAdapter.getEncodedData(
                    ether(1.073),
                    ether(0.001),
                    ONE_HOUR_IN_SECONDS,
                    true,
                    ether(1.073),
                    ether(1.067),
                  ),
                },
                { // osETH: https://etherscan.io/address/0x8023518b2192fb5384dadc596765b3dd1cdfe471#readContract#F3
                  targetUnit: "153017509830141340",
                  priceAdapterName: "BoundedStepwiseLinearPriceAdapter",
                  priceAdapterConfigData: await priceAdapter.getEncodedData(
                    ether(1.005),
                    ether(0.001),
                    ONE_HOUR_IN_SECONDS,
                    true,
                    ether(1.005),
                    ether(1.004),
                  ),
                },
              ];

              subjectShouldLockSetToken = false;
              subjectRebalanceDuration = BigNumber.from(60 * 60 * 24 * 3);
              subjectPositionMultiplier = await dsEth.positionMultiplier();
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

              await getIndexTokens(await subjectCaller.getAddress(), effectiveBond);
              await indexToken
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
                        await getIndexTokens(await subjectCaller.getAddress(), effectiveBond);
                        await indexToken
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
                    const proposalHash = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .assertionIdToProposalHash(proposalId);

                    expect(proposalHash).to.not.eq(ethers.constants.HashZero);

                    await getIndexTokens(await subjectCaller.getAddress(), effectiveBond);
                    await indexToken
                      .connect(subjectCaller)
                      .approve(optimisticOracleV3.address, effectiveBond);
                    await optimisticOracleV3
                      .connect(subjectCaller)
                      .disputeAssertion(proposalId, owner.address);

                    const proposalHashAfter = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .assertionIdToProposalHash(proposalId);

                    expect(proposalHashAfter).to.eq(ethers.constants.HashZero);
                  });

                  it("should delete the proposal on a disputed callback from currently set oracle", async () => {
                    await auctionRebalanceExtension.connect(operator).setProductSettings(
                      {
                        collateral: collateralAssetAddress,
                        liveness,
                        bondAmount: minimumBond,
                        identifier,
                        optimisticOracleV3: optimisticOracleV3Mock.address,
                      },
                      rules,
                    );

                    const proposalHash = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .assertionIdToProposalHash(proposalId);
                    expect(proposalHash).to.not.eq(ethers.constants.HashZero);

                    await expect(
                      optimisticOracleV3Mock
                        .connect(subjectCaller)
                        .mockAssertionDisputedCallback(
                          auctionRebalanceExtension.address,
                          proposalId,
                        ),
                    ).to.not.be.reverted;
                    const proposalHashAfter = await auctionRebalanceExtension
                      .connect(subjectCaller)
                      .assertionIdToProposalHash(proposalId);
                    expect(proposalHashAfter).to.eq(ethers.constants.HashZero);
                  });
                });
              });
              describe("assertionResolvedCallback", () => {
                it("should not revert on a resolved callback", async () => {
                  await auctionRebalanceExtension.connect(operator).setProductSettings(
                    {
                      collateral: collateralAssetAddress,
                      liveness,
                      bondAmount: minimumBond,
                      identifier,
                      optimisticOracleV3: optimisticOracleV3Mock.address,
                    },
                    rules,
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
