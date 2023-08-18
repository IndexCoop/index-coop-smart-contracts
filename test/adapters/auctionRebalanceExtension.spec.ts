import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { AuctionRebalanceExtension, BaseManagerV2, ConstantPriceAdapter } from "@utils/contracts/index";
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
  increaseTimeAsync,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("AuctionRebalanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let approvedCaller: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManagerV2;
  let auctionExtension: AuctionRebalanceExtension;

  let priceAdapter: ConstantPriceAdapter;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      approvedCaller,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    priceAdapter = await deployer.setV2.deployConstantPriceAdapter();

    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.auctionModule.address,
      "ConstantPriceAdapter",
      priceAdapter.address
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

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectAuctionRebalanceModule: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectAuctionRebalanceModule = setV2Setup.auctionModule.address;
    });

    async function subject(): Promise<AuctionRebalanceExtension> {
      return await deployer.extensions.deployAuctionRebalanceExtension(
        subjectManager,
        subjectAuctionRebalanceModule
      );
    }

    it("should set the correct SetToken address", async () => {
      const auctionExtension = await subject();

      const actualToken = await auctionExtension.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const auctionExtension = await subject();

      const actualManager = await auctionExtension.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct auction rebalance module address", async () => {
      const auctionExtension = await subject();

      const actualAuctionRebalanceModule = await auctionExtension.auctionModule();
      expect(actualAuctionRebalanceModule).to.eq(subjectAuctionRebalanceModule);
    });
  });

  context("when auction rebalance extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      auctionExtension = await deployer.extensions.deployAuctionRebalanceExtension(
        baseManagerV2.address,
        setV2Setup.auctionModule.address
      );

      await baseManagerV2.connect(operator.wallet).addExtension(auctionExtension.address);

      await auctionExtension.connect(operator.wallet).updateCallerStatus([approvedCaller.address], [true]);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await auctionExtension.connect(subjectCaller.wallet).initialize();
      }

      it("should initialize AuctionRebalanceModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.auctionModule.address);
        expect(isInitialized).to.be.true;
      });

      describe("when the operator is not the caller", async () => {
        beforeEach(async () => {
          subjectCaller = approvedCaller;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when auction rebalance extension is deployed and system fully set up", async () => {
      beforeEach(async () => {
        await auctionExtension.connect(operator.wallet).initialize();
      });

      describe("#startRebalance", async () => {
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
        });

        async function subject(): Promise<ContractTransaction> {
          return await auctionExtension.connect(subjectCaller.wallet).startRebalance(
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

        describe("when there are no new components", async () => {
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

        describe("when old components are passed in different order", async () => {
          beforeEach(async () => {
            subjectOldComponents = [setV2Setup.dai.address, setV2Setup.weth.address, setV2Setup.wbtc.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Input old components array must match the current components array.");
          });
        });

        describe("when old components array is shorter than current components array", async () => {
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
            await expect(subject()).to.be.revertedWith("Old components length must match the current components length.");
          });
        });

        describe("when old components array is longer than current components array", async () => {
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
            await expect(subject()).to.be.revertedWith("Old components length must match the current components length.");
          });
        });

        describe("when not all old components have an entry", async () => {
          beforeEach(async () => {
            subjectOldComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.usdc.address];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Input old components array must match the current components array.");
          });
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#unlock", async () => {
        let subjectCaller: Account;

        beforeEach(async () => {
          const oldComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address];

          const oldComponentsAuctionParams = [
            {
              targetUnit: ether(100),
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

          await auctionExtension.connect(operator.wallet).startRebalance(
            setV2Setup.weth.address,
            oldComponents,
            [],
            [],
            oldComponentsAuctionParams,
            true,
            BigNumber.from(5),
            ether(.999)
          );

          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          await increaseTimeAsync(BigNumber.from(6));
          return await auctionExtension.connect(subjectCaller.wallet).unlock();
        }

        it("should unlock the SetToken", async () => {
          const isLockedBefore = await setToken.isLocked();
          expect(isLockedBefore).to.be.true;

          await subject();

          const isLockedAfter = await setToken.isLocked();
          expect(isLockedAfter).to.be.false;
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setRaiseTargetPercentage", async () => {
        let subjectRaiseTargetPercentage: BigNumber;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectRaiseTargetPercentage = ether(.001);
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await auctionExtension.connect(subjectCaller.wallet).setRaiseTargetPercentage(
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
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setBidderStatus", async () => {
        let subjectBidders: Address[];
        let subjectStatuses: boolean[];
        let subjectCaller: Account;

        beforeEach(async () => {
            subjectBidders = [methodologist.address];
          subjectStatuses = [true];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await auctionExtension.connect(subjectCaller.wallet).setBidderStatus(
            subjectBidders,
            subjectStatuses
          );
        }

        it("should correctly set the bidder status", async () => {
          await subject();

          const isCaller = await setV2Setup.auctionModule.isAllowedBidder(setToken.address, subjectBidders[0]);

          expect(isCaller).to.be.true;
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setAnyoneBid", async () => {
        let subjectStatus: boolean;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectStatus = true;
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await auctionExtension.connect(subjectCaller.wallet).setAnyoneBid(
            subjectStatus
          );
        }

        it("should correctly set anyone bid", async () => {
          await subject();

          const anyoneBid = await setV2Setup.auctionModule.permissionInfo(setToken.address);

          expect(anyoneBid).to.be.true;
        });

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });
    });
  });
});
