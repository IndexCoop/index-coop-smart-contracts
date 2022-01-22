import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import {
  Address,
  Account,
  ContractSettings,
  MethodologySettings,
  ExecutionSettings,
  IncentiveSettings,
  ExchangeSettings
} from "@utils/types";
import { ADDRESS_ZERO, ONE, TWO, THREE, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { FlexibleLeverageStrategyExtension, BaseManagerV2, TradeAdapterMock, ChainlinkAggregatorV3Mock } from "@utils/contracts/index";
import { CompoundLeverageModule, ContractCallerMock, DebtIssuanceModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
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
  calculateMaxBorrowForDelever,
  calculateMaxRedeemForDeleverToZero,
  usdc
} from "@utils/index";
import { SetFixture, CompoundFixture } from "@utils/fixtures";
import { calculateTotalRebalanceNotionalCompound } from "@utils/flexibleLeverageUtils/flexibleLeverage";

const expect = getWaffleExpect();
const provider = ethers.provider;

describe("FlexibleLeverageStrategyExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let tradeAdapterMock: TradeAdapterMock;
  let tradeAdapterMock2: TradeAdapterMock;

  let strategy: ContractSettings;
  let methodology: MethodologySettings;
  let execution: ExecutionSettings;
  let incentive: IncentiveSettings;
  let exchangeName: string;
  let exchangeName2: string;
  let exchangeSettings: ExchangeSettings;
  let customTargetLeverageRatio: any;
  let customMinLeverageRatio: any;
  let customCTokenCollateralAddress: any;

  let flexibleLeverageStrategyExtension: FlexibleLeverageStrategyExtension;
  let compoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let baseManagerV2: BaseManagerV2;

  let chainlinkCollateralPriceMock: ChainlinkAggregatorV3Mock;
  let chainlinkBorrowPriceMock: ChainlinkAggregatorV3Mock;

  cacheBeforeEach(async () => {
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

    debtIssuanceModule = await deployer.setV2.deployDebtIssuanceModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    // Deploy mock trade extension
    tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );

    // Deploy mock trade extension 2
    tradeAdapterMock2 = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "MockTradeAdapter2",
      tradeAdapterMock2.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );

    // Deploy Chainlink mocks
    chainlinkCollateralPriceMock = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
    chainlinkBorrowPriceMock = await deployer.mocks.deployChainlinkAggregatorMock();
    await chainlinkBorrowPriceMock.setPrice(10 ** 8);
  });

  const initializeRootScopeContracts = async () => {
    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [BigNumber.from(5000000000)], // Equivalent to 1 ETH
      [
        setV2Setup.issuanceModule.address,
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        debtIssuanceModule.address,
      ]
    );
    await compoundLeverageModule.updateAnySetAllowed(true);

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

    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      owner.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();

    // Transfer ownership to ic manager
    if ((await setToken.manager()) == owner.address) {
      await setToken.connect(owner.wallet).setManager(baseManagerV2.address);
    }

    // Deploy extension
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
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      collateralPriceOracle: chainlinkCollateralPriceMock.address,
      borrowPriceOracle: chainlinkBorrowPriceMock.address,
      targetCollateralCToken: customCTokenCollateralAddress || cEther.address,
      targetBorrowCToken: cUSDC.address,
      collateralAsset: setV2Setup.weth.address,
      borrowAsset: setV2Setup.usdc.address,
      collateralDecimalAdjustment: BigNumber.from(10),
      borrowDecimalAdjustment: BigNumber.from(22),
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
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
    };
    incentive = {
      incentivizedTwapCooldownPeriod: incentivizedTwapCooldownPeriod,
      incentivizedSlippageTolerance: incentivizedSlippageTolerance,
      etherReward: etherReward,
      incentivizedLeverageRatio: incentivizedLeverageRatio,
    };
    exchangeName = "MockTradeAdapter";
    exchangeName2 = "MockTradeAdapter2";
    exchangeSettings = {
      twapMaxTradeSize: twapMaxTradeSize,
      incentivizedTwapMaxTradeSize: incentivizedTwapMaxTradeSize,
      exchangeLastTradeTimestamp: BigNumber.from(0),
      leverExchangeData: EMPTY_BYTES,
      deleverExchangeData: EMPTY_BYTES,
    };

    flexibleLeverageStrategyExtension = await deployer.extensions.deployFlexibleLeverageStrategyExtension(
      baseManagerV2.address,
      strategy,
      methodology,
      execution,
      incentive,
      [ exchangeName ],
      [ exchangeSettings ]
    );

    // Add extension
    await baseManagerV2.connect(owner.wallet).addExtension(flexibleLeverageStrategyExtension.address);
  };

  describe("#constructor", async () => {
    let subjectManagerAddress: Address;
    let subjectContractSettings: ContractSettings;
    let subjectMethodologySettings: MethodologySettings;
    let subjectExecutionSettings: ExecutionSettings;
    let subjectIncentiveSettings: IncentiveSettings;
    let subjectExchangeName: string;
    let subjectExchangeSettings: ExchangeSettings;

    cacheBeforeEach(initializeRootScopeContracts);

    beforeEach(async () => {
      subjectManagerAddress = baseManagerV2.address;
      subjectContractSettings = {
        setToken: setToken.address,
        leverageModule: compoundLeverageModule.address,
        comptroller: compoundSetup.comptroller.address,
        collateralPriceOracle: chainlinkCollateralPriceMock.address,
        borrowPriceOracle: chainlinkBorrowPriceMock.address,
        targetCollateralCToken: cEther.address,
        targetBorrowCToken: cUSDC.address,
        collateralAsset: setV2Setup.weth.address,
        borrowAsset: setV2Setup.usdc.address,
        collateralDecimalAdjustment: BigNumber.from(10),
        borrowDecimalAdjustment: BigNumber.from(22),
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
        twapCooldownPeriod: BigNumber.from(120),
        slippageTolerance: ether(0.01),
      };
      subjectIncentiveSettings = {
        incentivizedTwapCooldownPeriod: BigNumber.from(60),
        incentivizedSlippageTolerance: ether(0.05),
        etherReward: ether(1),
        incentivizedLeverageRatio: ether(3.5),
      };
      subjectExchangeName = "MockTradeAdapter";
      subjectExchangeSettings = {
        twapMaxTradeSize: ether(0.1),
        incentivizedTwapMaxTradeSize: ether(1),
        exchangeLastTradeTimestamp: BigNumber.from(0),
        leverExchangeData: EMPTY_BYTES,
        deleverExchangeData: EMPTY_BYTES,
      };
    });

    async function subject(): Promise<FlexibleLeverageStrategyExtension> {
      return await deployer.extensions.deployFlexibleLeverageStrategyExtension(
        subjectManagerAddress,
        subjectContractSettings,
        subjectMethodologySettings,
        subjectExecutionSettings,
        subjectIncentiveSettings,
        [ subjectExchangeName ],
        [ subjectExchangeSettings ]
      );
    }

    it("should set the manager address", async () => {
      const retrievedAdapter = await subject();

      const manager = await retrievedAdapter.manager();

      expect(manager).to.eq(subjectManagerAddress);
    });

    it("should set the contract addresses", async () => {
      const retrievedAdapter = await subject();
      const strategy = await retrievedAdapter.getStrategy();

      expect(strategy.setToken).to.eq(subjectContractSettings.setToken);
      expect(strategy.leverageModule).to.eq(subjectContractSettings.leverageModule);
      expect(strategy.comptroller).to.eq(subjectContractSettings.comptroller);
      expect(strategy.collateralPriceOracle).to.eq(subjectContractSettings.collateralPriceOracle);
      expect(strategy.borrowPriceOracle).to.eq(subjectContractSettings.borrowPriceOracle);
      expect(strategy.targetCollateralCToken).to.eq(subjectContractSettings.targetCollateralCToken);
      expect(strategy.targetBorrowCToken).to.eq(subjectContractSettings.targetBorrowCToken);
      expect(strategy.collateralAsset).to.eq(subjectContractSettings.collateralAsset);
      expect(strategy.borrowAsset).to.eq(subjectContractSettings.borrowAsset);
    });

    it("should set the correct methodology parameters", async () => {
      const retrievedAdapter = await subject();
      const methodology = await retrievedAdapter.getMethodology();

      expect(methodology.targetLeverageRatio).to.eq(subjectMethodologySettings.targetLeverageRatio);
      expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
      expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
      expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
      expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
    });

    it("should set the correct execution parameters", async () => {
      const retrievedAdapter = await subject();
      const execution = await retrievedAdapter.getExecution();

      expect(execution.unutilizedLeveragePercentage).to.eq(subjectExecutionSettings.unutilizedLeveragePercentage);
      expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
      expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
    });

    it("should set the correct incentive parameters", async () => {
      const retrievedAdapter = await subject();
      const incentive = await retrievedAdapter.getIncentive();

      expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
      expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
      expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
      expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
    });

    it("should set the correct exchange settings for the initial exchange", async () => {
      const retrievedAdapter = await subject();
      const exchangeSettings = await retrievedAdapter.getExchangeSettings(subjectExchangeName);

      expect(exchangeSettings.leverExchangeData).to.eq(subjectExchangeSettings.leverExchangeData);
      expect(exchangeSettings.deleverExchangeData).to.eq(subjectExchangeSettings.deleverExchangeData);
      expect(exchangeSettings.twapMaxTradeSize).to.eq(subjectExchangeSettings.twapMaxTradeSize);
      expect(exchangeSettings.incentivizedTwapMaxTradeSize).to.eq(subjectExchangeSettings.incentivizedTwapMaxTradeSize);
      expect(exchangeSettings.exchangeLastTradeTimestamp).to.eq(subjectExchangeSettings.exchangeLastTradeTimestamp);
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

    describe("when an exchange has a twapMaxTradeSize of 0", async () => {
      beforeEach(async () => {
        subjectExchangeSettings.twapMaxTradeSize = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
      });
    });
  });

  describe("#engage", async () => {
    let destinationTokenQuantity: BigNumber;
    let subjectCaller: Account;
    let subjectExchangeName: string;

    context("when rebalance notional is greater than max trade size and greater than max borrow", async () => {
      let issueQuantity: BigNumber;

      const intializeContracts = async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        destinationTokenQuantity = ether(0.5);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      };

      const initializeSubjectVariables = () => {
        subjectCaller = owner;
        subjectExchangeName = exchangeName;
      };

      async function subject(): Promise<any> {
        flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyExtension.engage(subjectExchangeName);
      }

      describe("when the collateral balance is not zero", () => {
        cacheBeforeEach(intializeContracts);
        beforeEach(initializeSubjectVariables);

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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
          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const exchangeRate = await cEther.exchangeRateStored();
          const cEtherBalance = await cEther.balanceOf(setToken.address);
          const totalRebalanceNotional = preciseMul(exchangeRate, cEtherBalance);

          const chunkRebalanceNotional = preciseMul(issueQuantity, exchangeSettings.twapMaxTradeSize);
          await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "Engaged").withArgs(
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

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("when collateral balance is zero", async () => {
        beforeEach(async () => {
          // Set collateral asset to cUSDC with 0 balance
          customCTokenCollateralAddress = cUSDC.address;
          await intializeContracts();
          initializeSubjectVariables();
        });

        afterEach(async () => {
          customCTokenCollateralAddress = undefined;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral balance must be > 0");
        });
      });
    });

    context("when rebalance notional is less than max trade size and greater than max borrow", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: ether(1.9),
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);



        // Traded amount is equal to account liquidity * buffer percentage
        destinationTokenQuantity = ether(0.7425);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyExtension.engage(subjectExchangeName);
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Traded amount is equal to account liquidity * buffer percentage
        destinationTokenQuantity = ether(0.25);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyExtension.engage(subjectExchangeName);
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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
    let subjectExchangeName: string;
    let ifEngaged: boolean;

    before(async () => {
      ifEngaged = true;
      subjectExchangeName = exchangeName;
    });

    const intializeContracts = async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      if (ifEngaged) {
        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);
      }
    };

    cacheBeforeEach(intializeContracts);

    context("when current leverage ratio is below target (lever)", async () => {
      cacheBeforeEach(async () => {
        destinationTokenQuantity = ether(0.1);
        await increaseTimeAsync(BigNumber.from(100000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1010).mul(10 ** 8));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).rebalance(subjectExchangeName);
      }

      it("should set the global last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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
        const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
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

        await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "Rebalanced").withArgs(
          currentLeverageRatio,
          expectedNewLeverageRatio,
          totalRebalanceNotional,
          totalRebalanceNotional,
        );
      });

      describe("when rebalance interval has not elapsed but is below min leverage ratio and lower than max trade size", async () => {
        cacheBeforeEach(async () => {
          await subject();
          // ~1.6x leverage
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1300).mul(10 ** 8));
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(1.9),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
          destinationTokenQuantity = ether(1);
          await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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
        cacheBeforeEach(async () => {
          await subject();

          // > Max trade size
          destinationTokenQuantity = ether(0.5);
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.01),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1500).mul(10 ** 8));
          await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const previousTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.01),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
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

          subjectTarget = flexibleLeverageStrategyExtension.address;
          subjectCallData = flexibleLeverageStrategyExtension.interface.encodeFunctionData("rebalance", [ subjectExchangeName ]);
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
      cacheBeforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));
        // Set to $990 so need to delever
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).rebalance(subjectExchangeName);
      }

      it("should set the last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();

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
        cacheBeforeEach(async () => {
          await flexibleLeverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
          // ~2.4x leverage
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(1.9),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(100000000));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should not set the TWAP leverage ratio", async () => {
          await subject();

          const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

          expect(twapLeverageRatio).to.eq(ZERO);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();

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

        cacheBeforeEach(async () => {
          await flexibleLeverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

          // > Max trade size
          newTWAPMaxTradeSize = ether(0.01);
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: newTWAPMaxTradeSize,
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
          // ~2.4x leverage
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(10000000));
        });

        it("should set the last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the TWAP leverage ratio", async () => {
          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const previousTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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

      context("when using two exchanges", async () => {
        let subjectExchangeToUse: string;

        cacheBeforeEach(async () => {
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(2),
            incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };

          await flexibleLeverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);
          await flexibleLeverageStrategyExtension.addEnabledExchange(exchangeName2, newExchangeSettings);

          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, usdc(100));
          await setV2Setup.usdc.transfer(tradeAdapterMock2.address, usdc(100));
        });

        beforeEach(() => {
          subjectCaller = owner;
          subjectExchangeToUse = exchangeName;
        });

        async function subject(): Promise<any> {
          return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).rebalance(subjectExchangeToUse);
        }

        describe("when leverage ratio is above max and it drops further between rebalances", async () => {
          it("should set the global and exchange timestamps correctly", async () => {
            await subject();
            const timestamp1 = await getLastBlockTimestamp();

            subjectExchangeToUse = exchangeName2;
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));

            await subject();
            const timestamp2 = await getLastBlockTimestamp();

            expect(await flexibleLeverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
            expect((await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName)).exchangeLastTradeTimestamp).to.eq(timestamp1);
            expect((await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName2)).exchangeLastTradeTimestamp).to.eq(timestamp2);
          });
        });

        describe("when performing the epoch rebalance and rebalance is called twice with different exchanges", async () => {

          beforeEach(async () => {
            await increaseTimeAsync(BigNumber.from(100000));
            await subject();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
          });
        });

        describe("when leverage ratio is above max and rebalance is called twice with different exchanges", async () => {

          beforeEach(async () => {
            await subject();
            subjectExchangeToUse = exchangeName2;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Cooldown not elapsed or not valid leverage ratio");
          });
        });
      });

      describe("when above incentivized leverage ratio threshold", async () => {
        beforeEach(async () => {
          await subject();

          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be below incentivized leverage ratio");
        });
      });

      describe("when using an exchange that has not been added", async () => {
        beforeEach(async () => {
          subjectExchangeName = "NonExistentExchange";
        });

        it("should revert", async () => {
          await expect(subject()).to.revertedWith("Must be valid exchange");
        });
      });
    });

    context("when not engaged", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.rebalance(subjectExchangeName);
      }

      describe("when collateral balance is zero", async () => {
        beforeEach(async () => {
          subjectExchangeName = exchangeName;
          // Set collateral asset to cUSDC with 0 balance
          customCTokenCollateralAddress = cUSDC.address;
          ifEngaged = false;
          await intializeContracts();
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
    let subjectExchangeName: string;
    let ifEngaged: boolean;
    let issueQuantity: BigNumber;

    before(async () => {
      ifEngaged = true;
      subjectExchangeName = exchangeName;
    });

    const intializeContracts = async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      if (ifEngaged) {
        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);
      }
    };

    cacheBeforeEach(intializeContracts);

    context("when currently in the last chunk of a TWAP rebalance", async () => {
      cacheBeforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

        destinationTokenQuantity = ether(0.01);
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: destinationTokenQuantity,
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        await flexibleLeverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);

        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeName);
      }

      it("should set the global last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should remove the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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

      cacheBeforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

        destinationTokenQuantity = ether(0.0001);
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: destinationTokenQuantity,
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        preTwapLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();

        // Initialize TWAP
        await flexibleLeverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeName);
      }

      it("should set the global last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio", async () => {
        const previousTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

        await subject();

        const currentTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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
        const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
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

        await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "RebalanceIterated").withArgs(
          currentLeverageRatio,
          expectedNewLeverageRatio,
          chunkRebalanceNotional,
          totalRebalanceNotional,
        );
      });

      describe("when price has moved advantageously towards target leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should remove the TWAP leverage ratio", async () => {
          const previousTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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

          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
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

          subjectTarget = flexibleLeverageStrategyExtension.address;
          subjectCallData = flexibleLeverageStrategyExtension.interface.encodeFunctionData("iterateRebalance", [ subjectExchangeName ]);
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

      describe("when using an exchange that has not been added", async () => {
        beforeEach(async () => {
          subjectExchangeName = "NonExistentExchange";
        });

        it("should revert", async () => {
          await expect(subject()).to.revertedWith("Must be valid exchange");
        });
      });
    });

    context("when current leverage ratio is below target and middle of a TWAP rebalance", async () => {
      let preTwapLeverageRatio: BigNumber;

      cacheBeforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));

        destinationTokenQuantity = ether(0.0001);
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: destinationTokenQuantity,
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        subjectExchangeName = exchangeName;
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        preTwapLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();

        await flexibleLeverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(2500000));
      });

      beforeEach(() => {
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeName);
      }

      describe("when price has moved advantageously towards target leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should remove the TWAP leverage ratio", async () => {
          const previousTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

          await subject();

          const currentTwapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

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

    context("when using two exchanges", async () => {
      let subjectExchangeToUse: string;

      cacheBeforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(100000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1200).mul(10 ** 8));

        destinationTokenQuantity = ether(0.0001);
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: destinationTokenQuantity,
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
        await flexibleLeverageStrategyExtension.addEnabledExchange(exchangeName2, newExchangeSettings);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

        // Initialize TWAP
        await flexibleLeverageStrategyExtension.connect(owner.wallet).rebalance(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
        await setV2Setup.weth.transfer(tradeAdapterMock2.address, destinationTokenQuantity);
      });

      beforeEach(() => {
        subjectCaller = owner;
        subjectExchangeToUse = exchangeName;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).iterateRebalance(subjectExchangeToUse);
      }

      describe("when in a twap rebalance and under target leverage ratio", async () => {
        it("should set the global and exchange timestamps correctly", async () => {
          await subject();
          const timestamp1 = await getLastBlockTimestamp();

          subjectExchangeToUse = exchangeName2;
          await subject();
          const timestamp2 = await getLastBlockTimestamp();

          expect(await flexibleLeverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
          expect((await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName)).exchangeLastTradeTimestamp).to.eq(timestamp1);
          expect((await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName2)).exchangeLastTradeTimestamp).to.eq(timestamp2);
        });
      });
    });

    context("when not in TWAP state", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);
      }

      describe("when collateral balance is zero", async () => {
        beforeEach(async () => {
          await increaseTimeAsync(BigNumber.from(100000));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Not in TWAP state");
        });
      });
    });

    context("when not engaged", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);
      }

      describe("when collateral balance is zero", async () => {
        beforeEach(async () => {
          // Set collateral asset to cUSDC with 0 balance
          customCTokenCollateralAddress = cUSDC.address;
          ifEngaged = false;
          await intializeContracts();
          subjectCaller = owner;
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
    let subjectExchangeName: string;
    let ifEngaged: boolean;

    before(async () => {
      ifEngaged = true;
      subjectExchangeName = exchangeName;
    });

    const intializeContracts = async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      if (ifEngaged) {
        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(100000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);
      }
    };

    const initializeSubjectVariables = () => {
      subjectCaller = owner;
    };

    cacheBeforeEach(intializeContracts);
    beforeEach(initializeSubjectVariables);

    // increaseTime
    context("when not in a TWAP rebalance", async () => {
      cacheBeforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));

        // Set to above incentivized ratio
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(450000000));

        transferredEth = ether(1);
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyExtension.address, value: transferredEth});
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).ripcord(subjectExchangeName);
      }

      it("should set the global last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should not set the TWAP leverage ratio", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();

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
        const previousContractEthBalance = await getEthBalance(flexibleLeverageStrategyExtension.address);
        const previousOwnerEthBalance = await getEthBalance(owner.address);

        const txHash = await subject();
        const txReceipt = await provider.getTransactionReceipt(txHash.hash);
        const currentContractEthBalance = await getEthBalance(flexibleLeverageStrategyExtension.address);
        const currentOwnerEthBalance = await getEthBalance(owner.address);
        const expectedOwnerEthBalance = previousOwnerEthBalance.add(incentive.etherReward).sub(txReceipt.gasUsed.mul(txHash.gasPrice));

        expect(previousContractEthBalance).to.eq(transferredEth);
        expect(currentContractEthBalance).to.eq(transferredEth.sub(incentive.etherReward));
        expect(expectedOwnerEthBalance).to.eq(currentOwnerEthBalance);
      });

      it("should emit RipcordCalled event", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
        const exchangeRate = await cEther.exchangeRateStored();
        const cEtherBalance = await cEther.balanceOf(setToken.address);
        const collateralBalance = preciseMul(exchangeRate, cEtherBalance);
        const chunkRebalanceNotional = preciseMul(
          preciseDiv(currentLeverageRatio.sub(methodology.maxLeverageRatio), currentLeverageRatio),
          collateralBalance
        );

        await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "RipcordCalled").withArgs(
          currentLeverageRatio,
          methodology.maxLeverageRatio,
          chunkRebalanceNotional,
          incentive.etherReward,
        );
      });

      describe("when greater than incentivized max trade size", async () => {
        let newIncentivizedMaxTradeSize: BigNumber;

        cacheBeforeEach(async () => {

          newIncentivizedMaxTradeSize = ether(0.01);
          const newExchangeSettings: ExchangeSettings = {
            twapMaxTradeSize: ether(0.001),
            incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
            exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
            leverExchangeData: EMPTY_BYTES,
            deleverExchangeData: EMPTY_BYTES,
          };
          await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

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
            await chainlinkCollateralPriceMock.setPrice(BigNumber.from(400).mul(10 ** 8));
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
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(750).mul(10 ** 8));
        });

        it("should set the global last trade timestamp", async () => {
          await subject();

          const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

          expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should set the exchange's last trade timestamp", async () => {
          await subject();

          const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName);
          const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

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
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(2000).mul(10 ** 8));
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

          subjectTarget = flexibleLeverageStrategyExtension.address;
          subjectCallData = flexibleLeverageStrategyExtension.interface.encodeFunctionData("ripcord", [ subjectExchangeName ]);
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

      describe("when using an exchange that has not been added", async () => {
        beforeEach(async () => {
          subjectExchangeName = "NonExistentExchange";
        });

        it("should revert", async () => {
          await expect(subject()).to.revertedWith("Must be valid exchange");
        });
      });
    });

    context("when in the midst of a TWAP rebalance", async () => {
      let newIncentivizedMaxTradeSize: BigNumber;

      cacheBeforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));
        transferredEth = ether(1);
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyExtension.address, value: transferredEth});

        // > Max trade size
        newIncentivizedMaxTradeSize = ether(0.001);
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: ether(0.001),
          incentivizedTwapMaxTradeSize: newIncentivizedMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        subjectExchangeName = exchangeName;
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);

        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));

        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

        // Start TWAP rebalance
        await flexibleLeverageStrategyExtension.rebalance(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(100));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));

        // Set to above incentivized ratio
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).ripcord(subjectExchangeName);
      }

      it("should set the global last trade timestamp", async () => {
        await subject();

        const lastTradeTimestamp = await flexibleLeverageStrategyExtension.globalLastTradeTimestamp();

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the exchange's last trade timestamp", async () => {
        await subject();

        const exchangeSettings = await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName);
        const lastTradeTimestamp = exchangeSettings.exchangeLastTradeTimestamp;

        expect(lastTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should set the TWAP leverage ratio to 0", async () => {
        await subject();

        const twapLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();

        expect(twapLeverageRatio).to.eq(ZERO);
      });
    });

    context("when using two exchanges", async () => {
      let subjectExchangeToUse: string;

      cacheBeforeEach(async () => {

        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(100000));

        // Set to above incentivized ratio
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(300000000));
        await setV2Setup.usdc.transfer(tradeAdapterMock2.address, BigNumber.from(300000000));

        await flexibleLeverageStrategyExtension.updateEnabledExchange(exchangeName, exchangeSettings);
        await flexibleLeverageStrategyExtension.addEnabledExchange(exchangeName2, exchangeSettings);
        await increaseTimeAsync(BigNumber.from(100000));
      });

      beforeEach(() => {
        subjectCaller = owner;
        subjectExchangeToUse = exchangeName;
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.connect(subjectCaller.wallet).ripcord(subjectExchangeToUse);
      }

      describe("when leverage ratio is above max and it drops further between ripcords", async () => {
        it("should set the global and exchange timestamps correctly", async () => {
          await subject();
          const timestamp1 = await getLastBlockTimestamp();

          subjectExchangeToUse = exchangeName2;
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(600).mul(10 ** 8));

          await subject();
          const timestamp2 = await getLastBlockTimestamp();

          expect(await flexibleLeverageStrategyExtension.globalLastTradeTimestamp()).to.eq(timestamp2);
          expect((await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName)).exchangeLastTradeTimestamp).to.eq(timestamp1);
          expect((await flexibleLeverageStrategyExtension.getExchangeSettings(exchangeName2)).exchangeLastTradeTimestamp).to.eq(timestamp2);
        });
      });
    });

    context("when not engaged", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyExtension.ripcord(subjectExchangeName);
      }

      describe("when collateral balance is zero", async () => {
        beforeEach(async () => {
          // Set collateral asset to cUSDC with 0 balance
          customCTokenCollateralAddress = cUSDC.address;
          ifEngaged = false;

          await intializeContracts();
          initializeSubjectVariables();
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
    let subjectExchangeName: string;
    let ifEngaged: boolean;

    context("when notional is greater than max trade size and total rebalance notional is greater than max borrow", async () => {
      before(async () => {
        ifEngaged = true;
        subjectExchangeName = exchangeName;
      });

      const intializeContracts = async() => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        if (ifEngaged) {
          // Add allowed trader
          await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);
          // Engage to initial leverage
          await flexibleLeverageStrategyExtension.engage(subjectExchangeName);
          await increaseTimeAsync(BigNumber.from(100000));
          await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
          await flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);

          // Withdraw balance of USDC from exchange contract from engage
          await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(550000000));
        }
      };

      const initializeSubjectVariables = () => {
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyExtension.disengage(subjectExchangeName);
      }

      describe("when engaged", () => {
        cacheBeforeEach(intializeContracts);
        beforeEach(initializeSubjectVariables);

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Max TWAP collateral units
          const exchangeRate = await cEther.exchangeRateStored();
          const newUnits = preciseDiv(exchangeSettings.twapMaxTradeSize, exchangeRate);
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

        describe("when the caller is not the operator", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("when not engaged", () => {
        describe("when collateral balance is zero", async () => {
          beforeEach(async () => {
            // Set collateral asset to cUSDC with 0 balance
            customCTokenCollateralAddress = cUSDC.address;
            ifEngaged = false;

            await intializeContracts();
            initializeSubjectVariables();
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

    context("when notional is less than max trade size and total rebalance notional is greater than max borrow", async () => {
      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);
        await flexibleLeverageStrategyExtension.engage(subjectExchangeName);
        await increaseTimeAsync(BigNumber.from(4000));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyExtension.iterateRebalance(subjectExchangeName);

        // Clear balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(700000000));

        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: ether(1.9),
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, newExchangeSettings);

        // Set price to reduce borrowing power
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1000).mul(10 ** 8));

        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyExtension.disengage(subjectExchangeName);
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

      cacheBeforeEach(async () => {
        await initializeRootScopeContracts();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.25));

        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(subjectExchangeName);

        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        const usdcBorrowBalance = await cUSDC.borrowBalanceStored(setToken.address);
        // Transfer more than the borrow balance to the exchange
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, usdcBorrowBalance.add(1000000000));
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyExtension.disengage(subjectExchangeName);
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();

        const previousCTokenBalance = await cEther.balanceOf(setToken.address);

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens redeemed
        const expectedCollateralAssetsRedeemed = calculateMaxRedeemForDeleverToZero(
          currentLeverageRatio,
          ether(1), // 1x leverage
          previousCTokenBalance,
          ether(1), // Total supply
          execution.slippageTolerance
        );

        const expectedFirstPositionUnit = initialPositions[0].unit.sub(expectedCollateralAssetsRedeemed);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should wipe out the debt on Compound", async () => {
        await subject();

        const borrowDebt = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

        expect(borrowDebt).to.eq(ZERO);
      });

      it("should remove any external positions on the borrow asset", async () => {
        await subject();

        const borrowAssetExternalModules = await setToken.getExternalPositionModules(setV2Setup.usdc.address);
        const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
          setV2Setup.usdc.address,
          compoundLeverageModule.address
        );
        const isPositionModule = await setToken.isExternalPositionModule(
          setV2Setup.usdc.address,
          compoundLeverageModule.address
        );

        expect(borrowAssetExternalModules.length).to.eq(0);
        expect(borrowExternalUnit).to.eq(ZERO);
        expect(isPositionModule).to.eq(false);
      });

      it("should update the borrow asset equity on the SetToken correctly", async () => {
        await subject();

        // The DAI position is positive and represents equity
        const newSecondPosition = (await setToken.getPositions())[1];
        expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(BigNumber.from(newSecondPosition.unit)).to.gt(ZERO);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });
    });
  });

  describe("#setMethodologySettings", async () => {
    let subjectMethodologySettings: MethodologySettings;
    let subjectCaller: Account;

    const initializeSubjectVariables = () => {
      subjectMethodologySettings = {
        targetLeverageRatio: ether(2.1),
        minLeverageRatio: ether(1.1),
        maxLeverageRatio: ether(2.5),
        recenteringSpeed: ether(0.1),
        rebalanceInterval: BigNumber.from(43200),
      };
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.setMethodologySettings(subjectMethodologySettings);
    }

    describe("when rebalance is not in progress", () => {
      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      it("should set the correct methodology parameters", async () => {
        await subject();
        const methodology = await flexibleLeverageStrategyExtension.getMethodology();

        expect(methodology.targetLeverageRatio).to.eq(subjectMethodologySettings.targetLeverageRatio);
        expect(methodology.minLeverageRatio).to.eq(subjectMethodologySettings.minLeverageRatio);
        expect(methodology.maxLeverageRatio).to.eq(subjectMethodologySettings.maxLeverageRatio);
        expect(methodology.recenteringSpeed).to.eq(subjectMethodologySettings.recenteringSpeed);
        expect(methodology.rebalanceInterval).to.eq(subjectMethodologySettings.rebalanceInterval);
      });

      it("should emit MethodologySettingsUpdated event", async () => {
        await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "MethodologySettingsUpdated").withArgs(
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

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        await initializeRootScopeContracts();
        initializeSubjectVariables();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(exchangeName);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setExecutionSettings", async () => {
    let subjectExecutionSettings: ExecutionSettings;
    let subjectCaller: Account;

    const initializeSubjectVariables = () => {
      subjectExecutionSettings = {
        unutilizedLeveragePercentage: ether(0.05),
        twapCooldownPeriod: BigNumber.from(360),
        slippageTolerance: ether(0.02),
      };
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.setExecutionSettings(subjectExecutionSettings);
    }

    describe("when rebalance is not in progress", () => {
      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);
      it("should set the correct execution parameters", async () => {
        await subject();
        const execution = await flexibleLeverageStrategyExtension.getExecution();

        expect(execution.unutilizedLeveragePercentage).to.eq(subjectExecutionSettings.unutilizedLeveragePercentage);
        expect(execution.twapCooldownPeriod).to.eq(subjectExecutionSettings.twapCooldownPeriod);
        expect(execution.slippageTolerance).to.eq(subjectExecutionSettings.slippageTolerance);
      });

      it("should emit ExecutionSettingsUpdated event", async () => {
        await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "ExecutionSettingsUpdated").withArgs(
          subjectExecutionSettings.unutilizedLeveragePercentage,
          subjectExecutionSettings.twapCooldownPeriod,
          subjectExecutionSettings.slippageTolerance
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
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        await initializeRootScopeContracts();
        initializeSubjectVariables();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(exchangeName);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#setIncentiveSettings", async () => {
    let subjectIncentiveSettings: IncentiveSettings;
    let subjectCaller: Account;

    const initializeSubjectVariables = () => {
      subjectIncentiveSettings = {
        incentivizedTwapCooldownPeriod: BigNumber.from(30),
        incentivizedSlippageTolerance: ether(0.1),
        etherReward: ether(5),
        incentivizedLeverageRatio: ether(3.2),
      };
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.setIncentiveSettings(subjectIncentiveSettings);
    }

    describe("when rebalance is not in progress", () => {
      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      it("should set the correct incentive parameters", async () => {
        await subject();
        const incentive = await flexibleLeverageStrategyExtension.getIncentive();

        expect(incentive.incentivizedTwapCooldownPeriod).to.eq(subjectIncentiveSettings.incentivizedTwapCooldownPeriod);
        expect(incentive.incentivizedSlippageTolerance).to.eq(subjectIncentiveSettings.incentivizedSlippageTolerance);
        expect(incentive.etherReward).to.eq(subjectIncentiveSettings.etherReward);
        expect(incentive.incentivizedLeverageRatio).to.eq(subjectIncentiveSettings.incentivizedLeverageRatio);
      });

      it("should emit IncentiveSettingsUpdated event", async () => {
        await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "IncentiveSettingsUpdated").withArgs(
          subjectIncentiveSettings.etherReward,
          subjectIncentiveSettings.incentivizedLeverageRatio,
          subjectIncentiveSettings.incentivizedSlippageTolerance,
          subjectIncentiveSettings.incentivizedTwapCooldownPeriod
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

      describe("when incentivized TWAP cooldown period is greater than TWAP cooldown period", async () => {
        beforeEach(async () => {
          subjectIncentiveSettings.incentivizedTwapCooldownPeriod = ether(1);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("TWAP cooldown must be greater than incentivized TWAP cooldown");
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

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        await initializeRootScopeContracts();
        initializeSubjectVariables();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(exchangeName);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#addEnabledExchange", async () => {
    let subjectExchangeName: string;
    let subjectExchangeSettings: ExchangeSettings;
    let subjectCaller: Account;

    const initializeSubjectVariables = () => {
      subjectExchangeName = "NewExchange";
      subjectExchangeSettings = {
        twapMaxTradeSize: ether(100),
        incentivizedTwapMaxTradeSize: ether(200),
        exchangeLastTradeTimestamp: BigNumber.from(0),
        leverExchangeData: EMPTY_BYTES,
        deleverExchangeData: EMPTY_BYTES,
      };
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.addEnabledExchange(subjectExchangeName, subjectExchangeSettings);
    }

    cacheBeforeEach(initializeRootScopeContracts);
    beforeEach(initializeSubjectVariables);

    it("should set the correct exchange parameters", async () => {
      await subject();
      const exchange = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);

      expect(exchange.twapMaxTradeSize).to.eq(subjectExchangeSettings.twapMaxTradeSize);
      expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectExchangeSettings.incentivizedTwapMaxTradeSize);
      expect(exchange.exchangeLastTradeTimestamp).to.eq(0);
      expect(exchange.leverExchangeData).to.eq(subjectExchangeSettings.leverExchangeData);
      expect(exchange.deleverExchangeData).to.eq(subjectExchangeSettings.deleverExchangeData);
    });

    it("should add exchange to enabledExchanges", async () => {
      await subject();
      const finalExchanges = await flexibleLeverageStrategyExtension.getEnabledExchanges();

      expect(finalExchanges.length).to.eq(2);
      expect(finalExchanges[1]).to.eq(subjectExchangeName);
    });

    it("should emit an ExchangeAdded event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "ExchangeAdded").withArgs(
        subjectExchangeName,
        subjectExchangeSettings.twapMaxTradeSize,
        subjectExchangeSettings.exchangeLastTradeTimestamp,
        subjectExchangeSettings.incentivizedTwapMaxTradeSize,
        subjectExchangeSettings.leverExchangeData,
        subjectExchangeSettings.deleverExchangeData
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

    describe("when exchange has already been added", async () => {
      beforeEach(() => {
        subjectExchangeName = exchangeName;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Exchange already enabled");
      });
    });

    describe("when an exchange has a twapMaxTradeSize of 0", async () => {
      beforeEach(async () => {
        subjectExchangeSettings.twapMaxTradeSize = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
      });
    });
  });

  describe("#updateEnabledExchange", async () => {
    let subjectExchangeName: string;
    let subjectNewExchangeSettings: ExchangeSettings;
    let subjectCaller: Account;

    const initializeSubjectVariables = () => {
      subjectExchangeName = exchangeName;
      subjectNewExchangeSettings = {
        twapMaxTradeSize: ether(101),
        incentivizedTwapMaxTradeSize: ether(201),
        exchangeLastTradeTimestamp: BigNumber.from(0),
        leverExchangeData: EMPTY_BYTES,
        deleverExchangeData: EMPTY_BYTES,
      };
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.updateEnabledExchange(subjectExchangeName, subjectNewExchangeSettings);
    }

    cacheBeforeEach(initializeRootScopeContracts);
    beforeEach(initializeSubjectVariables);

    it("should set the correct exchange parameters", async () => {
      await subject();
      const exchange = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);

      expect(exchange.twapMaxTradeSize).to.eq(subjectNewExchangeSettings.twapMaxTradeSize);
      expect(exchange.incentivizedTwapMaxTradeSize).to.eq(subjectNewExchangeSettings.incentivizedTwapMaxTradeSize);
      expect(exchange.exchangeLastTradeTimestamp).to.eq(subjectNewExchangeSettings.exchangeLastTradeTimestamp);
      expect(exchange.leverExchangeData).to.eq(subjectNewExchangeSettings.leverExchangeData);
      expect(exchange.deleverExchangeData).to.eq(subjectNewExchangeSettings.deleverExchangeData);
    });

    it("should not add duplicate entry to enabledExchanges", async () => {
      await subject();
      const finalExchanges = await flexibleLeverageStrategyExtension.getEnabledExchanges();

      expect(finalExchanges.length).to.eq(1);
      expect(finalExchanges[0]).to.eq(subjectExchangeName);
    });

    it("should emit an ExchangeUpdated event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "ExchangeUpdated").withArgs(
        subjectExchangeName,
        subjectNewExchangeSettings.twapMaxTradeSize,
        subjectNewExchangeSettings.exchangeLastTradeTimestamp,
        subjectNewExchangeSettings.incentivizedTwapMaxTradeSize,
        subjectNewExchangeSettings.leverExchangeData,
        subjectNewExchangeSettings.deleverExchangeData
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

    describe("when exchange has not already been added", async () => {
      beforeEach(() => {
        subjectExchangeName = "NewExchange";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Exchange not enabled");
      });
    });

    describe("when an exchange has a twapMaxTradeSize of 0", async () => {
      beforeEach(async () => {
        subjectNewExchangeSettings.twapMaxTradeSize = ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max TWAP trade size must not be 0");
      });
    });
  });

  describe("#removeEnabledExchange", async () => {
    let subjectExchangeName: string;
    let subjectCaller: Account;

    const initializeSubjectVariables = () => {
      subjectExchangeName = exchangeName;
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.removeEnabledExchange(subjectExchangeName);
    }

    cacheBeforeEach(initializeRootScopeContracts);
    beforeEach(initializeSubjectVariables);

    it("should set the exchange parameters to their default values", async () => {
      await subject();
      const exchange = await flexibleLeverageStrategyExtension.getExchangeSettings(subjectExchangeName);

      expect(exchange.twapMaxTradeSize).to.eq(0);
      expect(exchange.incentivizedTwapMaxTradeSize).to.eq(0);
      expect(exchange.exchangeLastTradeTimestamp).to.eq(0);
      expect(exchange.leverExchangeData).to.eq(EMPTY_BYTES);
      expect(exchange.deleverExchangeData).to.eq(EMPTY_BYTES);
    });

    it("should remove entry from enabledExchanges list", async () => {
      await subject();
      const finalExchanges = await flexibleLeverageStrategyExtension.getEnabledExchanges();

      expect(finalExchanges.length).to.eq(0);
    });

    it("should emit an ExchangeRemoved event", async () => {
      await expect(subject()).to.emit(flexibleLeverageStrategyExtension, "ExchangeRemoved").withArgs(
        subjectExchangeName,
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

    describe("when exchange has not already been added", async () => {
      beforeEach(() => {
        subjectExchangeName = "NewExchange";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Exchange not enabled");
      });
    });
  });

  describe("#withdrawEtherBalance", async () => {
    let etherReward: BigNumber;
    let subjectCaller: Account;

    const initializeSubjectVariables = async () => {
      etherReward = ether(0.1);
      // Send ETH to contract as reward
      await owner.wallet.sendTransaction({to: flexibleLeverageStrategyExtension.address, value: etherReward});
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      flexibleLeverageStrategyExtension = flexibleLeverageStrategyExtension.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyExtension.withdrawEtherBalance();
    }

    describe("when rebalance is not in progress", () => {
      cacheBeforeEach(initializeRootScopeContracts);
      beforeEach(initializeSubjectVariables);

      it("should withdraw ETH balance on contract to operator", async () => {
        const previousContractEthBalance = await getEthBalance(flexibleLeverageStrategyExtension.address);
        const previousOwnerEthBalance = await getEthBalance(owner.address);

        const txHash = await subject();
        const txReceipt = await provider.getTransactionReceipt(txHash.hash);
        const currentContractEthBalance = await getEthBalance(flexibleLeverageStrategyExtension.address);
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
    });

    describe("when rebalance is in progress", async () => {
      beforeEach(async () => {
        await initializeRootScopeContracts();
        initializeSubjectVariables();

        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyExtension.engage(exchangeName);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Rebalance is currently in progress");
      });
    });
  });

  describe("#getCurrentEtherIncentive", async () => {
    cacheBeforeEach(async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyExtension.engage(exchangeName);
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyExtension.iterateRebalance(exchangeName);
    });

    async function subject(): Promise<any> {
      return flexibleLeverageStrategyExtension.getCurrentEtherIncentive();
    }

    describe("when above incentivized leverage ratio", async () => {
      beforeEach(async () => {
        await owner.wallet.sendTransaction({to: flexibleLeverageStrategyExtension.address, value: ether(1)});
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(650).mul(10 ** 8));
      });

      it("should return the correct value", async () => {
        const etherIncentive = await subject();

        expect(etherIncentive).to.eq(incentive.etherReward);
      });

      describe("when ETH balance is below ETH reward amount", async () => {
        beforeEach(async () => {
          await flexibleLeverageStrategyExtension.withdrawEtherBalance();
          // Transfer 0.01 ETH to contract
          await owner.wallet.sendTransaction({to: flexibleLeverageStrategyExtension.address, value: ether(0.01)});
        });

        it("should return the correct value", async () => {
          const etherIncentive = await subject();

          expect(etherIncentive).to.eq(ether(0.01));
        });
      });
    });

    describe("when below incentivized leverage ratio", async () => {
      beforeEach(async () => {
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(2000).mul(10 ** 8));
      });

      it("should return the correct value", async () => {
        const etherIncentive = await subject();

        expect(etherIncentive).to.eq(ZERO);
      });
    });
  });

  describe("#shouldRebalance", async () => {
    cacheBeforeEach(async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyExtension.engage(exchangeName);
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyExtension.iterateRebalance(exchangeName);
    });

    async function subject(): Promise<[string[], number[]]> {
      return flexibleLeverageStrategyExtension.shouldRebalance();
    }

    context("when in the midst of a TWAP rebalance", async () => {
      cacheBeforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        // > Max trade size
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: ether(0.001),
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);

        // Set up new rebalance TWAP
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        await increaseTimeAsync(BigNumber.from(100000));
        await flexibleLeverageStrategyExtension.rebalance(exchangeName);
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(THREE);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to below incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(4000));
        });

        it("should return iterate rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(TWO);
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });
    });

    context("when not in a TWAP rebalance", async () => {
      describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(THREE);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100000));
        });

        it("should return rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ONE);
        });
      });

      describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
        });

        it("should return rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ONE);
        });
      });

      describe("when below min leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
        });

        it("should return rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ONE);
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });
    });
  });

  describe("#shouldRebalanceWithBounds", async () => {
    let subjectMinLeverageRatio: BigNumber;
    let subjectMaxLeverageRatio: BigNumber;

    cacheBeforeEach(async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      // Engage to initial leverage
      await flexibleLeverageStrategyExtension.engage(exchangeName);
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyExtension.iterateRebalance(exchangeName);
    });

    beforeEach(() => {
      subjectMinLeverageRatio = ether(1.6);
      subjectMaxLeverageRatio = ether(2.4);
    });

    async function subject(): Promise<[string[], number[]]> {
      return flexibleLeverageStrategyExtension.shouldRebalanceWithBounds(
        subjectMinLeverageRatio,
        subjectMaxLeverageRatio
      );
    }

    context("when in the midst of a TWAP rebalance", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        // > Max trade size
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: ether(0.001),
          incentivizedTwapMaxTradeSize: exchangeSettings.incentivizedTwapMaxTradeSize,
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);

        // Set up new rebalance TWAP
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        await increaseTimeAsync(BigNumber.from(100000));
        await flexibleLeverageStrategyExtension.rebalance(exchangeName);
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(THREE);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has elapsed", async () => {
        beforeEach(async () => {
          // Set to below incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(4000));
        });

        it("should return iterate rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(TWO);
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });

      describe("when below incentivized leverage ratio and regular TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });
    });

    context("when not in a TWAP rebalance", async () => {
      describe("when above incentivized leverage ratio and cooldown period has elapsed", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100));
        });

        it("should return ripcord", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(THREE);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has elapsed", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
          await increaseTimeAsync(BigNumber.from(100000));
        });

        it("should return rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ONE);
        });
      });

      describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
        });

        it("should return rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ONE);
        });
      });

      describe("when below min leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
        });

        it("should return rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ONE);
        });
      });

      describe("when above incentivized leverage ratio and incentivized TWAP cooldown has NOT elapsed", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });

      describe("when between max and min leverage ratio and rebalance interval has NOT elapsed", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        });

        it("should not rebalance", async () => {
          const [ exchangeNamesArray, shouldRebalanceArray ] = await subject();

          expect(exchangeNamesArray[0]).to.eq(exchangeName);
          expect(shouldRebalanceArray[0]).to.eq(ZERO);
        });
      });

      describe("when custom min leverage ratio is above methodology min leverage ratio", async () => {
        beforeEach(async () => {
          subjectMinLeverageRatio = ether(1.9);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
        });
      });

      describe("when custom max leverage ratio is below methodology max leverage ratio", async () => {
        beforeEach(async () => {
          subjectMinLeverageRatio = ether(2.2);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Custom bounds must be valid");
        });
      });
    });
  });

  describe("#getChunkRebalanceNotional", async () => {
    cacheBeforeEach(async () => {
      await initializeRootScopeContracts();

      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Add allowed trader
      await flexibleLeverageStrategyExtension.updateCallerStatus([owner.address], [true]);

      // Add second exchange
      const exchangeSettings2 = exchangeSettings;
      exchangeSettings2.twapMaxTradeSize = ether(1);
      exchangeSettings2.incentivizedTwapMaxTradeSize = ether(2);
      await flexibleLeverageStrategyExtension.addEnabledExchange(exchangeName2, exchangeSettings2);

      // Engage to initial leverage
      await flexibleLeverageStrategyExtension.engage(exchangeName);
      await increaseTimeAsync(BigNumber.from(100000));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      await flexibleLeverageStrategyExtension.iterateRebalance(exchangeName);
    });

    async function subject(): Promise<[BigNumber[], Address, Address]> {
      return await flexibleLeverageStrategyExtension.getChunkRebalanceNotional([ exchangeName, exchangeName2 ]);
    }

    context("when in the midst of a TWAP rebalance", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);

        // > Max trade size
        const newExchangeSettings: ExchangeSettings = {
          twapMaxTradeSize: ether(0.001),
          incentivizedTwapMaxTradeSize: ether(0.002),
          exchangeLastTradeTimestamp: exchangeSettings.exchangeLastTradeTimestamp,
          leverExchangeData: EMPTY_BYTES,
          deleverExchangeData: EMPTY_BYTES,
        };
        await flexibleLeverageStrategyExtension.updateEnabledExchange(exchangeName, newExchangeSettings);

        // Set up new rebalance TWAP
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(4000000));
        await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        await increaseTimeAsync(BigNumber.from(100000));
        await flexibleLeverageStrategyExtension.rebalance(exchangeName);
      });

      describe("when above incentivized leverage ratio", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        it("should return correct total rebalance size and isLever boolean", async () => {
          const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

          const newLeverageRatio = methodology.maxLeverageRatio;
          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const expectedTotalRebalance = await calculateTotalRebalanceNotionalCompound(setToken, cEther, currentLeverageRatio, newLeverageRatio);

          expect(sellAsset).to.eq(strategy.collateralAsset);
          expect(buyAsset).to.eq(strategy.borrowAsset);
          expect(chunkRebalances[0]).to.eq(ether(0.002));
          expect(chunkRebalances[1]).to.eq(expectedTotalRebalance);
        });
      });

      describe("when below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          // Set to below incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(900).mul(10 ** 8));
        });

        it("should return correct total rebalance size and isLever boolean", async () => {
          const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const newLeverageRatio = await flexibleLeverageStrategyExtension.twapLeverageRatio();
          const expectedTotalRebalance = await calculateTotalRebalanceNotionalCompound(setToken, cEther, currentLeverageRatio, newLeverageRatio);

          expect(sellAsset).to.eq(strategy.collateralAsset);
          expect(buyAsset).to.eq(strategy.borrowAsset);
          expect(chunkRebalances[0]).to.eq(ether(0.001));
          expect(chunkRebalances[1]).to.eq(expectedTotalRebalance);
        });
      });
    });

    context("when not in a TWAP rebalance", async () => {

      beforeEach(async () => {
        const exchangeSettings2 = exchangeSettings;
        exchangeSettings2.twapMaxTradeSize = ether(0.001);
        exchangeSettings2.incentivizedTwapMaxTradeSize = ether(0.002);
        await flexibleLeverageStrategyExtension.updateEnabledExchange(exchangeName2, exchangeSettings2);
      });

      describe("when above incentivized leverage ratio", async () => {
        beforeEach(async () => {
          // Set to above incentivized ratio
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(800).mul(10 ** 8));
        });

        it("should return correct total rebalance size and isLever boolean", async () => {
          const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

          const newLeverageRatio = methodology.maxLeverageRatio;
          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const expectedTotalRebalance = await calculateTotalRebalanceNotionalCompound(setToken, cEther, currentLeverageRatio, newLeverageRatio);

          expect(sellAsset).to.eq(strategy.collateralAsset);
          expect(buyAsset).to.eq(strategy.borrowAsset);
          expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
          expect(chunkRebalances[1]).to.eq(ether(0.002));
        });
      });

      describe("when between max and min leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(990).mul(10 ** 8));
        });

        it("should return correct total rebalance size and isLever boolean", async () => {
          const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const newLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
          );
          const expectedTotalRebalance = await calculateTotalRebalanceNotionalCompound(setToken, cEther, currentLeverageRatio, newLeverageRatio);

          expect(sellAsset).to.eq(strategy.collateralAsset);
          expect(buyAsset).to.eq(strategy.borrowAsset);
          expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
          expect(chunkRebalances[1]).to.eq(ether(0.001));
        });
      });

      describe("when above max leverage ratio but below incentivized leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(850).mul(10 ** 8));
        });

        it("should return correct total rebalance size and isLever boolean", async () => {
          const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const newLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
          );
          const expectedTotalRebalance = await calculateTotalRebalanceNotionalCompound(setToken, cEther, currentLeverageRatio, newLeverageRatio);

          expect(sellAsset).to.eq(strategy.collateralAsset);
          expect(buyAsset).to.eq(strategy.borrowAsset);
          expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
          expect(chunkRebalances[1]).to.eq(ether(0.001));
        });
      });

      describe("when below min leverage ratio", async () => {
        beforeEach(async () => {
          await chainlinkCollateralPriceMock.setPrice(BigNumber.from(1400).mul(10 ** 8));
        });

        it("should return correct total rebalance size and isLever boolean", async () => {
          const [ chunkRebalances, sellAsset, buyAsset ] = await subject();

          const currentLeverageRatio = await flexibleLeverageStrategyExtension.getCurrentLeverageRatio();
          const newLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed
          );
          const totalCollateralRebalance = await calculateTotalRebalanceNotionalCompound(setToken, cEther, currentLeverageRatio, newLeverageRatio);
          // Multiply collateral by conversion rate (1400 USDC per ETH) and adjust for decimals
          const expectedTotalRebalance = preciseMul(totalCollateralRebalance, ether(1400)).div(BigNumber.from(10).pow(12));

          expect(sellAsset).to.eq(strategy.borrowAsset);
          expect(buyAsset).to.eq(strategy.collateralAsset);
          expect(chunkRebalances[0]).to.eq(expectedTotalRebalance);
          expect(chunkRebalances[1]).to.eq(preciseMul(ether(0.001), ether(1400)).div(BigNumber.from(10).pow(12)));
        });
      });
    });
  });
});
