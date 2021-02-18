import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import { Address, Account, Bytes, LeverageTokenSettings } from "@utils/types";
import { ADDRESS_ZERO, ONE, TWO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, ICManagerV2, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundLeverageModule, ContractCallerMock, DebtIssuanceModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getEthBalance,
  getSetFixture,
  getCompoundFixture,
  getWaffleExpect,
  getRandomAccount,
  getRandomAddress,
  getLastBlockTimestamp,
  increaseTimeAsync,
  preciseDiv,
  preciseMul,
  calculateNewLeverageRatio,
  calculateCollateralRebalanceUnits,
  calculateMaxBorrowForDelever
} from "@utils/index";
import { SetFixture, CompoundFixture } from "@utils/fixtures";

const expect = getWaffleExpect();
const provider = ethers.provider;

describe("FlexibleLeverageStrategyAdapter", () => {
  let owner: Account;
  let methodologist: Account;
  let otherTrader: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let tradeAdapterMock: TradeAdapterMock;

  let targetLeverageRatio: BigNumber;
  let minLeverageRatio: BigNumber;
  let maxLeverageRatio: BigNumber;
  let recenteringSpeed: BigNumber;
  let rebalanceInterval: BigNumber;
  let unutilizedLeveragePercentage: BigNumber;
  let twapMaxTradeSize: BigNumber;
  let twapCooldownPeriod: BigNumber;
  let slippageTolerance: BigNumber;

  let incentivizedTwapMaxTradeSize: BigNumber;
  let incentivizedTwapCooldownPeriod: BigNumber;
  let incentivizedSlippageTolerance: BigNumber;
  let incentivizedLeverageRatio: BigNumber;
  let etherReward: BigNumber;

  let leverageTokenSettings: LeverageTokenSettings;
  let customTargetLeverageRatio: any;
  let customMinLeverageRatio: any;
  let customCTokenCollateralAddress: any;
  let customCompoundLeverageModule: any;

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let secondCompoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let icManagerV2: ICManagerV2;

  before(async () => {
    [
      owner,
      methodologist,
      otherTrader,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    cEther = await compoundSetup.createAndEnableCEther(
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000)   // $1000
    );

    cUSDC = await compoundSetup.createAndEnableCToken(
      setV2Setup.usdc.address,
      200000000000000,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound USDC",
      "cUSDC",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
    await cUSDC.mint(ether(1));
    await cEther.mint({value: ether(1000)});

    // Deploy Compound leverage module and add to controller
    compoundLeverageModule = await deployer.setV2.deployCompoundLeverageModule(
      setV2Setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setV2Setup.weth.address
    );
    await setV2Setup.controller.addModule(compoundLeverageModule.address);

    // Deploy Comptroller mock for gulp as COMP address is hardcoded in Comptroller
    const gulpComptrollerMock = await deployer.setV2.deployComptrollerMock(
      compoundSetup.comp.address,
      ether(1),
      cEther.address
    );
    await compoundSetup.comp.transfer(gulpComptrollerMock.address, ether(1));

    // Note: Deploy leverage module that uses the mock Comptroller
    secondCompoundLeverageModule = await deployer.setV2.deployCompoundLeverageModule(
      setV2Setup.controller.address,
      compoundSetup.comp.address,
      gulpComptrollerMock.address,
      cEther.address,
      setV2Setup.weth.address
    );
    await setV2Setup.controller.addModule(secondCompoundLeverageModule.address);

    debtIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    // Deploy mock trade adapter
    tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );
    await setV2Setup.integrationRegistry.addIntegration(
      secondCompoundLeverageModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );
    await setV2Setup.integrationRegistry.addIntegration(
      secondCompoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );

    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [BigNumber.from(5000000000)], // Equivalent to 1 ETH
      [
        setV2Setup.issuanceModule.address,
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        secondCompoundLeverageModule.address,
        debtIssuanceModule.address,
      ]
    );
    await gulpComptrollerMock.addSetTokenAddress(setToken.address);
    await compoundLeverageModule.updateAnySetInitializable(true);
    await secondCompoundLeverageModule.updateAnySetInitializable(true);

    // Initialize modules
    await debtIssuanceModule.initialize(setToken.address, ether(1), ZERO, ZERO, owner.address, ADDRESS_ZERO);
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
    await compoundLeverageModule.initialize(
      setToken.address,
      [setV2Setup.weth.address],
      [setV2Setup.usdc.address]
    );
    await secondCompoundLeverageModule.initialize(
      setToken.address,
      [setV2Setup.weth.address],
      []
    );

    icManagerV2 = await deployer.manager.deployICManagerV2(
      setToken.address,
      owner.address,
      methodologist.address,
      []
    );

    // Transfer ownership to ic manager
    await setToken.setManager(icManagerV2.address);
  });

  beforeEach(async () => {
    // Deploy adapter
    targetLeverageRatio = customTargetLeverageRatio || ether(2);
    minLeverageRatio = customMinLeverageRatio || ether(1.7);
    maxLeverageRatio = ether(2.3);
    recenteringSpeed = ether(0.05);
    rebalanceInterval = BigNumber.from(86400);

    unutilizedLeveragePercentage = ether(0.01);
    twapMaxTradeSize = ether(0.5);
    twapCooldownPeriod = BigNumber.from(3000);
    slippageTolerance = ether(0.01);

    incentivizedTwapMaxTradeSize = ether(2);
    incentivizedTwapCooldownPeriod = BigNumber.from(60);
    incentivizedSlippageTolerance = ether(0.05);
    etherReward = ether(1);
    incentivizedLeverageRatio = ether(2.6);

    leverageTokenSettings = {
      setToken: setToken.address,
      leverageModule: customCompoundLeverageModule || compoundLeverageModule.address,
      manager: icManagerV2.address,
      comptroller: compoundSetup.comptroller.address,
      priceOracle: compoundSetup.priceOracle.address,
      targetCollateralCToken: customCTokenCollateralAddress || cEther.address,
      targetBorrowCToken: cUSDC.address,
      collateralAsset: setV2Setup.weth.address,
      borrowAsset: setV2Setup.usdc.address,
      targetLeverageRatio: targetLeverageRatio,
      minLeverageRatio: minLeverageRatio,
      maxLeverageRatio: maxLeverageRatio,
      recenteringSpeed: recenteringSpeed,
      rebalanceInterval: rebalanceInterval,
      unutilizedLeveragePercentage: unutilizedLeveragePercentage,
      twapMaxTradeSize: twapMaxTradeSize,
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
      exchangeName: "MockTradeAdapter",
      exchangeData: EMPTY_BYTES,
    };

    flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(leverageTokenSettings);

    // Add adapter
    await icManagerV2.connect(methodologist.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
    await icManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectLeverageTokenSettings: LeverageTokenSettings;

    beforeEach(async () => {
      subjectLeverageTokenSettings = {
        setToken: setToken.address,
        leverageModule: compoundLeverageModule.address,
        manager: icManagerV2.address,
        comptroller: compoundSetup.comptroller.address,
        priceOracle: compoundSetup.priceOracle.address,
        targetCollateralCToken: cEther.address,
        targetBorrowCToken: cUSDC.address,
        collateralAsset: setV2Setup.weth.address,
        borrowAsset: setV2Setup.usdc.address,
        targetLeverageRatio: ether(2),
        minLeverageRatio: ether(1.7),
        maxLeverageRatio: ether(2.3),
        recenteringSpeed: ether(0.05),
        rebalanceInterval: BigNumber.from(86400),
        unutilizedLeveragePercentage: ether(0.01),
        twapMaxTradeSize: ether(0.1),
        twapCooldownPeriod: BigNumber.from(120),
        slippageTolerance: ether(0.01),
        incentivizedTwapMaxTradeSize: ether(1),
        incentivizedTwapCooldownPeriod: BigNumber.from(60),
        incentivizedSlippageTolerance: ether(0.05),
        etherReward: etherReward,
        incentivizedLeverageRatio: ether(3.5),
        exchangeName: "MockTradeAdapter",
        exchangeData: EMPTY_BYTES,
      };
    });

    async function subject(): Promise<FlexibleLeverageStrategyAdapter> {
      return await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
        subjectLeverageTokenSettings
      );
    }

    it("should set the contract addresses", async () => {
      const retrievedAdapter = await subject();

      const setToken = await retrievedAdapter.setToken();
      const leverageModule = await retrievedAdapter.leverageModule();
      const manager = await retrievedAdapter.manager();
      const comptroller = await retrievedAdapter.comptroller();
      const compoundPriceOracle = await retrievedAdapter.priceOracle();
      const targetCollateralCToken = await retrievedAdapter.targetCollateralCToken();
      const targetBorrowCToken = await retrievedAdapter.targetBorrowCToken();
      const collateralAsset = await retrievedAdapter.collateralAsset();
      const borrowAsset = await retrievedAdapter.borrowAsset();

      expect(setToken).to.eq(subjectLeverageTokenSettings.setToken);
      expect(leverageModule).to.eq(subjectLeverageTokenSettings.leverageModule);
      expect(manager).to.eq(subjectLeverageTokenSettings.manager);
      expect(comptroller).to.eq(subjectLeverageTokenSettings.comptroller);
      expect(compoundPriceOracle).to.eq(subjectLeverageTokenSettings.priceOracle);
      expect(targetCollateralCToken).to.eq(subjectLeverageTokenSettings.targetCollateralCToken);
      expect(targetBorrowCToken).to.eq(subjectLeverageTokenSettings.targetBorrowCToken);
      expect(collateralAsset).to.eq(subjectLeverageTokenSettings.collateralAsset);
      expect(borrowAsset).to.eq(subjectLeverageTokenSettings.borrowAsset);
    });

    it("should set the correct methodology parameters", async () => {
      const retrievedAdapter = await subject();

      const targetLeverageRatio = await retrievedAdapter.targetLeverageRatio();
      const minLeverageRatio = await retrievedAdapter.minLeverageRatio();
      const maxLeverageRatio = await retrievedAdapter.maxLeverageRatio();
      const recenteringSpeed = await retrievedAdapter.recenteringSpeed();
      const rebalanceInterval = await retrievedAdapter.rebalanceInterval();

      expect(targetLeverageRatio).to.eq(subjectLeverageTokenSettings.targetLeverageRatio);
      expect(minLeverageRatio).to.eq(subjectLeverageTokenSettings.minLeverageRatio);
      expect(maxLeverageRatio).to.eq(subjectLeverageTokenSettings.maxLeverageRatio);
      expect(recenteringSpeed).to.eq(subjectLeverageTokenSettings.recenteringSpeed);
      expect(rebalanceInterval).to.eq(subjectLeverageTokenSettings.rebalanceInterval);
    });

    it("should set the correct execution parameters", async () => {
      const retrievedAdapter = await subject();

      const unutilizedLeveragePercentage = await retrievedAdapter.unutilizedLeveragePercentage();
      const twapMaxTradeSize = await retrievedAdapter.twapMaxTradeSize();
      const twapCooldownPeriod = await retrievedAdapter.twapCooldownPeriod();
      const slippageTolerance = await retrievedAdapter.slippageTolerance();

      expect(unutilizedLeveragePercentage).to.eq(subjectLeverageTokenSettings.unutilizedLeveragePercentage);
      expect(twapMaxTradeSize).to.eq(subjectLeverageTokenSettings.twapMaxTradeSize);
      expect(twapCooldownPeriod).to.eq(subjectLeverageTokenSettings.twapCooldownPeriod);
      expect(slippageTolerance).to.eq(subjectLeverageTokenSettings.slippageTolerance);
    });

    it("should set the correct incentive parameters", async () => {
      const retrievedAdapter = await subject();

      const incentivizedTwapMaxTradeSize = await retrievedAdapter.incentivizedTwapMaxTradeSize();
      const incentivizedTwapCooldownPeriod = await retrievedAdapter.incentivizedTwapCooldownPeriod();
      const incentivizedSlippageTolerance = await retrievedAdapter.incentivizedSlippageTolerance();
      const etherReward = await retrievedAdapter.etherReward();
      const incentivizedLeverageRatio = await retrievedAdapter.incentivizedLeverageRatio();

      expect(incentivizedTwapMaxTradeSize).to.eq(subjectLeverageTokenSettings.incentivizedTwapMaxTradeSize);
      expect(incentivizedTwapCooldownPeriod).to.eq(subjectLeverageTokenSettings.incentivizedTwapCooldownPeriod);
      expect(incentivizedSlippageTolerance).to.eq(subjectLeverageTokenSettings.incentivizedSlippageTolerance);
      expect(etherReward).to.eq(subjectLeverageTokenSettings.etherReward);
      expect(incentivizedLeverageRatio).to.eq(subjectLeverageTokenSettings.incentivizedLeverageRatio);
    });

    it("should set the correct initial exchange name", async () => {
      const retrievedAdapter = await subject();

      const exchangeName = await retrievedAdapter.exchangeName();

      expect(exchangeName).to.eq(subjectLeverageTokenSettings.exchangeName);
    });

    it("should set the correct initial exchange data", async () => {
      const retrievedAdapter = await subject();

      const exchangeData = await retrievedAdapter.exchangeData();

      expect(exchangeData).to.eq(EMPTY_BYTES);
    });

    describe("when min leverage ratio is above target", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.minLeverageRatio = ether(2.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when max leverage ratio is below target", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.maxLeverageRatio = ether(1.9);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid max leverage");
      });
    });

    describe("when recentering speed is >100%", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.recenteringSpeed = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when recentering speed is 0%", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.recenteringSpeed = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when unutilizedLeveragePercentage is >100%", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.unutilizedLeveragePercentage = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
      });
    });

    describe("when slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.slippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
      });
    });

    describe("when incentivized slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.incentivizedSlippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized slippage tolerance must be <100%");
      });
    });

    describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
      beforeEach(async () => {
        subjectLeverageTokenSettings.incentivizedLeverageRatio = ether(2.29);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
      });
    });
  });

  describe("#engage", async () => {
    let destinationTokenQuantity: BigNumber;
    let subjectCaller: Account;

    context("when rebalance notional is greater than max trade size and greater than max borrow", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        destinationTokenQuantity = ether(0.5);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.engage();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(targetLeverageRatio);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      describe("when borrow balance is not 0", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Debt must be 0");
        });
      });

      describe("when SetToken has 0 supply", async () => {
        beforeEach(async () => {
          await setV2Setup.issuanceModule.redeem(setToken.address, ether(1), owner.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
        });
      });

      describe("when collateral balance is zero", async () => {
        before(async () => {
          // Set collateral asset to cUSDC with 0 balance
          customCTokenCollateralAddress = cUSDC.address;
        });

        after(async () => {
          customCTokenCollateralAddress = undefined;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
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

    context("when rebalance notional is less than max trade size and greater than max borrow", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await flexibleLeverageStrategyAdapter.connect(owner.wallet).setMaxTradeSize(ether(2));

        // Traded amount is equal to account liquidity * buffer percentage
        destinationTokenQuantity = ether(0.7425);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.engage();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(targetLeverageRatio);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });
    });

    context("when rebalance notional is less than max trade size and less than max borrow", async () => {
      before(async () => {
        customTargetLeverageRatio = ether(1.25); // Change to 1.25x
        customMinLeverageRatio = ether(1.1);
      });

      after(async () => {
        customTargetLeverageRatio = undefined;
        customMinLeverageRatio = undefined;
      });

      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Traded amount is equal to account liquidity * buffer percentage
        destinationTokenQuantity = ether(0.25);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.engage();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });
    });
  });

  describe("#rebalance", async () => {
    let destinationTokenQuantity: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateTraderStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
      await flexibleLeverageStrategyAdapter.rebalance();
    });

    context("when current leverage ratio is below target (lever) and no TWAP", async () => {
      beforeEach(async () => {
        destinationTokenQuantity = ether(0.1);
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1010));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).rebalance();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      describe("when rebalance interval has not elapsed but is below min leverage ratio and lower than max trade size", async () => {
        beforeEach(async () => {
          await subject();
          // ~1.6x leverage
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1300));
          await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(2));
          destinationTokenQuantity = ether(1);
          await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const exchangeRate = await cEther.exchangeRateStored();
          const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
          const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });
      });

      describe("when rebalance interval has not elapsed below min leverage ratio and greater than max trade size", async () => {
        beforeEach(async () => {
          await subject();

          // > Max trade size
          destinationTokenQuantity = ether(0.5);
          await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(0.01));
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1500));
          await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
          const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          expect(previousTwapLeverageRatio).to.eq(ZERO);
          expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          await subject();
          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const exchangeRate = await cEther.exchangeRateStored();
          const newUnits = preciseDiv(ether(0.5), exchangeRate);
          const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });

        describe("when TWAP cooldown has not elapsed", async () => {
          beforeEach(async () => {
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cooldown period must have elapsed");
          });
        });
      });

      describe("when rebalance interval has not elapsed", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance interval not yet elapsed");
        });
      });

      describe("when borrow balance is 0", async () => {
        beforeEach(async () => {
          // Repay entire balance of cUSDC on behalf of SetToken
          await cUSDC.repayBorrowBehalf(setToken.address, MAX_UINT_256);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow balance must exist");
        });
      });

      describe("when caller is not an allowed trader", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Address not permitted to trade");
        });
      });

      describe("when caller is a contract", async () => {
        let subjectTarget: Address;
        let subjectCallData: string;
        let subjectValue: BigNumber;

        let contractCaller: ContractCallerMock;

        beforeEach(async () => {
          contractCaller = await deployer.setV2.deployContractCallerMock();

          subjectTarget = flexibleLeverageStrategyAdapter.address;
          subjectCallData = flexibleLeverageStrategyAdapter.interface.encodeFunctionData("rebalance");
          subjectValue = ZERO;
        });

        async function subjectContractCaller(): Promise<any> {
          return await contractCaller.invoke(
            subjectTarget,
            subjectValue,
            subjectCallData
          );
        }

        it("the trade reverts", async () => {
          await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
        });
      });
    });

    context("when current leverage ratio is above target (delever) and no TWAP", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));
        // Set to $990 so need to delever
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).rebalance();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        const previousCTokenBalance = await cEther.balanceOf(setToken.address);

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          currentLeverageRatio,
          targetLeverageRatio,
          minLeverageRatio,
          maxLeverageRatio,
          recenteringSpeed
        );
        // Get expected cTokens redeemed
        const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
          currentLeverageRatio,
          expectedNewLeverageRatio,
          previousCTokenBalance,
          ether(1) // Total supply
        );

        const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      describe("when rebalance interval has not elapsed above max leverage ratio and lower than max trade size", async () => {
        beforeEach(async () => {
          await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();
          // ~2.4x leverage
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(850));
          await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(2));
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(100000000));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

          const previousCTokenBalance = await cEther.balanceOf(setToken.address);

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          // Get expected cTokens redeemed
          const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
            currentLeverageRatio,
            expectedNewLeverageRatio,
            previousCTokenBalance,
            ether(1) // Total supply
          );

          const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });
      });

      describe("when rebalance interval has not elapsed above max leverage ratio and greater than max trade size", async () => {
        let newTWAPMaxTradeSize: BigNumber;

        beforeEach(async () => {
          await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();

          // > Max trade size
          newTWAPMaxTradeSize = ether(0.01);
          await flexibleLeverageStrategyAdapter.setMaxTradeSize(newTWAPMaxTradeSize);

          // ~2.4x leverage
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(850));
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(10000000));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
          const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          expect(previousTwapLeverageRatio).to.eq(ZERO);
          expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Max TWAP collateral units
          const exchangeRate = await cEther.exchangeRateStored();
          const newUnits = preciseDiv(newTWAPMaxTradeSize, exchangeRate);
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });
      });

      describe("when above incentivized leverage ratio threshold", async () => {
        beforeEach(async () => {
          await subject();

          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(650));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must call ripcord");
        });
      });
    });

    context("when currently in the last chunk of a TWAP rebalance", async () => {
      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1200));

        destinationTokenQuantity = ether(0.01);
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(destinationTokenQuantity);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();

        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).rebalance();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should remove the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });
    });

    context("when current leverage ratio is above target and middle of a TWAP rebalance", async () => {
      let preTWAPLeverageRatio: BigNumber;

      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1200));

        destinationTokenQuantity = ether(0.0001);
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(destinationTokenQuantity);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        preTWAPLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).rebalance();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        await subject();

        const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          preTWAPLeverageRatio,
          targetLeverageRatio,
          minLeverageRatio,
          maxLeverageRatio,
          recenteringSpeed
        );
        expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
        expect(currentTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      describe("when price has moved advantageously towards target leverage ratio", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1000));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should remove the TWAP leverage ratio", async () => {
          const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            preTWAPLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          expect(currentTwapLeverageRatio).to.eq(ZERO);
        });

        it("should not update the positions on the SetToken", async () => {
          const initialPositions = await setToken.getPositions();
          await subject();
          const currentPositions = await setToken.getPositions();

          expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
          expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
        });
      });
    });

    context("when current leverage ratio is below target and middle of a TWAP rebalance", async () => {
      let preTWAPLeverageRatio: BigNumber;

      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));

        destinationTokenQuantity = ether(0.0001);
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(destinationTokenQuantity);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        preTWAPLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).rebalance();
      }

      describe("when price has moved advantageously towards target leverage ratio", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1000));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should remove the TWAP leverage ratio", async () => {
          const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            preTWAPLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          expect(previousTwapLeverageRatio).to.eq(expectedNewLeverageRatio);
          expect(currentTwapLeverageRatio).to.eq(ZERO);
        });

        it("should not update the positions on the SetToken", async () => {
          const initialPositions = await setToken.getPositions();
          await subject();
          const currentPositions = await setToken.getPositions();

          expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
          expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
        });
      });
    });
  });

  describe("#ripcord", async () => {
    let transferredEth: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateTraderStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
      await flexibleLeverageStrategyAdapter.rebalance();

      subjectCaller = owner;
    });

    context("when not in a TWAP rebalance", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));

        // Set to above incentivized ratio
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(450000000));

        transferredEth = ether(1);
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyAdapter.address, value: transferredEth});
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).ripcord();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        const previousCTokenBalance = await cEther.balanceOf(setToken.address);

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          currentLeverageRatio,
          targetLeverageRatio,
          minLeverageRatio,
          maxLeverageRatio,
          recenteringSpeed
        );
        // Get expected cTokens redeemed
        const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
          currentLeverageRatio,
          expectedNewLeverageRatio,
          previousCTokenBalance,
          ether(1) // Total supply
        );

        const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should transfer incentive", async () => {
        const previousContractEthBalance = await getEthBalance(flexibleLeverageStrategyAdapter.address);
        const previousOwnerEthBalance = await getEthBalance(owner.address);

        const txHash = await subject();
        const txReceipt = await provider.getTransactionReceipt(txHash.hash);
        const currentContractEthBalance = await getEthBalance(flexibleLeverageStrategyAdapter.address);
        const currentOwnerEthBalance = await getEthBalance(owner.address);
        const expectedOwnerEthBalance = previousOwnerEthBalance.add(etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

        expect(previousContractEthBalance).to.eq(transferredEth);
        expect(currentContractEthBalance).to.eq(transferredEth.sub(etherReward));
        expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
      });

      describe("when greater than incentivized max trade size", async () => {
        let newIncentivizedMaxTradeSize: BigNumber;

        beforeEach(async () => {
          // > Max trade size
          newIncentivizedMaxTradeSize = ether(0.01);
          await flexibleLeverageStrategyAdapter.setIncentivizedMaxTradeSize(newIncentivizedMaxTradeSize);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          expect(previousTwapLeverageRatio).to.eq(ZERO);
          expect(currentTwapLeverageRatio).to.eq(maxLeverageRatio);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Max TWAP collateral units
          const exchangeRate = await cEther.exchangeRateStored();
          const newUnits = preciseDiv(newIncentivizedMaxTradeSize, exchangeRate);
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });

        describe("when incentivized cooldown period has not elapsed", async () => {
          beforeEach(async () => {
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Incentivized cooldown period must have elapsed");
          });
        });
      });

      describe("when greater than max borrow", async () => {
        beforeEach(async () => {
          // Set to above max borrow
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(750));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          const previousTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

          expect(previousTwapLeverageRatio).to.eq(ZERO);
          expect(currentTwapLeverageRatio).to.eq(maxLeverageRatio);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          // Get max borrow
          const previousCTokenBalance = await cEther.balanceOf(setToken.address);
          const exchangeRate = await cEther.exchangeRateStored();
          const previousCollateralBalance = preciseMul(previousCTokenBalance, exchangeRate);

          const previousBorrowBalance = await cUSDC.borrowBalanceStored(setToken.address);

          const collateralPrice = await compoundSetup.priceOracle.getUnderlyingPrice(cEther.address);
          const borrowPrice = await compoundSetup.priceOracle.getUnderlyingPrice(cUSDC.address);
          const collateralFactor = (await compoundSetup.comptroller.markets(cEther.address))[1];

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const maxRedeemCollateral = calculateMaxBorrowForDelever(
            previousCollateralBalance,
            collateralFactor,
            unutilizedLeveragePercentage,
            collateralPrice,
            ether(1),
            borrowPrice,
            previousBorrowBalance,
            BigNumber.from(1000000)
          );

          const maxRedeemCToken = preciseDiv(maxRedeemCollateral, exchangeRate);
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCToken);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });

        describe("when incentivized cooldown period has not elapsed", async () => {
          beforeEach(async () => {
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Incentivized cooldown period must have elapsed");
          });
        });
      });

      describe("when below incentivized leverage ratio threshold", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(2000));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be above incentivized leverage ratio");
        });
      });

      describe("when borrow balance is 0", async () => {
        beforeEach(async () => {
          // Repay entire balance of cUSDC on behalf of SetToken
          await cUSDC.repayBorrowBehalf(setToken.address, MAX_UINT_256);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow balance must exist");
        });
      });

      describe("when caller is a contract", async () => {
        let subjectTarget: Address;
        let subjectCallData: string;
        let subjectValue: BigNumber;

        let contractCaller: ContractCallerMock;

        beforeEach(async () => {
          contractCaller = await deployer.setV2.deployContractCallerMock();

          subjectTarget = flexibleLeverageStrategyAdapter.address;
          subjectCallData = flexibleLeverageStrategyAdapter.interface.encodeFunctionData("ripcord");
          subjectValue = ZERO;
        });

        async function subjectContractCaller(): Promise<any> {
          return await contractCaller.invoke(
            subjectTarget,
            subjectValue,
            subjectCallData
          );
        }

        it("the trade reverts", async () => {
          await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
        });
      });
    });

    context("when in the midst of a TWAP rebalance", async () => {
      let newIncentivizedMaxTradeSize: BigNumber;
      let preTwapLeverageRatio: BigNumber;

      beforeEach(async () => {
        preTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));
        transferredEth = ether(1);
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyAdapter.address, value: transferredEth});

        // > Max trade size
        newIncentivizedMaxTradeSize = ether(0.001);
        await flexibleLeverageStrategyAdapter.setIncentivizedMaxTradeSize(newIncentivizedMaxTradeSize);

        // Set to above incentivized ratio
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

        await flexibleLeverageStrategyAdapter.ripcord();
        await increaseTimeAsync(BigNumber.from(100));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).ripcord();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        await subject();

        const currentTwapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(preTwapLeverageRatio).to.eq(ZERO);
        expect(currentTwapLeverageRatio).to.eq(maxLeverageRatio);
      });
    });
  });

  describe("#disengage", async () => {
    let subjectCaller: Account;

    let ifEngaged: boolean;

    context("when notional is greater than max trade size and total rebalance notional is greater than max borrow", async () => {
      before(async () => {
        ifEngaged = true;
      });

      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        if (ifEngaged) {
          // Add allowed trader
          await flexibleLeverageStrategyAdapter.updateTraderStatus([owner.address], [true]);
          // Engage to initial leverage
          await flexibleLeverageStrategyAdapter.engage();
          await increaseTimeAsync(BigNumber.from(100000));
          await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
          await flexibleLeverageStrategyAdapter.rebalance();

          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(550000000));
        }

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ether(1));
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Max TWAP collateral units
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(twapMaxTradeSize, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      describe("when borrow balance is 0", async () => {
        beforeEach(async () => {
          // Repay entire balance of cUSDC on behalf of SetToken
          await cUSDC.repayBorrowBehalf(setToken.address, MAX_UINT_256);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow balance must exist");
        });
      });

      describe("when SetToken has 0 supply", async () => {
        beforeEach(async () => {
          await setV2Setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
        });
      });

      describe("when collateral balance is zero", async () => {
        before(async () => {
          // Set collateral asset to cUSDC with 0 balance
          customCTokenCollateralAddress = cUSDC.address;
          ifEngaged = false;
        });

        after(async () => {
          customCTokenCollateralAddress = undefined;
          ifEngaged = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
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

    context("when notional is less than max trade size and total rebalance notional is greater than max borrow", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.updateTraderStatus([owner.address], [true]);
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.rebalance();

        // Clear balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(700000000));
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(2));

        // Set price to reduce borrowing power
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1000));

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ether(1));
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        // Get max borrow
        const previousCTokenBalance = await cEther.balanceOf(setToken.address);
        const exchangeRate = await cEther.exchangeRateStored();
        const previousCollateralBalance = preciseMul(previousCTokenBalance, exchangeRate);

        const previousBorrowBalance = await cUSDC.borrowBalanceStored(setToken.address);

        const collateralPrice = await compoundSetup.priceOracle.getUnderlyingPrice(cEther.address);
        const borrowPrice = await compoundSetup.priceOracle.getUnderlyingPrice(cUSDC.address);
        const collateralFactor = (await compoundSetup.comptroller.markets(cEther.address))[1];

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const maxRedeemCollateral = calculateMaxBorrowForDelever(
          previousCollateralBalance,
          collateralFactor,
          unutilizedLeveragePercentage,
          collateralPrice,
          ether(1),
          borrowPrice,
          previousBorrowBalance,
          BigNumber.from(1000000)
        );

        const maxRedeemCToken = preciseDiv(maxRedeemCollateral, exchangeRate);
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(maxRedeemCToken);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];
        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });
    });

    context("when notional is less than max trade size and total rebalance notional is less than max borrow", async () => {
      before(async () => {
        customTargetLeverageRatio = ether(1.25); // Change to 1.25x
        customMinLeverageRatio = ether(1.1);
      });

      after(async () => {
        customTargetLeverageRatio = undefined;
        customMinLeverageRatio = undefined;
      });

      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.25));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();

        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(250000000));
        await flexibleLeverageStrategyAdapter.setIncentivizedMaxTradeSize(ether(2));
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        const previousCTokenBalance = await cEther.balanceOf(setToken.address);

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens redeemed
        const expectedCollateralAssetsRedeemed = calculateCollateralRebalanceUnits(
          currentLeverageRatio,
          ether(1), // 1x leverage
          previousCTokenBalance,
          ether(1) // Total supply
        );

        const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });
    });
  });

  describe("#gulp", async () => {
    let destinationTokenQuantity: BigNumber;

    before(async () => {
      customCompoundLeverageModule = secondCompoundLeverageModule.address;
    });

    after(async () => {
      customCompoundLeverageModule = undefined;
    });

    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      destinationTokenQuantity = ether(0.5);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    });

    async function subject(): Promise<any> {
      return flexibleLeverageStrategyAdapter.gulp();
    }

    it("should update the collateral position on the SetToken correctly", async () => {
      const initialPositions = await setToken.getPositions();

      await subject();

      // cEther position is increased
      const currentPositions = await setToken.getPositions();
      const newFirstPosition = (await setToken.getPositions())[0];

      // Get expected cTokens minted
      const exchangeRate = await cEther.exchangeRateStored();
      const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
      const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

      expect(initialPositions.length).to.eq(1);
      expect(currentPositions.length).to.eq(1);
      expect(newFirstPosition.component).to.eq(cEther.address);
      expect(newFirstPosition.positionState).to.eq(0); // Default
      expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
      expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    });

    describe("when caller is a contract", async () => {
      let subjectTarget: Address;
      let subjectCallData: string;
      let subjectValue: BigNumber;

      let contractCaller: ContractCallerMock;

      beforeEach(async () => {
        contractCaller = await deployer.setV2.deployContractCallerMock();

        subjectTarget = flexibleLeverageStrategyAdapter.address;
        subjectCallData = flexibleLeverageStrategyAdapter.interface.encodeFunctionData("gulp");
        subjectValue = ZERO;
      });

      async function subjectContractCaller(): Promise<any> {
        return await contractCaller.invoke(
          subjectTarget,
          subjectValue,
          subjectCallData
        );
      }

      it("the trade reverts", async () => {
        await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
      });
    });

    describe("when rebalance is in progress", async () => {
      before(async () => {
        // Use default leverage module to engage
        customCompoundLeverageModule = undefined;
      });

      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setMinLeverageRatio", async () => {
    let subjectMinLeverage: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectMinLeverage = ether(1.5);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setMinLeverageRatio(subjectMinLeverage);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.minLeverageRatio();
      expect(actualValue).to.eq(subjectMinLeverage);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setMaxLeverageRatio", async () => {
    let subjectMaxLeverage: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectMaxLeverage = ether(2.5);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setMaxLeverageRatio(subjectMaxLeverage);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.maxLeverageRatio();
      expect(actualValue).to.eq(subjectMaxLeverage);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setRecenteringSpeedPercentage", async () => {
    let subjectRecenteringSpeed: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectRecenteringSpeed = ether(0.05);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setRecenteringSpeedPercentage(subjectRecenteringSpeed);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.recenteringSpeed();
      expect(actualValue).to.eq(subjectRecenteringSpeed);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setRebalanceInterval", async () => {
    let subjectRebalanceInterval: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectRebalanceInterval = BigNumber.from(1000);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setRebalanceInterval(subjectRebalanceInterval);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.rebalanceInterval();
      expect(actualValue).to.eq(subjectRebalanceInterval);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setUnutilizedLeveragePercentage", async () => {
    let subjectBuffer: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectBuffer = ether(0.1);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setUnutilizedLeveragePercentage(subjectBuffer);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.unutilizedLeveragePercentage();
      expect(actualValue).to.eq(subjectBuffer);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setMaxTradeSize", async () => {
    let subjectMaxTradeSize: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectMaxTradeSize = ether(3);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setMaxTradeSize(subjectMaxTradeSize);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.twapMaxTradeSize();
      expect(actualValue).to.eq(subjectMaxTradeSize);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setCooldownPeriod", async () => {
    let subjectCooldownPeriod: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCooldownPeriod = BigNumber.from(100);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setCooldownPeriod(subjectCooldownPeriod);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.twapCooldownPeriod();
      expect(actualValue).to.eq(subjectCooldownPeriod);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setSlippageTolerance", async () => {
    let subjectSlippageTolerance: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSlippageTolerance = ether(0.1);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setSlippageTolerance(subjectSlippageTolerance);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.slippageTolerance();
      expect(actualValue).to.eq(subjectSlippageTolerance);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setIncentivizedMaxTradeSize", async () => {
    let subjectMaxTradeSize: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectMaxTradeSize = ether(6);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setIncentivizedMaxTradeSize(subjectMaxTradeSize);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.incentivizedTwapMaxTradeSize();
      expect(actualValue).to.eq(subjectMaxTradeSize);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setIncentivizedCooldownPeriod", async () => {
    let subjectCooldownPeriod: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCooldownPeriod = BigNumber.from(10);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setIncentivizedCooldownPeriod(subjectCooldownPeriod);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.incentivizedTwapCooldownPeriod();
      expect(actualValue).to.eq(subjectCooldownPeriod);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setIncentivizedSlippageTolerance", async () => {
    let subjectSlippageTolerance: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectSlippageTolerance = ether(0.2);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setIncentivizedSlippageTolerance(subjectSlippageTolerance);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.incentivizedSlippageTolerance();
      expect(actualValue).to.eq(subjectSlippageTolerance);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setIncentivizedLeverageRatio", async () => {
    let subjectLeverageRatio: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectLeverageRatio = ether(0.1);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setIncentivizedLeverageRatio(subjectLeverageRatio);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.incentivizedLeverageRatio();
      expect(actualValue).to.eq(subjectLeverageRatio);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setEtherReward", async () => {
    let subjectEtherReward: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectEtherReward = ether(0.1);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setEtherReward(subjectEtherReward);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.etherReward();
      expect(actualValue).to.eq(subjectEtherReward);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#withdrawEtherBalance", async () => {
    let etherReward: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      etherReward = ether(0.1);
      // Send ETH to contract as reward
      await owner.wallet.sendTransaction({to: flexibleLeverageStrategyAdapter.address, value: etherReward});
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.withdrawEtherBalance();
    }

    it("should withdraw ETH balance on contract to operator", async () => {
      const previousContractEthBalance = await getEthBalance(flexibleLeverageStrategyAdapter.address);
      const previousOwnerEthBalance = await getEthBalance(owner.address);

      const txHash = await subject();
      const txReceipt = await provider.getTransactionReceipt(txHash.hash);
      const currentContractEthBalance = await getEthBalance(flexibleLeverageStrategyAdapter.address);
      const currentOwnerEthBalance = await getEthBalance(owner.address);
      const expectedOwnerEthBalance = previousOwnerEthBalance.add(etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

      expect(previousContractEthBalance).to.eq(etherReward);
      expect(currentContractEthBalance).to.eq(ZERO);
      expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setExchange", async () => {
    let subjectExchangeName: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectExchangeName = "UniswapTradeAdapter";
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setExchange(subjectExchangeName);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.exchangeName();
      expect(actualValue).to.eq(subjectExchangeName);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setExchangeData", async () => {
    let subjectExchangeData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectExchangeData = "0x01";
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setExchangeData(subjectExchangeData);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.exchangeData();
      expect(actualValue).to.eq(subjectExchangeData);
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#updateTraderStatus", async () => {
    let subjectTraders: Address[];
    let subjectStatuses: boolean[];
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectTraders = [otherTrader.address, await getRandomAddress(), await getRandomAddress()];
      subjectStatuses = [true, true, true];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).updateTraderStatus(
        subjectTraders,
        subjectStatuses
      );
    }

    it("the trader status should be flipped to true", async () => {
      await subject();

      const isTraderOne = await flexibleLeverageStrategyAdapter.tradeAllowList(subjectTraders[0]);
      const isTraderTwo = await flexibleLeverageStrategyAdapter.tradeAllowList(subjectTraders[1]);
      const isTraderThree = await flexibleLeverageStrategyAdapter.tradeAllowList(subjectTraders[2]);

      expect(isTraderOne).to.be.true;
      expect(isTraderTwo).to.be.true;
      expect(isTraderThree).to.be.true;
    });

    it("should TraderStatusUpdated event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "TraderStatusUpdated").withArgs(
        subjectTraders[0],
        true
      );
    });

    describe("when array lengths don't match", async () => {
      beforeEach(async () => {
        subjectTraders = [otherTrader.address, await getRandomAddress()];
        subjectStatuses = [false];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("when traders are duplicated", async () => {
      beforeEach(async () => {
        subjectTraders = [otherTrader.address, otherTrader.address, await getRandomAddress()];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Cannot duplicate traders");
      });
    });

    describe("when arrays are empty", async () => {
      beforeEach(async () => {
        subjectTraders = [];
        subjectStatuses = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length must be > 0");
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

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
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
      return await flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).updateAnyoneTrade(subjectStatus);
    }

    it("should flip anyoneTrade", async () => {
      await subject();

      const canAnyoneTrade = await flexibleLeverageStrategyAdapter.anyoneTrade();

      expect(canAnyoneTrade).to.be.true;
    });

    it("should emit an event signaling flip", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "AnyoneTradeUpdated").withArgs(
        true
      );
    });

    describe("when the caller is not the operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#getCurrentEtherIncentive", async () => {
    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateTraderStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyAdapter.rebalance();
    });

    async function subject(): Promise<any> {
      return flexibleLeverageStrategyAdapter.getCurrentEtherIncentive();
    }

    describe("when above incentivized leverage ratio", async () => {
      beforeEach(async () => {
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyAdapter.address, value: ether(1)});
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(650));
      });

      it("should return the correct value", async () => {
        const etherIncentive = await subject();

        expect(etherIncentive).to.eq(etherReward);
      });

      describe("when ETH balance is below ETH reward amount", async () => {
        beforeEach(async () => {
          await flexibleLeverageStrategyAdapter.withdrawEtherBalance();
          // Transfer 0.01 ETH to contract
          await owner.wallet.sendTransaction({to: flexibleLeverageStrategyAdapter.address, value: ether(0.01)});
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(ether(0.01));
        });
      });
    });

    describe("when below incentivized leverage ratio", async () => {
      beforeEach(async () => {
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(2000));
      });

      it("should return the correct value", async () => {
        const etherIncentive = await subject();

        expect(etherIncentive).to.eq(ZERO);
      });
    });
  });

  describe("#shouldRebalance", async () => {
    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateTraderStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyAdapter.rebalance();
    });

    async function subject(): Promise<any> {
      return flexibleLeverageStrategyAdapter.shouldRebalance();
    }

    context("when in the midst of a TWAP rebalance", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        // > Max trade size
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(0.001));

        // Set up new rebalance TWAP
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
        await increaseTimeAsync(BigNumber.from(100000));
        await flexibleLeverageStrategyAdapter.rebalance();
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(TWO);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to below incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));
          await increaseTimeAsync(BigNumber.from(4000));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        });

        it("should not ripcord", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
        });
      });
    });

    context("when not in a TWAP rebalance", async () => {
      describe("when above incentivized leverage ratio", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        });

        it("should return ripcord", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(TWO);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
          await increaseTimeAsync(BigNumber.from(100000));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });
      });

      describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(850));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });
      });

      describe("when below min leverage ratio", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1300));
        });

        it("should return rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ONE);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
        });
      });
    });
  });
});
