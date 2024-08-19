import "module-alias/register";

import DeployHelper from "@utils/deploys";
import { SetFixture } from "@utils/fixtures";
import { SetToken } from "@utils/contracts/setV2";
import {
  BaseManagerV2,
  TargetWrapExtension,
  WrapAdapterMock,
} from "@utils/contracts/index";
import { Account, Address, WrapExecutionParams } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getWaffleExpect,
} from "@utils/index";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe.only("TargetWrapExtension", async () => {
  let owner: Account;
  let operator: Account;

  let deployer: DeployHelper;
  let setV2Setup: SetFixture;

  let setToken: SetToken;
  let baseManager: BaseManagerV2;
  let targetWrapExtension: TargetWrapExtension;

  let wrapAdapter: WrapAdapterMock;
  let wrapAdapterName: string;

  before(async () => {
    [
      owner,
      operator,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // setup mock wrap adapter
    wrapAdapter = await deployer.mocks.deployWrapAdapterMock(owner.address, ether(1000));
    wrapAdapterName = "WRAP_ADAPTER";
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModule.address,
      wrapAdapterName,
      wrapAdapter.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address],
      [ether(0.1)],
      [setV2Setup.wrapModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Issue some set tokens
    await setV2Setup.weth.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

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
    let subjectIsRebalancing: boolean;

    beforeEach(async () => {
      subjectManager = baseManager.address;
      subjectWrapModule = setV2Setup.wrapModule.address;
      subjectIsRebalancing = false;
    });

    async function subject(): Promise<TargetWrapExtension> {
      return await deployer.extensions.deployTargetWrapExtension(
        subjectManager,
        subjectWrapModule,
        subjectIsRebalancing
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

    it("should set the correct rebalancing status", async () => {
      const wrapExtension = await subject();

      const isRebalancing = await wrapExtension.isRebalancing();
      expect(isRebalancing).to.eq(subjectIsRebalancing);
    });
  });

  context("when target wrap extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      targetWrapExtension = await deployer.extensions.deployTargetWrapExtension(
        baseManager.address,
        setV2Setup.wrapModule.address,
        true
      );

      await baseManager.connect(operator.wallet).addExtension(targetWrapExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManager.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await targetWrapExtension.connect(subjectCaller.wallet).initialize();
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
        await targetWrapExtension.connect(operator.wallet).initialize();
      });

      describe("#setTargets", async () => {
        let subjectQuoteAsset: Address;
        let subjectPositionMultiplier: BigNumber;
        let subjectQuoteAssetTargetUnit: BigNumber;
        let subjectComponents: Address[];
        let subjectWrapParameters: WrapExecutionParams[];
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectQuoteAsset = setV2Setup.weth.address;
          subjectPositionMultiplier = await setToken.positionMultiplier();
          subjectQuoteAssetTargetUnit = ether(1);
          subjectComponents = [wrapAdapter.address];
          subjectWrapParameters = [
            {
              targetUnit: ether(1),
              wrapAdapterName: wrapAdapterName,
              wrapAdapterConfigData: EMPTY_BYTES,
            } as WrapExecutionParams,
          ];
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return await targetWrapExtension.connect(subjectCaller.wallet).setTargets(
            subjectQuoteAsset,
            subjectPositionMultiplier,
            subjectQuoteAssetTargetUnit,
            subjectComponents,
            subjectWrapParameters
          );
        }

        it("should set the rebalanceInfo", async () => {
          await subject();

          const rebalanceInfo = await targetWrapExtension.rebalanceInfo();
          const rebalanceComponents = await targetWrapExtension.getRebalanceComponents();
          expect(rebalanceInfo.quoteAsset).to.eq(subjectQuoteAsset);
          expect(rebalanceInfo.positionMultiplier).to.eq(subjectPositionMultiplier);
          expect(rebalanceInfo.quoteAssetTargetUnit).to.eq(subjectQuoteAssetTargetUnit);
          expect(rebalanceComponents).to.deep.eq(subjectComponents);
        });

        it("should set the wrap parameters", async () => {
          await subject();

          const wrapParameters = await targetWrapExtension.executionParams(subjectComponents[0]);
          expect(wrapParameters.targetUnit).to.eq(subjectWrapParameters[0].targetUnit);
          expect(wrapParameters.wrapAdapterName).to.eq(subjectWrapParameters[0].wrapAdapterName);
          expect(wrapParameters.wrapAdapterConfigData).to.eq(subjectWrapParameters[0].wrapAdapterConfigData);
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
    });
  });
});
