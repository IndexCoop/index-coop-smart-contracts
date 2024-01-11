import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import {
  BaseManager,
  ConstantPriceAdapter,
  OptimisticAuctionRebalanceExtensionV1,
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
import { BigNumber, ContractTransaction, utils, constants } from "ethers";

const expect = getWaffleExpect();

describe("OptimisticAuctionRebalanceExtensionV1", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let baseManager: BaseManager;

  let auctionRebalanceExtension: OptimisticAuctionRebalanceExtensionV1;

  let priceAdapter: ConstantPriceAdapter;

  let optimisticOracleV3Mock: OptimisticOracleV3Mock;

  let optimisticOracleV3MockUpgraded: OptimisticOracleV3Mock;

  let collateralAsset: StandardTokenMock;

  let useAssetAllowlist: boolean;
  let allowedAssets: Address[];

  const ipfsHash = "Qmc5gCcjYypU7y28oCALwfSvxCBskLuPKWpK4qpterKC7z";

  before(async () => {
    [owner, methodologist, operator] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    priceAdapter = await deployer.setV2.deployConstantPriceAdapter();
    optimisticOracleV3Mock = await deployer.mocks.deployOptimisticOracleV3Mock();
    optimisticOracleV3MockUpgraded = await deployer.mocks.deployOptimisticOracleV3Mock();
    collateralAsset = await deployer.mocks.deployStandardTokenMock(operator.address, 18);

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

    auctionRebalanceExtension = await deployer.extensions.deployOptimisticAuctionRebalanceExtensionV1(
      baseManager.address,
      setV2Setup.auctionModule.address,
      useAssetAllowlist,
      allowedAssets,
    );
    auctionRebalanceExtension = auctionRebalanceExtension.connect(operator.wallet);
    await collateralAsset
      .connect(operator.wallet)
      .approve(auctionRebalanceExtension.address, ether(1000));
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

    function subject(): Promise<OptimisticAuctionRebalanceExtensionV1> {
      return deployer.extensions.deployOptimisticAuctionRebalanceExtensionV1(
        subjectBaseManager,
        subjectAuctionRebalanceModule,
        subjectUseAssetAllowlist,
        subjectAllowedAssets,
      );
    }

    it("should set the correct base manager", async () => {
      const auctionExtension = await subject();

      const actualBaseManager = await auctionExtension.manager();
      expect(actualBaseManager).to.eq(subjectBaseManager);
    });

    it("should set the correct auction rebalance module address", async () => {
      const auctionExtension = await subject();

      const actualAuctionRebalanceModule = await auctionExtension.auctionModule();
      expect(actualAuctionRebalanceModule).to.eq(subjectAuctionRebalanceModule);
    });
  });

  describe("#updateUseAssetAllowlist", () => {
    let subjectCaller: Account;
    let subjectNewValue: boolean;
    function subject() {
      return auctionRebalanceExtension
        .connect(subjectCaller.wallet)
        .updateUseAssetAllowlist(subjectNewValue);
    }
    beforeEach(async () => {
      subjectCaller = operator;
    });
    [true, false].forEach((useAssetAllowlist: boolean) => {
      describe(`when setting value to ${useAssetAllowlist}`, () => {
        beforeEach(async () => {
          subjectNewValue = useAssetAllowlist;
          await auctionRebalanceExtension
            .connect(operator.wallet)
            .updateUseAssetAllowlist(!subjectNewValue);
        });

        it("should update the useAssetAllowlist correctly", async () => {
          await subject();
          const actualUseAssetAllowlist = await auctionRebalanceExtension.useAssetAllowlist();
          expect(actualUseAssetAllowlist).to.eq(subjectNewValue);
        });
      });
    });
    context("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = methodologist;
        subjectNewValue = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#removeAllowedAssets", () => {
    let subjectCaller: Account;
    let subjectRemovedAssets: Address[];
    async function subject() {
      return await auctionRebalanceExtension
        .connect(subjectCaller.wallet)
        .removeAllowedAssets(subjectRemovedAssets);
    }
    beforeEach(async () => {
      subjectRemovedAssets = [collateralAsset.address];
      subjectCaller = operator;
      await auctionRebalanceExtension
        .connect(operator.wallet)
        .addAllowedAssets(subjectRemovedAssets);
    });

    it("should add the new assets to the allowed assets", async () => {
      await subject();
      for (let i = 0; i < subjectRemovedAssets.length; i++) {
        const isAllowed = await auctionRebalanceExtension.assetAllowlist(subjectRemovedAssets[i]);
        expect(isAllowed).to.be.false;
      }
    });

    it("should emit AllowedAssetAdded event", async () => {
      const promise = subject();
      for (let i = 0; i < subjectRemovedAssets.length; i++) {
        await expect(promise)
          .to.emit(auctionRebalanceExtension, "AllowedAssetRemoved")
          .withArgs(subjectRemovedAssets[i]);
      }
    });

    context("If the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#addAllowedAssets", () => {
    let subjectCaller: Account;
    let subjectNewAssets: Address[];
    async function subject() {
      return await auctionRebalanceExtension
        .connect(subjectCaller.wallet)
        .addAllowedAssets(subjectNewAssets);
    }
    beforeEach(async () => {
      subjectCaller = operator;
      subjectNewAssets = [collateralAsset.address];
    });

    it("should add the new assets to the allowed assets", async () => {
      await subject();
      for (let i = 0; i < subjectNewAssets.length; i++) {
        const isAllowed = await auctionRebalanceExtension.assetAllowlist(subjectNewAssets[i]);
        expect(isAllowed).to.be.true;
      }
    });

    it("should emit AllowedAssetAdded event", async () => {
      const promise = subject();
      for (let i = 0; i < subjectNewAssets.length; i++) {
        await expect(promise)
          .to.emit(auctionRebalanceExtension, "AllowedAssetAdded")
          .withArgs(subjectNewAssets[i]);
      }
    });

    context("If the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  context(
    "when auction rebalance extension is added as adapter and needs to be initialized",
    () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
        await baseManager.addAdapter(auctionRebalanceExtension.address);
      });

      describe("#initialize", () => {
        async function subject() {
          return await auctionRebalanceExtension.connect(subjectCaller.wallet).initialize();
        }

        it("should initialize AuctionRebalanceModule", async () => {
          await subject();
          const isInitialized = await setToken.isInitializedModule(
            setV2Setup.auctionModule.address,
          );
          expect(isInitialized).to.be.true;
        });

        describe("when the initializer is not the operator", () => {
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
          await auctionRebalanceExtension.connect(operator.wallet).initialize();
        });

        context("when the product settings have been set", () => {
          let rules: string;
          let bondAmount: BigNumber;
          beforeEach(async () => {
            rules = ipfsHash;
            bondAmount = ether(140); // 140 INDEX minimum bond
            await auctionRebalanceExtension.connect(operator.wallet).setProductSettings(
              {
                collateral: collateralAsset.address,
                liveness: BigNumber.from(60 * 60), // 7 days
                bondAmount,
                identifier: utils.formatBytes32String(""),
                optimisticOracleV3: optimisticOracleV3Mock.address,
              },
              rules,
            );
          });

          context("When the rebalance settings are set correctly", () => {
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

              subjectShouldLockSetToken = false;
              subjectRebalanceDuration = BigNumber.from(86400);
              subjectPositionMultiplier = ether(0.999);
              subjectCaller = operator;
            });

            async function proposeRebalance(): Promise<ContractTransaction> {
              await auctionRebalanceExtension.updateIsOpen(true);
              return auctionRebalanceExtension
                .connect(subjectCaller.wallet)
                .proposeRebalance(
                  subjectQuoteAsset,
                  subjectOldComponents,
                  subjectNewComponents,
                  subjectNewComponentsAuctionParams,
                  subjectOldComponentsAuctionParams,
                  subjectRebalanceDuration,
                  subjectPositionMultiplier,
                );
            }

            describe("#proposeRebalance", () => {
              async function subject(): Promise<ContractTransaction> {
                return auctionRebalanceExtension
                  .connect(subjectCaller.wallet)
                  .proposeRebalance(
                    subjectQuoteAsset,
                    subjectOldComponents,
                    subjectNewComponents,
                    subjectNewComponentsAuctionParams,
                    subjectOldComponentsAuctionParams,
                    subjectRebalanceDuration,
                    subjectPositionMultiplier,
                  );
              }

              function constructClaim(): string {
                const abi = utils.defaultAbiCoder;
                const proposalHash = utils.keccak256(
                  abi.encode(
                    [
                      "address",
                      "address",
                      "address[]",
                      "address[]",
                      "(uint256,string,bytes)[]",
                      "(uint256,string,bytes)[]",
                      "bool",
                      "uint256",
                      "uint256",
                    ],
                    [
                      setToken.address,
                      subjectQuoteAsset,
                      subjectOldComponents,
                      subjectNewComponents,
                      subjectNewComponentsAuctionParams.map(component => [
                        component.targetUnit,
                        component.priceAdapterName,
                        component.priceAdapterConfigData,
                      ]),
                      subjectOldComponentsAuctionParams.map(component => [
                        component.targetUnit,
                        component.priceAdapterName,
                        component.priceAdapterConfigData,
                      ]),
                      false, // We don't allow locking the set token in this version
                      subjectRebalanceDuration,
                      subjectPositionMultiplier,
                    ],
                  ),
                );
                return `proposalHash:${proposalHash.slice(2)},rules:"${rules}"`;
              }

              context("when the extension is open for rebalance", () => {
                beforeEach(async () => {
                  await auctionRebalanceExtension.updateIsOpen(true);
                });

                it("should not revert", async () => {
                  await subject();
                });

                it("should update proposal hash correctly", async () => {
                  const proposalHashBefore = await auctionRebalanceExtension
                    .connect(subjectCaller.wallet)
                    .assertionIdToProposalHash(utils.formatBytes32String("win"));
                  expect(proposalHashBefore).to.eq(constants.HashZero);

                  await subject();

                  const proposalHashAfter = await auctionRebalanceExtension
                    .connect(subjectCaller.wallet)
                    .assertionIdToProposalHash(utils.formatBytes32String("win"));
                  expect(proposalHashAfter).to.not.eq(constants.HashZero);
                });

                it("should pull bond", async () => {
                  const collateralBalanceBefore = await collateralAsset.balanceOf(
                    subjectCaller.address,
                  );
                  await subject();
                  const collateralBalanceAfter = await collateralAsset.balanceOf(
                    subjectCaller.address,
                  );
                  expect(collateralBalanceAfter).to.eq(collateralBalanceBefore.sub(bondAmount));
                });

                it("should emit RebalanceProposed event", async () => {
                  const receipt = (await subject().then(tx => tx.wait())) as any;
                  const proposeEvent = receipt.events.find(
                    (event: any) => event.event === "RebalanceProposed",
                  );
                  expect(proposeEvent.args.setToken).to.eq(setToken.address);
                  expect(proposeEvent.args.quoteAsset).to.eq(subjectQuoteAsset);
                  expect(proposeEvent.args.oldComponents).to.deep.eq(subjectOldComponents);
                  expect(proposeEvent.args.newComponents).to.deep.eq(subjectNewComponents);
                  expect(proposeEvent.args.rebalanceDuration).to.eq(subjectRebalanceDuration);
                  expect(proposeEvent.args.positionMultiplier).to.eq(subjectPositionMultiplier);

                  const newComponentsAuctionParams = proposeEvent.args.newComponentsAuctionParams.map(
                    (entry: any) => {
                      return {
                        priceAdapterConfigData: entry.priceAdapterConfigData,
                        priceAdapterName: entry.priceAdapterName,
                        targetUnit: entry.targetUnit,
                      };
                    },
                  );
                  expect(newComponentsAuctionParams).to.deep.eq(subjectNewComponentsAuctionParams);

                  const oldComponentsAuctionParams = proposeEvent.args.oldComponentsAuctionParams.map(
                    (entry: any) => {
                      return {
                        priceAdapterConfigData: entry.priceAdapterConfigData,
                        priceAdapterName: entry.priceAdapterName,
                        targetUnit: entry.targetUnit,
                      };
                    },
                  );
                  expect(oldComponentsAuctionParams).to.deep.eq(subjectOldComponentsAuctionParams);
                });

                it("should emit AssertedClaim event", async () => {
                  const receipt = (await subject().then(tx => tx.wait())) as any;
                  const assertEvent = receipt.events.find(
                    (event: any) => event.event === "AssertedClaim",
                  );
                  const emittedSetToken = assertEvent.args.setToken;
                  expect(emittedSetToken).to.eq(setToken.address);
                  const assertedBy = assertEvent.args._assertedBy;
                  expect(assertedBy).to.eq(operator.wallet.address);
                  const emittedRules = assertEvent.args.rules;
                  expect(emittedRules).to.eq(rules);
                  const claim = assertEvent.args._claimData;
                  expect(utils.toUtf8String(claim)).to.eq(constructClaim());
                });

                context("when the same rebalance has been proposed already", () => {
                  beforeEach(async () => {
                    await subject();
                  });

                  it("should revert", async () => {
                    await expect(subject()).to.be.revertedWith("Proposal already exists");
                  });
                });

                context("when asset allow list is activated", () => {
                  beforeEach(async () => {
                    await auctionRebalanceExtension.updateUseAssetAllowlist(true);
                  });

                  context("when new assets are not on the allow list", () => {
                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Invalid asset");
                    });
                  });

                  context("when new assets are on the allow list", () => {
                    beforeEach(async () => {
                      await auctionRebalanceExtension.addAllowedAssets(subjectNewComponents);
                    });

                    it("should not revert", async () => {
                      await subject();
                    });
                  });
                });
                context("when the rule hash is empty", () => {
                  beforeEach(async () => {
                    const currentSettings = await auctionRebalanceExtension.productSettings();
                    await auctionRebalanceExtension.setProductSettings(
                      currentSettings.optimisticParams,
                      "",
                    );
                  });

                  it("should revert", async () => {
                    await expect(subject()).to.be.revertedWith("Rules not set");
                  });
                });

                context("when the oracle address is zero", () => {
                  beforeEach(async () => {
                    const [
                      currentOptimisticParams,
                      ruleHash,
                    ] = await auctionRebalanceExtension.productSettings();
                    const optimisticParams = {
                      ...currentOptimisticParams,
                      optimisticOracleV3: constants.AddressZero,
                    };
                    await auctionRebalanceExtension.setProductSettings(optimisticParams, ruleHash);
                  });

                  it("should revert", async () => {
                    await expect(subject()).to.be.revertedWith("Oracle not set");
                  });
                });
              });

              context("when the extension is not open for rebalance", () => {
                beforeEach(async () => {
                  await auctionRebalanceExtension.updateIsOpen(false);
                });

                it("should revert", async () => {
                  expect(subject()).to.be.revertedWith("Must be open for rebalancing");
                });
              });
            });

            describe("#startRebalance", () => {
              async function subject(): Promise<ContractTransaction> {
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
              describe("when old components are passed in different order", () => {
                beforeEach(async () => {
                  subjectOldComponents = [
                    setV2Setup.dai.address,
                    setV2Setup.weth.address,
                    setV2Setup.wbtc.address,
                  ];
                  await proposeRebalance();
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith(
                    "Mismatch: old and current components",
                  );
                });
              });

              describe("when any parameter is different from the proposedRebalance", () => {
                beforeEach(async () => {
                  await proposeRebalance();
                  subjectPositionMultiplier = subjectPositionMultiplier.add(1);
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith("Proposal hash does not exist");
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
                  await proposeRebalance();
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
                  await proposeRebalance();
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
                  await proposeRebalance();
                });

                it("should revert", async () => {
                  await expect(subject()).to.be.revertedWith(
                    "Mismatch: old and current components",
                  );
                });
              });
              context("when the rebalance has been proposed", () => {
                beforeEach(async () => {
                  await proposeRebalance();
                });
                it("should set isOpen to false", async () => {
                  await subject();
                  const isOpen = await auctionRebalanceExtension.isOpen();
                  expect(isOpen).to.be.false;
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
                  const aggregateComponents = [...subjectOldComponents, ...subjectNewComponents];

                  for (let i = 0; i < rebalanceComponents.length; i++) {
                    expect(rebalanceComponents[i]).to.eq(aggregateComponents[i]);
                  }
                });

                describe("#assertionDisputedCallback", () => {
                  let subjectAssertionId: string;
                  function subject(): Promise<any> {
                    return optimisticOracleV3Mock
                      .connect(subjectCaller.wallet)
                      .mockAssertionDisputedCallback(
                        auctionRebalanceExtension.address,
                        subjectAssertionId,
                      );
                  }
                  beforeEach(() => {
                    subjectAssertionId = utils.formatBytes32String("win");
                  });

                  context("when the caller is not the oracle", () => {
                    function subject(): Promise<any> {
                      return auctionRebalanceExtension
                        .connect(subjectCaller.wallet)
                        .assertionDisputedCallback(subjectAssertionId);
                    }
                    context("when the assertionId is wrong", () => {
                      beforeEach(async () => {
                        subjectAssertionId = utils.formatBytes32String("wrongid");
                      });

                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith("Invalid proposal hash");
                      });
                    });
                    context("when the oracle does not have the assertion", () => {
                      it("should delete the proposal", async () => {
                        const proposalHash = await auctionRebalanceExtension
                          .connect(subjectCaller.wallet)
                          .assertionIdToProposalHash(utils.formatBytes32String("win"));
                        expect(proposalHash).to.not.eq(constants.HashZero);

                        await subject();

                        const proposalHashAfter = await auctionRebalanceExtension
                          .connect(subjectCaller.wallet)
                          .assertionIdToProposalHash(utils.formatBytes32String("win"));
                        expect(proposalHashAfter).to.eq(constants.HashZero);
                      });
                    });

                    context("when the oracle has the assertion", () => {
                      beforeEach(async () => {
                        await optimisticOracleV3Mock.setAsserter(subjectCaller.wallet.address);
                      });
                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith("Oracle has assertion");
                      });
                    });
                  });

                  context("when the oracle address is zero", () => {
                    beforeEach(async () => {
                      const [
                        currentOptimisticParams,
                        ruleHash,
                      ] = await auctionRebalanceExtension.productSettings();
                      const optimisticParams = {
                        ...currentOptimisticParams,
                        optimisticOracleV3: constants.AddressZero,
                      };
                      await auctionRebalanceExtension.setProductSettings(
                        optimisticParams,
                        ruleHash,
                      );
                    });

                    it("should revert", async () => {
                      await expect(subject()).to.be.revertedWith("Invalid oracle address");
                    });
                  });

                  it("should delete the proposal on a disputed callback", async () => {
                    const proposalHash = await auctionRebalanceExtension
                      .connect(subjectCaller.wallet)
                      .assertionIdToProposalHash(utils.formatBytes32String("win"));
                    expect(proposalHash).to.not.eq(constants.HashZero);

                    await subject();

                    const proposalHashAfter = await auctionRebalanceExtension
                      .connect(subjectCaller.wallet)
                      .assertionIdToProposalHash(utils.formatBytes32String("win"));
                    expect(proposalHashAfter).to.eq(constants.HashZero);
                  });

                  it("should delete the proposal on a disputed callback from currently set oracle", async () => {
                    await auctionRebalanceExtension.connect(operator.wallet).setProductSettings(
                      {
                        collateral: collateralAsset.address,
                        liveness: BigNumber.from(0),
                        bondAmount: BigNumber.from(0),
                        identifier: utils.formatBytes32String(""),
                        optimisticOracleV3: optimisticOracleV3MockUpgraded.address,
                      },
                      ipfsHash,
                    );

                    const proposalHash = await auctionRebalanceExtension
                      .connect(subjectCaller.wallet)
                      .assertionIdToProposalHash(utils.formatBytes32String("win"));
                    expect(proposalHash).to.not.eq(constants.HashZero);
                    await subject();

                    const proposalHashAfter = await auctionRebalanceExtension
                      .connect(subjectCaller.wallet)
                      .assertionIdToProposalHash(utils.formatBytes32String("win"));
                    expect(proposalHashAfter).to.eq(constants.HashZero);
                  });
                });

                describe("assertionResolvedCallback", () => {
                  it("should not revert on a resolved callback", async () => {
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

                describe("when the caller is not the operator", () => {
                  beforeEach(async () => {
                    subjectCaller = await getRandomAccount();
                  });

                  it("should not revert", async () => {
                    await subject();
                  });
                });
              });

              describe("when there are no new components", () => {
                beforeEach(async () => {
                  subjectNewComponents = [];
                  subjectNewComponentsAuctionParams = [];
                  await proposeRebalance();
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
                .setRaiseTargetPercentage(subjectRaiseTargetPercentage);
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
                .setBidderStatus(subjectBidders, subjectStatuses);
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
    },
  );
});
