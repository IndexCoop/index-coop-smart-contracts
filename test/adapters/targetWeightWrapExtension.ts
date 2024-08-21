import "module-alias/register";

import DeployHelper from "@utils/deploys";
import { SetFixture } from "@utils/fixtures";
import { SetToken } from "@utils/contracts/setV2";
import {
  BaseManagerV2,
  TargetWeightWrapExtension,
  WrapAdapterMock,
} from "@utils/contracts/index";
import { Account, Address, TargetWeightWrapParams } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getWaffleExpect,
} from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("TargetWeightWrapExtension", async () => {
  let owner: Account;
  let operator: Account;
  let setValuer: Account;

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
      setValuer,
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
    let subjectSetValuer: Address;
    let subjectIsRebalancing: boolean;

    beforeEach(async () => {
      subjectManager = baseManager.address;
      subjectWrapModule = setV2Setup.wrapModule.address;
      subjectSetValuer = setValuer.address;
      subjectIsRebalancing = false;
    });

    async function subject(): Promise<TargetWeightWrapExtension> {
      return await deployer.extensions.deployTargetWeightWrapExtension(
        subjectManager,
        subjectWrapModule,
        subjectSetValuer,
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

    it("should set the correct set valuer address", async () => {
      const wrapExtension = await subject();

      const setValuer = await wrapExtension.setValuer();
      expect(setValuer).to.eq(subjectSetValuer);
    });

    it("should set the correct rebalancing status", async () => {
      const wrapExtension = await subject();

      const isRebalancing = await wrapExtension.isRebalancing();
      expect(isRebalancing).to.eq(subjectIsRebalancing);
    });
  });

  context("when target weight wrap extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      targetWeightWrapExtension = await deployer.extensions.deployTargetWeightWrapExtension(
        baseManager.address,
        setV2Setup.wrapModule.address,
        setValuer.address,
        true
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
          subjectMinReserveWeight = ether(0.02);
          subjectMaxReserveWeight = ether(0.07);
          subjectTargetAssets = [wrapAdapter.address];
          subjectExecutionParams = [
            {
              minTargetWeight: ether(0.1),
              maxTargetWeight: ether(0.2),
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
    });
  });
});
