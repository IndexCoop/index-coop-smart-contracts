import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import {
  Address,
  Account,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings
} from "@utils/types";
import { ADDRESS_ZERO, ONE, TWO, THREE, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, BaseManager, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundLeverageModule, ContractCallerMock, DebtIssuanceModule, SetToken, ComptrollerMock } from "@utils/contracts/setV2";
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
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let tradeAdapterMock: TradeAdapterMock;
  let gulpComptrollerMock: ComptrollerMock;

  let strategy: ContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;
  let customTargetLeverageRatio: any;
  let customMinLeverageRatio: any;
  let customCTokenCollateralAddress: any;
  let customCompoundLeverageModule: any;

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let secondCompoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let baseManagerV2: BaseManager;

  before(async () => {
    [
      owner,
      methodologist,
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
      ether(1000000000000) // IMPORTANT: Compound oracles account for decimals scaled by 10e18. For USDC, this is $1 * 10^18 * 10^18 / 10^6 = 10^30
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
    gulpComptrollerMock = await deployer.setV2.deployComptrollerMock(
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
  });

  beforeEach(async () => {
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
    await compoundLeverageModule.updateAnySetAllowed(true);
    await secondCompoundLeverageModule.updateAnySetAllowed(true);

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

    baseManagerV2 = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to ic manager
    if ((await setToken.manager()) == owner.address) {
      await setToken.connect(owner.wallet).setManager(baseManagerV2.address);
    }

    // Deploy adapter
    const targetLeverageRatio = customTargetLeverageRatio || ether(2);
    const minLeverageRatio = customMinLeverageRatio || ether(1.7);
    const maxLeverageRatio = ether(2.3);
    const recenteringSpeed = ether(0.05);
    const rebalanceInterval = BigNumber.from(86400);

    const unutilizedLeveragePercentage = ether(0.01);
    const twapMaxTradeSize = ether(0.5);
    const twapCooldownPeriod = BigNumber.from(3000);
    const slippageTolerance = ether(0.01);

    const incentivizedTwapMaxTradeSize = ether(2);
    const incentivizedTwapCooldownPeriod = BigNumber.from(60);
    const incentivizedSlippageTolerance = ether(0.05);
    const etherReward = ether(1);
    const incentivizedLeverageRatio = ether(2.6);

    strategy = {
      setToken: setToken.address,
      leverageModule: customCompoundLeverageModule || compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      priceOracle: compoundSetup.priceOracle.address,
      targetCollateralCToken: customCTokenCollateralAddress || cEther.address,
      targetBorrowCToken: cUSDC.address,
      collateralAsset: setV2Setup.weth.address,
      borrowAsset: setV2Setup.usdc.address,
    };
    methodology = {
      targetLeverageRatio: targetLeverageRatio,
      minLeverageRatio: minLeverageRatio,
      maxLeverageRatio: maxLeverageRatio,
      recenteringSpeed: recenteringSpeed,
      rebalanceInterval: rebalanceInterval,
    };
    execution = {
      unutilizedLeveragePercentage: unutilizedLeveragePercentage,
      twapMaxTradeSize: twapMaxTradeSize,
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
      exchangeName: "MockTradeAdapter",
      exchangeData: EMPTY_BYTES,
    };
    incentive = {
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };

    flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
      baseManagerV2.address,
      strategy,
      methodology,
      execution,
      incentive
    );

    // Add adapter
    await baseManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManagerAddress: Address;
    let subjectContractSettings: ContractSettings;
    let subjectMethodologySettings: MethodologySettings;
    let subjectExecutionSettings: ExecutionSettings;
    let subjectIncentiveSettings: IncentiveSettings;

    beforeEach(async () => {
      subjectManagerAddress = baseManagerV2.address;
      subjectContractSettings = {
        setToken: setToken.address,
        leverageModule: compoundLeverageModule.address,
        comptroller: compoundSetup.comptroller.address,
        priceOracle: compoundSetup.priceOracle.address,
        targetCollateralCToken: cEther.address,
        targetBorrowCToken: cUSDC.address,
        collateralAsset: setV2Setup.weth.address,
        borrowAsset: setV2Setup.usdc.address,
      };
      subjectMethodologySettings = {
        targetLeverageRatio: ether(2),
        minLeverageRatio: ether(1.7),
        maxLeverageRatio: ether(2.3),
        recenteringSpeed: ether(0.05),
        rebalanceInterval: BigNumber.from(86400),
      };
      subjectExecutionSettings = {
        unutilizedLeveragePercentage: ether(0.01),
        twapMaxTradeSize: ether(0.1),
        twapCooldownPeriod: BigNumber.from(120),
        slippageTolerance: ether(0.01),
        exchangeName: "MockTradeAdapter",
        exchangeData: EMPTY_BYTES,
      };
      subjectIncentiveSettings = {
        incentivizedTwapMaxTradeSize: ether(1),
        incentivizedTwapCooldownPeriod: BigNumber.from(60),
        incentivizedSlippageTolerance: ether(0.05),
        etherReward: ether(1),
        incentivizedLeverageRatio: ether(3.5),
      };
    });

    async function subject(): Promise<FlexibleLeverageStrategyAdapter> {
      return await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
        subjectManagerAddress,
        subjectContractSettings,
        subjectMethodologySettings,
        subjectExecutionSettings,
        subjectIncentiveSettings
      );
    }

    it("should set the manager address", async () => {
      const retrievedAdapter = await subject();

      const manager = await retrievedAdapter.manager();

      expect(manager).to.eq(subjectManagerAddress);
    });

    it("should set the contract addresses", async () => {
      const retrievedAdapter = await subject();
      const strategy = await retrievedAdapter.strategy();

      expect(strategy.setToken).to.eq(subjectContractSettings.setToken);
      expect(strategy.leverageModule).to.eq(subjectContractSettings.leverageModule);
      expect(strategy.comptroller).to.eq(subjectContractSettings.comptroller);
      expect(strategy.priceOracle).to.eq(subjectContractSettings.priceOracle);
      expect(strategy.targetCollateralCToken).to.eq(subjectContractSettings.targetCollateralCToken);
      expect(strategy.targetBorrowCToken).to.eq(subjectContractSettings.targetBorrowCToken);
      expect(strategy.collateralAsset).to.eq(subjectContractSettings.collateralAsset);
      expect(strategy.borrowAsset).to.eq(subjectContractSettings.borrowAsset);
    });

    it("should set the correct methodology parameters", async () => {
      const retrievedAdapter = await subject();
      const methodology = await retrievedAdapter.methodology();

      expect(methodology.targetLeverageRatio).to.eq(subjectMethodologySettings.targetLeverageRatio);
      expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
      expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
      expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
      expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
    });

    it("should set the correct execution parameters", async () => {
      const retrievedAdapter = await subject();
      const execution = await retrievedAdapter.execution();

      expect(execution.unutilizedLeveragePercentage).to.eq(subjectExecutionSettings.unutilizedLeveragePercentage);
      expect(execution.twapMaxTradeSize).to.eq(subjectExecutionSettings.twapMaxTradeSize);
      expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
      expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
      expect(execution.exchangeName).to.eq(subjectExecutionSettings.exchangeName);
      expect(execution.exchangeData).to.eq(subjectExecutionSettings.exchangeData);
    });

    it("should set the correct incentive parameters", async () => {
      const retrievedAdapter = await subject();
      const incentive = await retrievedAdapter.incentive();

      expect(incentive.incentivizedTwapMaxTradeSize).to.eq(subjectIncentiveSettings.incentivizedTwapMaxTradeSize);
      expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
      expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
      expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
      expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
    });

    describe("when min leverage ratio is 0", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.minLeverageRatio = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when min leverage ratio is above target", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.minLeverageRatio = ether(2.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when max leverage ratio is below target", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.maxLeverageRatio = ether(1.9);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid max leverage");
      });
    });

    describe("when recentering speed is >100%", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.recenteringSpeed = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when recentering speed is 0%", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.recenteringSpeed = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when unutilizedLeveragePercentage is >100%", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.unutilizedLeveragePercentage = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
      });
    });

    describe("when slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.slippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
      });
    });

    describe("when incentivized slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedSlippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized slippage tolerance must be <100%");
      });
    });

    describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedLeverageRatio = ether(2.29);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
      });
    });

    describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.rebalanceInterval = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
      });
    });

    describe("when TWAP cooldown period is shorter than incentivized TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.twapCooldownPeriod = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
      });
    });

    describe("when TWAP max trade size is greater than incentivized TWAP max trade size", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.twapMaxTradeSize = ether(3);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP max trade size must be less than incentivized TWAP max trade size");
      });
    });
  });

  describe("#engage", async () => {
    let destinationTokenQuantity: BigNumber;
    let subjectCaller: Account;

    context("when rebalance notional is greater than max trade size and greater than max borrow", async () => {
      let issueQuantity: BigNumber;

      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
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

        expect(twapLeverageRatio).to.eq(methodology.targetLeverageRatio);
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

      it("should emit Engaged event", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
        const exchangeRate = await cEther.exchangeRateStored();
        const cEtherBalance = await cEther.balanceOf(setToken.address);
        const totalRebalanceNotional = preciseMul(exchangeRate, cEtherBalance);

        const chunkRebalanceNotional = preciseMul(issueQuantity, execution.twapMaxTradeSize);
        await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "Engaged").withArgs(
          currentLeverageRatio,
          methodology.targetLeverageRatio,
          chunkRebalanceNotional,
          totalRebalanceNotional,
        );
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

        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: ether(1.9),
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);

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

        expect(twapLeverageRatio).to.eq(methodology.targetLeverageRatio);
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
    let ifEngaged: boolean;

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

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

      if (ifEngaged) {
        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(100000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.iterateRebalance();
      }
    });

    context("when current leverage ratio is below target (lever)", async () => {
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

      it("should emit Rebalanced event", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          currentLeverageRatio,
          methodology.targetLeverageRatio,
          methodology.minLeverageRatio,
          methodology.maxLeverageRatio,
          methodology.recenteringSpeed
        );
        const exchangeRate = await cEther.exchangeRateStored();
        const cEtherBalance = await cEther.balanceOf(setToken.address);
        const collateralBalance = preciseMul(exchangeRate, cEtherBalance);
        const totalRebalanceNotional = preciseMul(
          preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
          collateralBalance
        );

        await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "Rebalanced").withArgs(
          currentLeverageRatio,
          expectedNewLeverageRatio,
          totalRebalanceNotional,
          totalRebalanceNotional,
        );
      });

      describe("when rebalance interval has not elapsed but is below min leverage ratio and lower than max trade size", async () => {
        beforeEach(async () => {
          await subject();
          // ~1.6x leverage
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1300));
          const newExecutionSettings = {
            unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
            twapMaxTradeSize: ether(1.9),
            twapCooldownPeriod: execution.twapCooldownPeriod,
            slippageTolerance: execution.slippageTolerance,
            exchangeName: "MockTradeAdapter",
            exchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
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
          const newExecutionSettings = {
            unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
            twapMaxTradeSize: ether(0.01),
            twapCooldownPeriod: execution.twapCooldownPeriod,
            slippageTolerance: execution.slippageTolerance,
            exchangeName: "MockTradeAdapter",
            exchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
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
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
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
      });

      describe("when rebalance interval has not elapsed", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
        });
      });

      describe("when in a TWAP rebalance", async () => {
        beforeEach(async () => {
          await increaseTimeAsync(BigNumber.from(100000));
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1200));

          const newExecutionSettings = {
            unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
            twapMaxTradeSize: ether(0.01),
            twapCooldownPeriod: execution.twapCooldownPeriod,
            slippageTolerance: execution.slippageTolerance,
            exchangeName: "MockTradeAdapter",
            exchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
          await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.01));

          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must call iterate");
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
          await expect(subject()).to.be.revertedWith("Address not permitted to call");
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

      describe("when SetToken has 0 supply", async () => {
        beforeEach(async () => {
          await setV2Setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
        });
      });
    });

    context("when current leverage ratio is above target (delever)", async () => {
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
          methodology.targetLeverageRatio,
          methodology.minLeverageRatio,
          methodology.maxLeverageRatio,
          methodology.recenteringSpeed
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
          const newExecutionSettings = {
            unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
            twapMaxTradeSize: ether(1.9),
            twapCooldownPeriod: execution.twapCooldownPeriod,
            slippageTolerance: execution.slippageTolerance,
            exchangeName: "MockTradeAdapter",
            exchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
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
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
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
          const newExecutionSettings = {
            unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
            twapMaxTradeSize: newTWAPMaxTradeSize,
            twapCooldownPeriod: execution.twapCooldownPeriod,
            slippageTolerance: execution.slippageTolerance,
            exchangeName: "MockTradeAdapter",
            exchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
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
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
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
          await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
        });
      });
    });

    context("when not engaged", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.rebalance();
      }

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
    });
  });

  describe("#iterateRebalance", async () => {
    let destinationTokenQuantity: BigNumber;
    let subjectCaller: Account;
    let ifEngaged: boolean;
    let issueQuantity: BigNumber;

    before(async () => {
      ifEngaged = true;
    });

    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

      if (ifEngaged) {
        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(100000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.iterateRebalance();
      }
    });

    context("when currently in the last chunk of a TWAP rebalance", async () => {
      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1200));

        destinationTokenQuantity = ether(0.01);
        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: destinationTokenQuantity,
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();

        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).iterateRebalance();
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
      let preTwapLeverageRatio: BigNumber;

      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1200));

        destinationTokenQuantity = ether(0.0001);
        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: destinationTokenQuantity,
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        preTwapLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        // Initialize TWAP
        await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).iterateRebalance();
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
          preTwapLeverageRatio,
          methodology.targetLeverageRatio,
          methodology.minLeverageRatio,
          methodology.maxLeverageRatio,
          methodology.recenteringSpeed
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

      it("should emit RebalanceIterated event", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          preTwapLeverageRatio,
          methodology.targetLeverageRatio,
          methodology.minLeverageRatio,
          methodology.maxLeverageRatio,
          methodology.recenteringSpeed
        );
        const cEtherBalance = await cEther.balanceOf(setToken.address);
        const exchangeRate = await cEther.exchangeRateStored();
        const collateralBalance = preciseMul(exchangeRate, cEtherBalance);
        const totalRebalanceNotional = preciseMul(
          preciseDiv(expectedNewLeverageRatio.sub(currentLeverageRatio), currentLeverageRatio),
          collateralBalance
        );
        const chunkRebalanceNotional = preciseMul(issueQuantity, destinationTokenQuantity);

        await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "RebalanceIterated").withArgs(
          currentLeverageRatio,
          expectedNewLeverageRatio,
          chunkRebalanceNotional,
          totalRebalanceNotional,
        );
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
            preTwapLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
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

      describe("when above incentivized leverage ratio threshold", async () => {
        beforeEach(async () => {
          await subject();

          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(650));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
        });
      });

      describe("when cooldown has not elapsed", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
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
          await expect(subject()).to.be.revertedWith("Address not permitted to call");
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
          subjectCallData = flexibleLeverageStrategyAdapter.interface.encodeFunctionData("iterateRebalance");
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

      describe("when SetToken has 0 supply", async () => {
        beforeEach(async () => {
          await setV2Setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
        });
      });
    });

    context("when current leverage ratio is below target and middle of a TWAP rebalance", async () => {
      let preTwapLeverageRatio: BigNumber;

      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));

        destinationTokenQuantity = ether(0.0001);
        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: destinationTokenQuantity,
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        preTwapLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();

        await flexibleLeverageStrategyAdapter.connect(owner.wallet).rebalance();
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).iterateRebalance();
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
            preTwapLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
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

    context("when not engaged", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.iterateRebalance();
      }

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
    });
  });

  describe("#ripcord", async () => {
    let transferredEth: BigNumber;
    let subjectCaller: Account;
    let ifEngaged: boolean;

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

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

      if (ifEngaged) {
        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(100000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.iterateRebalance();
      }

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
          methodology.targetLeverageRatio,
          methodology.minLeverageRatio,
          methodology.maxLeverageRatio,
          methodology.recenteringSpeed
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
        const expectedOwnerEthBalance = previousOwnerEthBalance.add(incentive.etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

        expect(previousContractEthBalance).to.eq(transferredEth);
        expect(currentContractEthBalance).to.eq(transferredEth.sub(incentive.etherReward));
        expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
      });

      it("should emit RipcordCalled event", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
        const exchangeRate = await cEther.exchangeRateStored();
        const cEtherBalance = await cEther.balanceOf(setToken.address);
        const collateralBalance = preciseMul(exchangeRate, cEtherBalance);
        const chunkRebalanceNotional = preciseMul(
          preciseDiv(currentLeverageRatio.sub(methodology.maxLeverageRatio), currentLeverageRatio),
          collateralBalance
        );

        await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "RipcordCalled").withArgs(
          currentLeverageRatio,
          methodology.maxLeverageRatio,
          chunkRebalanceNotional,
          incentive.etherReward,
        );
      });

      describe("when greater than incentivized max trade size", async () => {
        let newIncentivizedMaxTradeSize: BigNumber;

        beforeEach(async () => {
          // > Max trade size
          const newExecutionSettings = {
            unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
            twapMaxTradeSize: ether(0.001),
            twapCooldownPeriod: execution.twapCooldownPeriod,
            slippageTolerance: execution.slippageTolerance,
            exchangeName: "MockTradeAdapter",
            exchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
          newIncentivizedMaxTradeSize = ether(0.01);
          const newIncentiveSettings = {
            incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
            incentivizedTwapCooldownPeriod: incentive.incentivizedTwapCooldownPeriod,
            incentivizedSlippageTolerance: incentive.incentivizedSlippageTolerance,
            etherReward: incentive.etherReward,
            incentivizedLeverageRatio: incentive.incentivizedLeverageRatio,
          };
          await flexibleLeverageStrategyAdapter.setIncentiveSettings(newIncentiveSettings);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
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
            await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(400));
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("TWAP cooldown must have elapsed");
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
            execution.unutilizedLeveragePercentage,
            collateralPrice,
            borrowPrice,
            previousBorrowBalance,
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

      describe("when SetToken has 0 supply", async () => {
        beforeEach(async () => {
          await setV2Setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          await debtIssuanceModule.redeem(setToken.address, ether(1), owner.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SetToken must have > 0 supply");
        });
      });
    });

    context("when in the midst of a TWAP rebalance", async () => {
      let newIncentivizedMaxTradeSize: BigNumber;

      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));
        transferredEth = ether(1);
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyAdapter.address, value: transferredEth});

        // > Max trade size
        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: ether(0.0001),
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);
        newIncentivizedMaxTradeSize = ether(0.001);
        const newIncentiveSettings = {
          incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
          incentivizedTwapCooldownPeriod: incentive.incentivizedTwapCooldownPeriod,
          incentivizedSlippageTolerance: incentive.incentivizedSlippageTolerance,
          etherReward: incentive.etherReward,
          incentivizedLeverageRatio: incentive.incentivizedLeverageRatio,
        };
        await flexibleLeverageStrategyAdapter.setIncentiveSettings(newIncentiveSettings);

        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

        // Start TWAP rebalance
        await flexibleLeverageStrategyAdapter.rebalance();
        await increaseTimeAsync(BigNumber.from(100));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

        // Set to above incentivized ratio
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet).ripcord();
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyAdapter.lastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio to 0", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyAdapter.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });
    });

    context("when not engaged", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.ripcord();
      }

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
          await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);
          // Engage to initial leverage
          await flexibleLeverageStrategyAdapter.engage();
          await increaseTimeAsync(BigNumber.from(100000));
          await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
          await flexibleLeverageStrategyAdapter.iterateRebalance();

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

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Max TWAP collateral units
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(execution.twapMaxTradeSize, exchangeRate);
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
        await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.iterateRebalance();

        // Clear balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(700000000));

        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: ether(1.9),
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);

        // Set price to reduce borrowing power
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1000));

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

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
          execution.unutilizedLeveragePercentage,
          collateralPrice,
          borrowPrice,
          previousBorrowBalance,
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
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

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

  describe("#setMethodologySettings", async () => {
    let subjectMethodologySettings: MethodologySettings;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectMethodologySettings = {
        targetLeverageRatio: ether(2.1),
        minLeverageRatio: ether(1.1),
        maxLeverageRatio: ether(2.5),
        recenteringSpeed: ether(0.1),
        rebalanceInterval: BigNumber.from(43200),
      };
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setMethodologySettings(subjectMethodologySettings);
    }

    it("should set the correct methodology parameters", async () => {
      await subject();
      const methodology = await flexibleLeverageStrategyAdapter.methodology();

      expect(methodology.targetLeverageRatio).to.eq(subjectMethodologySettings.targetLeverageRatio);
      expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
      expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
      expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
      expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
    });

    it("should emit MethodologySettingsUpdated event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "MethodologySettingsUpdated").withArgs(
        subjectMethodologySettings.targetLeverageRatio,
        subjectMethodologySettings.minLeverageRatio,
        subjectMethodologySettings.maxLeverageRatio,
        subjectMethodologySettings.recenteringSpeed,
        subjectMethodologySettings.rebalanceInterval,
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

    describe("when min leverage ratio is 0", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.minLeverageRatio = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when min leverage ratio is above target", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.minLeverageRatio = ether(2.2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid min leverage");
      });
    });

    describe("when max leverage ratio is below target", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.maxLeverageRatio = ether(1.9);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid max leverage");
      });
    });

    describe("when max leverage ratio is above incentivized leverage ratio", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.maxLeverageRatio = ether(5);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
      });
    });

    describe("when recentering speed is >100%", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.recenteringSpeed = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when recentering speed is 0%", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.recenteringSpeed = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid recentering speed");
      });
    });

    describe("when rebalance interval is shorter than TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectMethodologySettings.rebalanceInterval = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
      });
    });
  });

  describe("#setExecutionSettings", async () => {
    let subjectExecutionSettings: ExecutionSettings;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectExecutionSettings = {
        unutilizedLeveragePercentage: ether(0.05),
        twapMaxTradeSize: ether(0.5),
        twapCooldownPeriod: BigNumber.from(360),
        slippageTolerance: ether(0.02),
        exchangeName: "TestTradeAdapter",
        exchangeData: "0x0000000000000000000000000000000000000000000000000000000000000001",
      };
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setExecutionSettings(subjectExecutionSettings);
    }

    it("should set the correct execution parameters", async () => {
      await subject();
      const execution = await flexibleLeverageStrategyAdapter.execution();

      expect(execution.unutilizedLeveragePercentage).to.eq(subjectExecutionSettings.unutilizedLeveragePercentage);
      expect(execution.twapMaxTradeSize).to.eq(subjectExecutionSettings.twapMaxTradeSize);
      expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
      expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
      expect(execution.exchangeName).to.eq(subjectExecutionSettings.exchangeName);
      expect(execution.exchangeData).to.eq(subjectExecutionSettings.exchangeData);
    });

    it("should emit ExecutionSettingsUpdated event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "ExecutionSettingsUpdated").withArgs(
        subjectExecutionSettings.unutilizedLeveragePercentage,
        subjectExecutionSettings.twapMaxTradeSize,
        subjectExecutionSettings.twapCooldownPeriod,
        subjectExecutionSettings.slippageTolerance,
        subjectExecutionSettings.exchangeName,
        subjectExecutionSettings.exchangeData,
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

    describe("when unutilizedLeveragePercentage is >100%", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.unutilizedLeveragePercentage = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unutilized leverage must be <100%");
      });
    });

    describe("when slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.slippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Slippage tolerance must be <100%");
      });
    });

    describe("when TWAP cooldown period is greater than rebalance interval", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.twapCooldownPeriod = ether(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance interval must be greater than TWAP cooldown period");
      });
    });

    describe("when TWAP cooldown period is shorter than incentivized TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.twapCooldownPeriod = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
      });
    });

    describe("when TWAP max trade size is greater than incentivized TWAP max trade size", async () => {
      beforeEach(async () => {
        subjectExecutionSettings.twapMaxTradeSize = ether(3);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP max trade size must be less than incentivized TWAP max trade size");
      });
    });
  });

  describe("#setIncentiveSettings", async () => {
    let subjectIncentiveSettings: IncentiveSettings;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectIncentiveSettings = {
        incentivizedTwapMaxTradeSize: ether(1.1),
        incentivizedTwapCooldownPeriod: BigNumber.from(30),
        incentivizedSlippageTolerance: ether(0.1),
        etherReward: ether(5),
        incentivizedLeverageRatio: ether(3.2),
      };
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setIncentiveSettings(subjectIncentiveSettings);
    }

    it("should set the correct incentive parameters", async () => {
      await subject();
      const incentive = await flexibleLeverageStrategyAdapter.incentive();

      expect(incentive.incentivizedTwapMaxTradeSize).to.eq(subjectIncentiveSettings.incentivizedTwapMaxTradeSize);
      expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
      expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
      expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
      expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
    });

    it("should emit IncentiveSettingsUpdated event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyAdapter, "IncentiveSettingsUpdated").withArgs(
        subjectIncentiveSettings.etherReward,
        subjectIncentiveSettings.incentivizedLeverageRatio,
        subjectIncentiveSettings.incentivizedSlippageTolerance,
        subjectIncentiveSettings.incentivizedTwapCooldownPeriod,
        subjectIncentiveSettings.incentivizedTwapMaxTradeSize,
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

    describe("when incentivized TWAP cooldown period is greater than TWAP cooldown period", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedTwapCooldownPeriod = ether(1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
      });
    });

    describe("when incentivized TWAP max trade size is less than TWAP max trade size", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedTwapMaxTradeSize = ether(0.01);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("TWAP max trade size must be less than incentivized TWAP max trade size");
      });
    });

    describe("when incentivized slippage tolerance is >100%", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedSlippageTolerance = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized slippage tolerance must be <100%");
      });
    });

    describe("when incentivize leverage ratio is less than max leverage ratio", async () => {
      beforeEach(async () => {
        subjectIncentiveSettings.incentivizedLeverageRatio = ether(2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Incentivized leverage ratio must be > max leverage ratio");
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

  describe("#getCurrentEtherIncentive", async () => {
    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyAdapter.iterateRebalance();
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

        expect(etherIncentive).to.eq(incentive.etherReward);
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
      await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyAdapter.iterateRebalance();
    });

    async function subject(): Promise<any> {
      return flexibleLeverageStrategyAdapter.shouldRebalance();
    }

    context("when in the midst of a TWAP rebalance", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        // > Max trade size
        const newExecutionSettings = {
          unutilizedLeveragePercentage: execution.unutilizedLeveragePercentage,
          twapMaxTradeSize: ether(0.001),
          twapCooldownPeriod: execution.twapCooldownPeriod,
          slippageTolerance: execution.slippageTolerance,
          exchangeName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyAdapter.setExecutionSettings(newExecutionSettings);

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

          expect(shouldRebalance).to.eq(THREE);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to below incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(900));
          await increaseTimeAsync(BigNumber.from(4000));
        });

        it("should return iterate rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(TWO);
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        });

        it("should not rebalance", async () => {
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
      describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(THREE);
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

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(800));
        });

        it("should not rebalance", async () => {
          const shouldRebalance = await subject();

          expect(shouldRebalance).to.eq(ZERO);
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
