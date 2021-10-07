import "module-alias/register";

import { Address, Account, TransformInfo, ContractTransaction } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { IPRebalanceExtension, BaseManagerV2, StandardTokenMock, TransformHelperMock } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAddress,
  getWaffleExpect,
  preciseDiv,
  preciseMul
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("IPRebalanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let randomCaller: Account;

  let setV2Setup: SetFixture;
  let deployer: DeployHelper;

  let setToken: SetToken;

  let DAI: StandardTokenMock;
  let cDAI: StandardTokenMock;
  let yDAI: StandardTokenMock;
  let USDC: StandardTokenMock;

  let compTransferHelper: TransformHelperMock;
  let yearnTransformHelper: TransformHelperMock;

  let baseManagerV2: BaseManagerV2;
  let ipRebalanceExtension: IPRebalanceExtension;

  before(async () => {
    [
      owner,
      operator,
      methodologist,
      randomCaller,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // Setup Component Tokens
    USDC = setV2Setup.usdc;
    DAI = setV2Setup.dai;
    cDAI = await deployer.mocks.deployStandardTokenMock(owner.address, 18);
    yDAI = await deployer.mocks.deployStandardTokenMock(owner.address, 18);

    setToken = await setV2Setup.createSetToken(
      [USDC.address, DAI.address, cDAI.address, yDAI.address],
      [ether(15), ether(20), ether(25), ether(30)],
      [setV2Setup.generalIndexModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Issue some set tokens
    await USDC.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await DAI.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await cDAI.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await yDAI.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5.11234), owner.address);

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();
    await setToken.setManager(baseManagerV2.address);

    // Deploy IPRebalanceExtension
    ipRebalanceExtension = await deployer.extensions.deployIPRebalanceExtension(baseManagerV2.address, setV2Setup.generalIndexModule.address);
    baseManagerV2.connect(operator.wallet).addExtension(ipRebalanceExtension.address);

    // Deploy TransferHelpers
    compTransferHelper = await deployer.mocks.deployTransformHelperMock(ether(1.01914841));
    yearnTransformHelper = await deployer.mocks.deployTransformHelperMock(ether(1.014914892));
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectGeneralIndexModule: Address;

    beforeEach(async () => {
      subjectManager = await getRandomAddress();
      subjectGeneralIndexModule = await getRandomAddress();
    });

    async function subject(): Promise<IPRebalanceExtension> {
      return await deployer.extensions.deployIPRebalanceExtension(subjectManager, subjectGeneralIndexModule);
    }

    it("should set the state variables", async () => {
      const extension = await subject();

      expect(await extension.manager()).to.eq(subjectManager);
      expect(await extension.generalIndexModule()).to.eq(subjectGeneralIndexModule);
    });
  });

  describe("#startRebalanceWithUnits", async () => {
    async function subject(): Promise<void> {
      return await ipRebalanceExtension.startRebalanceWithUnits([], []);
    }

    it("should revert", async () => {
      await expect(subject()).to.be.revertedWith("use startIPRebalance instead");
    });
  });

  describe("#setTransformData", async () => {
    let subjectTransformComponent: Address;
    let subjectTransformInfo: TransformInfo;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTransformComponent = await getRandomAddress();
      subjectTransformInfo = {
        underlyingComponent: await getRandomAddress(),
        transformHelper: await getRandomAddress(),
      };
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return await ipRebalanceExtension.connect(subjectCaller.wallet).setTransformInfo(subjectTransformComponent, subjectTransformInfo);
    }

    it("should set the transform info entry correctly", async () => {
      await subject();

      const transformInfo = await ipRebalanceExtension.transformComponentInfo(subjectTransformComponent);

      expect(transformInfo.underlyingComponent).to.eq(subjectTransformInfo.underlyingComponent);
      expect(transformInfo.transformHelper).to.eq(subjectTransformInfo.transformHelper);
    });

    context("when caller is not operator", async () => {
      beforeEach(() => {
        subjectCaller = randomCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    context("when transform info has already been set", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TransformInfo already set");
      });
    });
  });

  describe("#updateTransformData", async () => {
    let subjectTransformComponent: Address;
    let subjectTransformInfo: TransformInfo;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTransformComponent = await getRandomAddress();
      subjectTransformInfo = {
        underlyingComponent: await getRandomAddress(),
        transformHelper: await getRandomAddress(),
      };
      subjectCaller = operator;

      const originalTransformInfo = {
        underlyingComponent: await getRandomAddress(),
        transformHelper: await getRandomAddress(),
      };
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(subjectTransformComponent, originalTransformInfo);
    });

    async function subject(): Promise<ContractTransaction> {
      return await ipRebalanceExtension.connect(subjectCaller.wallet).updateTransformInfo(subjectTransformComponent, subjectTransformInfo);
    }

    it("should set the transform info entry correctly", async () => {
      await subject();

      const transformInfo = await ipRebalanceExtension.transformComponentInfo(subjectTransformComponent);

      expect(transformInfo.underlyingComponent).to.eq(subjectTransformInfo.underlyingComponent);
      expect(transformInfo.transformHelper).to.eq(subjectTransformInfo.transformHelper);
    });

    context("when caller is not operator", async () => {
      beforeEach(() => {
        subjectCaller = randomCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    context("when transform info has not been set", async () => {
      beforeEach(async () => {
        subjectTransformComponent = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TransformInfo not set yet");
      });
    });
  });

  context("when transform helpers have been properly set", async () => {
    beforeEach(async () => {
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(cDAI.address, {
        underlyingComponent: DAI.address,
        transformHelper: compTransferHelper.address,
      });
      await ipRebalanceExtension.connect(operator.wallet).setTransformInfo(yDAI.address, {
        underlyingComponent: DAI.address,
        transformHelper: yearnTransformHelper.address,
      });
    });

    describe("#startIPRebalance", async () => {
      let subjectSetComponents: Address[];
      let subjectTargetUnitsUnderlying: BigNumber[];
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetComponents = [USDC.address, DAI.address, cDAI.address, yDAI.address];
        subjectTargetUnitsUnderlying = [ether(10), ether(10), ether(15), ether(60)];
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await ipRebalanceExtension.connect(subjectCaller.wallet).startIPRebalance(subjectSetComponents, subjectTargetUnitsUnderlying);
      }

      it("should set the number of untransforms", async () => {
        await subject();

        expect(await ipRebalanceExtension.untransforms()).to.eq(1);
      });

      it("should set the untransformUnits", async () => {
        await subject();

        const yDaiUntransformUnits = await ipRebalanceExtension.untransformUnits(yDAI.address);
        const cDaiUntransformUnits = await ipRebalanceExtension.untransformUnits(cDAI.address);

        const cDaiUnits = await setToken.getDefaultPositionRealUnit(cDAI.address);
        const cDaiExchangeRate = await compTransferHelper.getExchangeRate(DAI.address, cDAI.address);
        const targetCDaiUnderlyingUnits = subjectTargetUnitsUnderlying[2];
        const targetCDaiUnits = preciseMul(targetCDaiUnderlyingUnits, cDaiExchangeRate);

        const expectedYDaiUntransformUnits = ZERO;
        const expectedCDaiUntransformUnits = cDaiUnits.sub(targetCDaiUnits);

        expect(yDaiUntransformUnits).to.eq(expectedYDaiUntransformUnits);
        expect(cDaiUntransformUnits).to.eq(expectedCDaiUntransformUnits);
      });

      it("should set the rebalance params", async () => {
        await subject();

        const [usdcTargetUnderlying, usdcTransformPercentage] = await ipRebalanceExtension.rebalanceParams(USDC.address);
        const [daiTargetUnderlying, daiTransformPercentage] = await ipRebalanceExtension.rebalanceParams(DAI.address);
        const [cDaiTargetUnderlying, cDaiTransformPercentage] = await ipRebalanceExtension.rebalanceParams(cDAI.address);
        const [yDaiTargetUnderlying, yDaiTransformPercentage] = await ipRebalanceExtension.rebalanceParams(yDAI.address);

        expect(usdcTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[0]);
        expect(daiTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[1]);
        expect(cDaiTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[2]);
        expect(yDaiTargetUnderlying).to.eq(subjectTargetUnitsUnderlying[3]);

        const totalUnderlyingDai = daiTargetUnderlying.add(cDaiTargetUnderlying).add(yDaiTargetUnderlying);
        const expectedCDaiTransformPercentage = preciseDiv(cDaiTargetUnderlying, totalUnderlyingDai);
        const expectedYDaiTransformPercentage = preciseDiv(yDaiTargetUnderlying, totalUnderlyingDai);

        expect(usdcTransformPercentage).to.eq(ZERO);
        expect(daiTransformPercentage).to.eq(ZERO);
        expect(cDaiTransformPercentage).to.eq(expectedCDaiTransformPercentage);
        expect(yDaiTransformPercentage).to.eq(expectedYDaiTransformPercentage);
      });

      it("should set the starting underlying component units", async () => {
        await subject();

        const usdcStartingUnderlying = await ipRebalanceExtension.startingUnderlyingComponentUnits(USDC.address);
        const daiStartingUnderlying = await ipRebalanceExtension.startingUnderlyingComponentUnits(DAI.address);
        const cDaiStartingUnderlying = await ipRebalanceExtension.startingUnderlyingComponentUnits(cDAI.address);
        const yDaiStartingUnderlying = await ipRebalanceExtension.startingUnderlyingComponentUnits(yDAI.address);

        const currentDaiUnits = await setToken.getDefaultPositionRealUnit(DAI.address);

        expect(usdcStartingUnderlying).to.eq(ZERO);
        expect(daiStartingUnderlying).to.eq(ZERO);
        expect(cDaiStartingUnderlying).to.eq(currentDaiUnits);
        expect(yDaiStartingUnderlying).to.eq(currentDaiUnits);
      });

      it("should set the component list", async () => {
        await subject();

        expect(await ipRebalanceExtension.setComponentList(0)).to.eq(USDC.address);
        expect(await ipRebalanceExtension.setComponentList(1)).to.eq(DAI.address);
        expect(await ipRebalanceExtension.setComponentList(2)).to.eq(cDAI.address);
        expect(await ipRebalanceExtension.setComponentList(3)).to.eq(yDAI.address);
      });

      context("when component list and target list lengths don't match", async () => {
        beforeEach(() => {
          subjectSetComponents = [DAI.address];
          subjectTargetUnitsUnderlying = [ether(1), ether(2)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("length mismatch");
        });
      });

      context("when caller is not operator", async () => {
        beforeEach(() => {
          subjectCaller = randomCaller;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
});