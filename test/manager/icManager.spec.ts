import "module-alias/register";
import { solidityKeccak256 } from "ethers/lib/utils";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, ONE_DAY_IN_SECONDS, ONE_YEAR_IN_SECONDS, ZERO } from "@utils/constants";
import { ICManager } from "@utils/contracts/index";
import { SingleIndexModule, SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  increaseTimeAsync,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getRandomAccount,
  getRandomAddress,
  getStreamingFee,
  getStreamingFeeInflationAmount,
  getTransactionTimestamp,
  getLastBlockTimestamp,
  preciseMul
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ICManager", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let newManager: Account;
  let trader: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setTokensIssued: BigNumber;
  let indexModule: SingleIndexModule;

  let icManager: ICManager;
  let operatorFeeSplit: BigNumber;

  before(async () => {
    [
      owner,
      otherAccount,
      newManager,
      methodologist,
      trader,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    indexModule = await deployer.setV2.deploySingleIndexModule(
      setV2Setup.controller.address,
      setV2Setup.weth.address,
      (await getRandomAccount()).address, // TODO
      (await getRandomAccount()).address,
      (await getRandomAccount()).address,
    );
    await setV2Setup.controller.addModule(indexModule.address);

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address, indexModule.address]
    );

    // Initialize modules
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    await indexModule.initialize(setToken.address);

    // Issue some Sets
    setTokensIssued = ether(10);
    operatorFeeSplit = ether(0.7); // 70% fee split
    await setV2Setup.issuanceModule.issue(setToken.address, setTokensIssued, otherAccount.address);

    // Deploy ICManager
    icManager = await deployer.manager.deployICManager(
      setToken.address,
      indexModule.address,
      setV2Setup.streamingFeeModule.address,
      owner.address,
      methodologist.address,
      operatorFeeSplit
    );

    // Update streaming fee recipient to IcManager
    await setV2Setup.streamingFeeModule.updateFeeRecipient(setToken.address, icManager.address);
    // Transfer ownership to IcManager
    await setToken.setManager(icManager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSetToken: Address;
    let subjectIndexModule: Address;
    let subjectStreamingFeeModule: Address;
    let subjectOperator: Address;
    let subjectMethodologist: Address;
    let subjectOperatorFeeSplit: BigNumber;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectIndexModule = indexModule.address;
      subjectStreamingFeeModule = setV2Setup.streamingFeeModule.address;
      subjectOperator = owner.address;
      subjectMethodologist = methodologist.address;
      subjectOperatorFeeSplit = ether(0.7);
    });

    async function subject(): Promise<ICManager> {
      return await deployer.manager.deployICManager(
        subjectSetToken,
        subjectIndexModule,
        subjectStreamingFeeModule,
        subjectOperator,
        subjectMethodologist,
        subjectOperatorFeeSplit
      );
    }

    it("should set the correct SetToken address", async () => {
      const retrievedICManager = await subject();

      const actualToken = await retrievedICManager.setToken();
      expect (actualToken).to.eq(subjectSetToken);
    });

    it("should set the correct IndexModule address", async () => {
      const retrievedICManager = await subject();

      const actualIndexModule = await retrievedICManager.indexModule();
      expect (actualIndexModule).to.eq(subjectIndexModule);
    });

    it("should set the correct StreamingFeeModule address", async () => {
      const retrievedICManager = await subject();

      const actualStreamingFeeModule = await retrievedICManager.feeModule();
      expect (actualStreamingFeeModule).to.eq(subjectStreamingFeeModule);
    });

    it("should set the correct Operator address", async () => {
      const retrievedICManager = await subject();

      const actualOperator = await retrievedICManager.operator();
      expect (actualOperator).to.eq(subjectOperator);
    });

    it("should set the correct Methodologist address", async () => {
      const retrievedICManager = await subject();

      const actualMethodologist = await retrievedICManager.methodologist();
      expect (actualMethodologist).to.eq(subjectMethodologist);
    });

    it("should set the correct Coop Fee Split address", async () => {
      const retrievedICManager = await subject();

      const actualOperatorFeeSplit = await retrievedICManager.operatorFeeSplit();
      expect (actualOperatorFeeSplit).to.eq(subjectOperatorFeeSplit);
    });

    describe("when operator fee split is greater than 1e18", async () => {
      beforeEach(async () => {
        subjectOperatorFeeSplit = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Operator Fee Split must be less than 1e18");
      });
    });
  });

  describe("#startRebalance", async () => {
    let subjectNewComponents: Address[];
    let subjectNewComponentsTargetUnits: BigNumber[];
    let subjectOldComponentsTargetUnits: BigNumber[];
    let subjectPositionMultiplier: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewComponents = [setV2Setup.usdc.address];
      subjectNewComponentsTargetUnits = [BigNumber.from(500000)];
      subjectOldComponentsTargetUnits = [ether(.5)];
      subjectPositionMultiplier = ether(1);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.startRebalance(
        subjectNewComponents,
        subjectNewComponentsTargetUnits,
        subjectOldComponentsTargetUnits,
        subjectPositionMultiplier
      );
    }

    it("should set the asset info in the index module", async () => {
      await subject();
      const assetInfoUSDC = await indexModule.assetInfo(subjectNewComponents[0]);
      const assetInfoDai = await indexModule.assetInfo(setV2Setup.dai.address);
      expect(assetInfoUSDC.targetUnit).to.eq(subjectNewComponentsTargetUnits[0]);
      expect(assetInfoDai.targetUnit).to.eq(subjectOldComponentsTargetUnits[0]);
    });

    it("should set the position multipler in the index module", async () => {
      await subject();
      const positionMultiplier = await indexModule.positionMultiplier();
      expect(positionMultiplier).to.eq(subjectPositionMultiplier);
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

  describe("#setTradeMaximums", async () => {
    let subjectComponents: Address[];
    let subjectTradeMaximums: BigNumber[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectComponents = [setV2Setup.usdc.address];
      subjectTradeMaximums = [BigNumber.from(1000000)];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.setTradeMaximums(subjectComponents, subjectTradeMaximums);
    }

    it("should set the trade max in the index module", async () => {
      await subject();
      const assetInfo = await indexModule.assetInfo(subjectComponents[0]);
      expect(assetInfo.maxSize).to.eq(subjectTradeMaximums[0]);
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

  describe("#setAssetExchanges", async () => {
    let subjectComponents: Address[];
    let subjectAssetExchanges: BigNumber[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectComponents = [setV2Setup.usdc.address];
      subjectAssetExchanges = [BigNumber.from(1)];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.setAssetExchanges(subjectComponents, subjectAssetExchanges);
    }

    it("should set the asset exchanges in the index module", async () => {
      await subject();
      const assetInfo = await indexModule.assetInfo(subjectComponents[0]);
      expect(assetInfo.exchange).to.eq(subjectAssetExchanges[0]);
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

  describe("#setCoolOffPeriods", async () => {
    let subjectComponents: Address[];
    let subjectCoolOffPeriods: BigNumber[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectComponents = [setV2Setup.usdc.address];
      subjectCoolOffPeriods = [BigNumber.from(100)];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.setCoolOffPeriods(subjectComponents, subjectCoolOffPeriods);
    }

    it("should set the correct cool off period in the index module", async () => {
      await subject();
      const assetInfo = await indexModule.assetInfo(subjectComponents[0]);
      expect(assetInfo.coolOffPeriod).to.eq(subjectCoolOffPeriods[0]);
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

  describe("#updateTraderStatus", async () => {
    let subjectTraders: Address[];
    let subjectStatuses: boolean[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTraders = [owner.address, trader.address];
      subjectStatuses = [true, true];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateTraderStatus(subjectTraders, subjectStatuses);
    }

    it("should set the allowed traders in the index module", async () => {
      await subject();
      const isAllowedOne = await indexModule.tradeAllowList(subjectTraders[0]);
      const isAllowedTwo = await indexModule.tradeAllowList(subjectTraders[1]);
      expect(isAllowedOne).to.eq(true);
      expect(isAllowedTwo).to.eq(true);
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

  describe("#updateAnyoneTrade", async () => {
    let subjectStatus: boolean;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateAnyoneTrade(subjectStatus);
    }

    it("should set the allowed traders in the index module", async () => {
      await subject();
      const isAllowed = await indexModule.anyoneTrade();
      expect(isAllowed).to.be.true;
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

  describe("#accrueFeeAndDistribute", async () => {
    let subjectTimeFastForward: BigNumber;

    beforeEach(async () => {
      subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
    });

    async function subject(): Promise<any> {
      await increaseTimeAsync(subjectTimeFastForward);
      return icManager.accrueFeeAndDistribute();
    }

    it("mints the correct amount of new Sets to the operator and methodologist", async () => {
      const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      const totalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        setV2Setup.streamingFeeModule,
        setToken.address,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
      const operatorFeeSplit = await icManager.operatorFeeSplit();
      const operatorTake = preciseMul(feeInflation, operatorFeeSplit);
      const methodologistTake = feeInflation.sub(operatorTake);
      const operatorSetBalance = await setToken.balanceOf(owner.address);
      const methodologistSetBalance = await setToken.balanceOf(methodologist.address);

      expect(operatorSetBalance).to.eq(operatorTake);
      expect(methodologistSetBalance).to.eq(methodologistTake);
    });

    it("should emit the correct FeesAccrued event", async () => {
      await expect(subject()).to.emit(icManager, "FeesAccrued");
    });
  });

  describe("#updateManager", async () => {
    let subjectNewManager: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewManager = newManager.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateManager(subjectNewManager);
    }

    it("should log the proposed manager hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManager.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed manager hash is already set", async () => {
      beforeEach(async () => {
        await icManager.connect(owner.wallet).updateManager(newManager.address);

        subjectCaller = methodologist;
      });

      it("should change the manager address", async () => {
        await subject();
        const manager = await setToken.manager();

        expect(manager).to.eq(newManager.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#addModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      await setV2Setup.controller.addModule(otherAccount.address);

      subjectModule = otherAccount.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.addModule(subjectModule);
    }

    it("should add the module to the SetToken", async () => {
      await subject();
      const isModule = await setToken.isPendingModule(subjectModule);
      expect(isModule).to.eq(true);
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

  describe("#interactModule", async () => {
    let subjectModule: Address;
    let subjectCallData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = indexModule.address;

      // Invoke start rebalance
      subjectCallData = indexModule.interface.encodeFunctionData("startRebalance", [
        [setV2Setup.usdc.address],
        [BigNumber.from(500000)],
        [ether(.5)],
        ether(1),
      ]);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.interactModule(subjectModule, subjectCallData);
    }

    it("should call startRebalance on the index module from the SetToken", async () => {
      await subject();
      const assetInfo = await indexModule.assetInfo(setV2Setup.dai.address);
      const positionMultiplier = await indexModule.positionMultiplier();
      expect(assetInfo.targetUnit).to.eq(ether(.5));
      expect(positionMultiplier).to.eq(ether(1));
    });

    describe("when interacting with the fee module", async () => {
      beforeEach(async () => {
        subjectModule = setV2Setup.streamingFeeModule.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must not be fee module");
      });
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

  describe("#removeModule", async () => {
    let subjectModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.removeModule(subjectModule);
    }

    it("should remove the module from the SetToken", async () => {
      await subject();
      const isModule = await setToken.isInitializedModule(subjectModule);
      expect(isModule).to.eq(false);
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

  describe("#updateStreamingFee", async () => {
    let subjectStreamingFeePercentage: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectStreamingFeePercentage = ether(0.02);
      subjectCaller = methodologist;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateStreamingFee(subjectStreamingFeePercentage);
    }

    context("when no timelock period has been set", async () => {
      it("sets the new streaming fee", async () => {
        await subject();
        const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const newStreamingFee = feeStates.streamingFeePercentage;

        expect(newStreamingFee).to.eq(subjectStreamingFeePercentage);
      });

      describe("when the caller is not the methodologist", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be methodologist");
        });
      });
    });

    context("when 1 day timelock period has been set", async () => {
      beforeEach(async () => {
        icManager = icManager.connect(methodologist.wallet);
        await icManager.setTimeLockPeriod(ONE_DAY_IN_SECONDS);

        icManager = icManager.connect(owner.wallet);
        await icManager.setTimeLockPeriod(ONE_DAY_IN_SECONDS);
      });

      it("sets the upgradeHash", async () => {
        await subject();
        const timestamp = await getLastBlockTimestamp();
        const calldata = icManager.interface.encodeFunctionData("updateStreamingFee", [subjectStreamingFeePercentage]);
        const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
        const actualTimestamp = await icManager.timeLockedUpgrades(upgradeHash);
        expect(actualTimestamp).to.eq(timestamp);
      });

      context("when 1 day timelock has elapsed", async () => {
        beforeEach(async () => {
          await subject();
          await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
        });

        it("sets the new streaming fee", async () => {
          await subject();
          const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
          const newStreamingFee = feeStates.streamingFeePercentage;

          expect(newStreamingFee).to.eq(subjectStreamingFeePercentage);
        });

        it("sets the upgradeHash to 0", async () => {
          await subject();
          const calldata = icManager.interface.encodeFunctionData("updateStreamingFee", [subjectStreamingFeePercentage]);
          const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
          const actualTimestamp = await icManager.timeLockedUpgrades(upgradeHash);
          expect(actualTimestamp).to.eq(ZERO);
        });
      });
    });
  });

  describe("#updateFeeRecipient", async () => {
    let subjectNewFeeRecipient: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewFeeRecipient = otherAccount.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateFeeRecipient(subjectNewFeeRecipient);
    }

    it("should log the proposed manager hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManager.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed recipient hash is already set", async () => {
      beforeEach(async () => {
        icManager = icManager.connect(owner.wallet);
        await icManager.updateFeeRecipient(otherAccount.address);

        subjectCaller = methodologist;
      });

      it("should change the recipient address", async () => {
        await subject();
        const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const feeRecipient = feeStates.feeRecipient;

        expect(feeRecipient).to.eq(otherAccount.address);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#updateFeeSplit", async () => {
    let subjectNewFeeSplit: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      await increaseTimeAsync(ONE_YEAR_IN_SECONDS);

      subjectNewFeeSplit = ether(0.5); // 50% to operator
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateFeeSplit(subjectNewFeeSplit);
    }

    it("should log the proposed manager hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManager.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed recipient hash is already set", async () => {
      beforeEach(async () => {
        icManager = icManager.connect(owner.wallet);
        await icManager.updateFeeSplit(ether(0.5));

        subjectCaller = methodologist;
      });

      it("should change the fee split", async () => {
        await subject();
        const feeSplit = await icManager.operatorFeeSplit();

        expect(feeSplit).to.eq(subjectNewFeeSplit);
      });

      it("should accrue fees", async () => {
        const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
        const totalSupply = await setToken.totalSupply();
        // Get fee split prior to function call
        const operatorFeeSplit = await icManager.operatorFeeSplit();
        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          setV2Setup.streamingFeeModule,
          setToken.address,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );

        const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
        const operatorTake = preciseMul(feeInflation, operatorFeeSplit);
        const methodologistTake = feeInflation.sub(operatorTake);
        const operatorSetBalance = await setToken.balanceOf(owner.address);
        const methodologistSetBalance = await setToken.balanceOf(methodologist.address);

        expect(operatorSetBalance).to.eq(operatorTake);
        expect(methodologistSetBalance).to.eq(methodologistTake);
      });
    });

    describe("when operator fee split is greater than 1e18", async () => {
      beforeEach(async () => {
        subjectNewFeeSplit = ether(1.1);
        await subject();
        subjectCaller = methodologist;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Operator Fee Split must be less than 1e18");
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });

  describe("#updateIndexModule", async () => {
    let subjectIndexModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectIndexModule = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateIndexModule(subjectIndexModule);
    }

    it("should set the new index module", async () => {
      await subject();
      const actualIndexModule = await icManager.indexModule();
      expect(actualIndexModule).to.eq(subjectIndexModule);
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

  describe("#updateMethodologist", async () => {
    let subjectNewMethodologist: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewMethodologist = await getRandomAddress();
      subjectCaller = methodologist;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateMethodologist(subjectNewMethodologist);
    }

    it("should set the new methodologist", async () => {
      await subject();
      const actualIndexModule = await icManager.methodologist();
      expect(actualIndexModule).to.eq(subjectNewMethodologist);
    });

    describe("when the caller is not the methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#updateOperator", async () => {
    let subjectNewOperator: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectNewOperator = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.updateOperator(subjectNewOperator);
    }

    it("should set the new operator", async () => {
      await subject();
      const actualIndexModule = await icManager.operator();
      expect(actualIndexModule).to.eq(subjectNewOperator);
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

  describe("#setTimeLockPeriod", async () => {
    let subjectTimeLockPeriod: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTimeLockPeriod = ONE_DAY_IN_SECONDS;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      icManager = icManager.connect(subjectCaller.wallet);
      return icManager.setTimeLockPeriod(subjectTimeLockPeriod);
    }

    it("should log the proposed manager hash in the mutualUpgrades mapping", async () => {
      const txHash = await subject();

      const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
      const isLogged = await icManager.mutualUpgrades(expectedHash);

      expect(isLogged).to.be.true;
    });

    describe("when proposed timelock period hash is already set", async () => {
      beforeEach(async () => {
        icManager = icManager.connect(owner.wallet);
        await icManager.setTimeLockPeriod(ONE_DAY_IN_SECONDS);

        subjectCaller = methodologist;
      });

      it("should change the timelock period", async () => {
        await subject();
        const actualTimeLockPeriod = await icManager.timeLockPeriod();

        expect(actualTimeLockPeriod).to.eq(subjectTimeLockPeriod);
      });
    });

    describe("when the caller is not the operator or methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be authorized address");
      });
    });
  });
});
