import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { GIMAdapter, BaseManager } from "@utils/contracts/index";
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
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe.only("GIMAdapter", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let approvedCaller: Account;

  let uniswapV2: Account;
  let uniswapV3: Account;
  let sushiswap: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManager;
  let gimAdapter: GIMAdapter;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      approvedCaller,
      uniswapV2,
      uniswapV3,
      sushiswap,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.generalIndexModule.address,
      "UniswapV2IndexExchangeAdapter",
      uniswapV2.address
    );

    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.generalIndexModule.address,
      "UniswapV3IndexExchangeAdapter",
      uniswapV3.address
    );

    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.generalIndexModule.address,
      "SushiswapIndexExchangeAdapter",
      sushiswap.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address],
      [ether(100), bitcoin(.01), ether(.1)],
      [setV2Setup.generalIndexModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManager(
      setToken.address,
      operator.address,
      methodologist.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectGeneralIndexModule: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectGeneralIndexModule = setV2Setup.governanceModule.address;
    });

    async function subject(): Promise<GIMAdapter> {
      return await deployer.adapters.deployGIMAdapter(
        subjectManager,
        subjectGeneralIndexModule
      );
    }

    it("should set the correct SetToken address", async () => {
      const gimAdapter = await subject();

      const actualToken = await gimAdapter.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const gimAdapter = await subject();

      const actualManager = await gimAdapter.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct general index module address", async () => {
      const gimAdapter = await subject();

      const actualGeneralIndexModule = await gimAdapter.generalIndexModule();
      expect(actualGeneralIndexModule).to.eq(subjectGeneralIndexModule);
    });
  });

  context("when GIM adapter is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      gimAdapter = await deployer.adapters.deployGIMAdapter(
        baseManagerV2.address,
        setV2Setup.generalIndexModule.address
      );

      await baseManagerV2.connect(operator.wallet).addAdapter(gimAdapter.address);

      await gimAdapter.connect(operator.wallet).updateCallerStatus([approvedCaller.address], [true]);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
    });

    async function getAssetExecutionInfo(): Promise<any[]> {
      const daiExecInfo = await setV2Setup.generalIndexModule.executionInfo(setToken.address, setV2Setup.dai.address);
      const wbtcExecInfo = await setV2Setup.generalIndexModule.executionInfo(setToken.address, setV2Setup.wbtc.address);
      const wethExecInfo = await setV2Setup.generalIndexModule.executionInfo(setToken.address, setV2Setup.weth.address);
      const usdcExecInfo = await setV2Setup.generalIndexModule.executionInfo(setToken.address, setV2Setup.usdc.address);

      return [daiExecInfo, wbtcExecInfo, wethExecInfo, usdcExecInfo];
    }

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await gimAdapter.connect(subjectCaller.wallet).initialize();
      }

      it("should initialize GeneralIndexModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.generalIndexModule.address);
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

    context("when GIM adapter is deployed and system fully set up", async () => {
      beforeEach(async () => {
        await gimAdapter.connect(operator.wallet).initialize();
      });

      describe("#startRebalanceWithUnits", async () => {
        let subjectNewComponents: Address[];
        let subjectNewComponentsTargetUnits: BigNumber[];
        let subjectOldComponentsTargetUnits: BigNumber[];
        let subjectPositionMultiplier: BigNumber;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectNewComponents = [setV2Setup.usdc.address];
          subjectNewComponentsTargetUnits = [usdc(50)];
          subjectOldComponentsTargetUnits = [ether(50), bitcoin(.005), ether(.15)];
          subjectPositionMultiplier = ether(.999);
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await gimAdapter.connect(subjectCaller.wallet).startRebalanceWithUnits(
            subjectNewComponents,
            subjectNewComponentsTargetUnits,
            subjectOldComponentsTargetUnits,
            subjectPositionMultiplier
          );
        }

        it("should correctly set the target units and positionMultiplier", async () => {
          const [preDaiExecInfo, preWbtcExecInfo, preWethExecInfo, preUsdcExecInfo]: any[] = await getAssetExecutionInfo();
          const prePositionMultiplier = (await setV2Setup.generalIndexModule.rebalanceInfo(setToken.address)).positionMultiplier;

          expect(preDaiExecInfo.targetUnit).to.eq(ether(100));
          expect(preWbtcExecInfo.targetUnit).to.eq(bitcoin(.01));
          expect(preWethExecInfo.targetUnit).to.eq(ether(.1));
          expect(preUsdcExecInfo.targetUnit).to.eq(ZERO);
          expect(prePositionMultiplier).to.eq(ether(1));

          await subject();

          const [postDaiExecInfo, postWbtcExecInfo, postWethExecInfo, postUsdcExecInfo] = await getAssetExecutionInfo();
          const postPositionMultiplier = (await setV2Setup.generalIndexModule.rebalanceInfo(setToken.address)).positionMultiplier;

          expect(postDaiExecInfo.targetUnit).to.eq(subjectOldComponentsTargetUnits[0]);
          expect(postWbtcExecInfo.targetUnit).to.eq(subjectOldComponentsTargetUnits[1]);
          expect(postWethExecInfo.targetUnit).to.eq(subjectOldComponentsTargetUnits[2]);
          expect(postUsdcExecInfo.targetUnit).to.eq(subjectNewComponentsTargetUnits[0]);
          expect(postPositionMultiplier).to.eq(subjectPositionMultiplier);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setTradeMaximums", async () => {
        let subjectComponents: Address[];
        let subjectTradeMaximums: BigNumber[];
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address, setV2Setup.weth.address];
          subjectTradeMaximums = [ether(50), bitcoin(.01), ether(.05)];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await gimAdapter.connect(subjectCaller.wallet).setTradeMaximums(
            subjectComponents,
            subjectTradeMaximums
          );
        }

        it("should correctly set the tradeMaximums", async () => {
          await subject();

          const [postDaiExecInfo, postWbtcExecInfo, postWethExecInfo] = await getAssetExecutionInfo();

          expect(postDaiExecInfo.maxSize).to.eq(subjectTradeMaximums[0]);
          expect(postWbtcExecInfo.maxSize).to.eq(subjectTradeMaximums[1]);
          expect(postWethExecInfo.maxSize).to.eq(subjectTradeMaximums[2]);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setExchanges", async () => {
        let subjectComponents: Address[];
        let subjectExchangeNames: string[];
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address];
          subjectExchangeNames = ["UniswapV2IndexExchangeAdapter", "UniswapV3IndexExchangeAdapter"];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await gimAdapter.connect(subjectCaller.wallet).setExchanges(
            subjectComponents,
            subjectExchangeNames
          );
        }

        it("should correctly set the tradeMaximums", async () => {
          await subject();

          const [postDaiExecInfo, postWbtcExecInfo, ] = await getAssetExecutionInfo();

          expect(postDaiExecInfo.exchangeName).to.eq(subjectExchangeNames[0]);
          expect(postWbtcExecInfo.exchangeName).to.eq(subjectExchangeNames[1]);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setExchangeData", async () => {
        let subjectComponents: Address[];
        let subjectCoolOffPeriods: BigNumber[];
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address];
          subjectCoolOffPeriods = [BigNumber.from(60), BigNumber.from(90)];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await gimAdapter.connect(subjectCaller.wallet).setCoolOffPeriods(
            subjectComponents,
            subjectCoolOffPeriods
          );
        }

        it("should correctly set the tradeMaximums", async () => {
          await subject();

          const [postDaiExecInfo, postWbtcExecInfo, ] = await getAssetExecutionInfo();

          expect(postDaiExecInfo.coolOffPeriod).to.eq(subjectCoolOffPeriods[0]);
          expect(postWbtcExecInfo.coolOffPeriod).to.eq(subjectCoolOffPeriods[1]);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = approvedCaller;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#setExchangeData", async () => {
        let subjectComponents: Address[];
        let subjectExchangeData: string[];
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectComponents = [setV2Setup.dai.address, setV2Setup.wbtc.address];
          subjectExchangeData = ["0x1234", "0x5678"];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await gimAdapter.connect(subjectCaller.wallet).setExchangeData(
            subjectComponents,
            subjectExchangeData
          );
        }

        it("should correctly set the tradeMaximums", async () => {
          await subject();

          const [postDaiExecInfo, postWbtcExecInfo, ] = await getAssetExecutionInfo();

          expect(postDaiExecInfo.exchangeData).to.eq(subjectExchangeData[0]);
          expect(postWbtcExecInfo.exchangeData).to.eq(subjectExchangeData[1]);
        });

        describe("when the caller is an approved caller", async () => {
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