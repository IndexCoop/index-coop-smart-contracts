import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, ICManagerV2, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundLeverageModule, ContractCallerMock, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
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

  let targetLeverageRatio: BigNumber;
  let minLeverageRatio: BigNumber;
  let maxLeverageRatio: BigNumber;
  let recenteringSpeed: BigNumber;
  let rebalanceInterval: BigNumber;
  let bufferPercentage: BigNumber;
  let maxTradeSize: BigNumber;
  let twapCooldown: BigNumber;
  let slippageTolerance: BigNumber;

  let customTargetLeverageRatio: any;
  let customCTokenCollateralAddress: any;
  let customCompoundLeverageModule: any;

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let secondCompoundLeverageModule: CompoundLeverageModule;
  let icManagerV2: ICManagerV2;

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

    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [BigNumber.from(5000000000)], // Equivalent to 1 ETH
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address, compoundLeverageModule.address, secondCompoundLeverageModule.address]
    );
    await gulpComptrollerMock.addSetTokenAddress(setToken.address);

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
      methodologist.address
    );

    // Transfer ownership to ic manager
    await setToken.setManager(icManagerV2.address);
  });

  beforeEach(async () => {
    // Deploy adapter
    targetLeverageRatio = customTargetLeverageRatio || ether(2);
    minLeverageRatio = ether(1.7);
    maxLeverageRatio = ether(2.3);
    recenteringSpeed = ether(0.05);
    rebalanceInterval = BigNumber.from(86400);

    bufferPercentage = ether(0.01);
    maxTradeSize = ether(0.5);
    twapCooldown = BigNumber.from(3600);
    slippageTolerance = ether(0.01);

    flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
      [
        setToken.address,                                                // SetToken address
        customCompoundLeverageModule || compoundLeverageModule.address,  // Compound leverage module
        icManagerV2.address,                                             // ICManager address
        compoundSetup.comptroller.address,                               // Comptroller
        compoundSetup.priceOracle.address,                               // Compound open oracle
        customCTokenCollateralAddress || cEther.address,                 // Target cToken collateral
        cUSDC.address,                                                   // Target cToken borrow
        setV2Setup.weth.address,                                         // Target underlying collateral
        setV2Setup.usdc.address,                                         // Target underlying borrow
      ],
      [
        "18",
        "6",
      ],
      [
        targetLeverageRatio.toString(),               // Target leverage ratio
        minLeverageRatio.toString(),             // Min leverage ratio
        maxLeverageRatio.toString(),             // Max leverage ratio
        recenteringSpeed.toString(),            // Recentering speed (5%)
        rebalanceInterval.toString(),   // Rebalance interval in seconds
      ],
      [
        bufferPercentage.toString(),            // Buffer percentage
        maxTradeSize.toString(),             // Max trade size in collateral base units
        twapCooldown.toString(),            // TWAP cooldown in seconds
        slippageTolerance.toString(),            // Slippage tolerance percentage
      ],
      "MockTradeAdapter",
      EMPTY_BYTES
    );

    // Add adapter
    await icManagerV2.connect(methodologist.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
    await icManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectInstances: Address[];
    let subjectAssetDecimals: string[];
    let subjectMethodologyParams: string[];
    let subjectExecutionParams: string[];
    let subjectExchangeName: string;
    let subjectExchangeData: Bytes;

    beforeEach(async () => {
      subjectInstances = [
        setToken.address,                  // SetToken address
        compoundLeverageModule.address,    // Compound leverage module
        icManagerV2.address,               // ICManager address
        compoundSetup.comptroller.address, // Comptroller
        compoundSetup.priceOracle.address, // Compound open oracle
        cEther.address,                    // Target cToken collateral
        cUSDC.address,                     // Target cToken borrow
        setV2Setup.weth.address,           // Target underlying collateral
        setV2Setup.usdc.address,             // Target underlying collateral
      ];

      subjectAssetDecimals = [
        "18",
        "6",
      ];

      subjectMethodologyParams = [
        ether(2).toString(),               // Target leverage ratio
        ether(1.7).toString(),             // Min leverage ratio
        ether(2.3).toString(),             // Max leverage ratio
        ether(0.05).toString(),            // Recentering speed (5%)
        BigNumber.from(86400).toString(),   // Rebalance interval in seconds
      ];

      subjectExecutionParams = [
        ether(0.01).toString(),            // Buffer percentage
        ether(1).toString(),               // Max trade size in collateral base units
        ether(60).toString(),              // TWAP cooldown in seconds
        ether(0.01).toString(),            // Slippage tolerance percentage
      ];

      subjectExchangeName = "MockTradeAdapter";
      subjectExchangeData = EMPTY_BYTES;
    });

    async function subject(): Promise<FlexibleLeverageStrategyAdapter> {
      return await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
        subjectInstances,
        subjectAssetDecimals,
        subjectMethodologyParams,
        subjectExecutionParams,
        subjectExchangeName,
        subjectExchangeData
      );
    }

    it("should set the contract addresses", async () => {
      const retrievedAdapter = await subject();

      const setToken = await retrievedAdapter.setToken();
      const compoundLeverageModule = await retrievedAdapter.compoundLeverageModule();
      const manager = await retrievedAdapter.manager();
      const comptroller = await retrievedAdapter.comptroller();
      const compoundPriceOracle = await retrievedAdapter.compoundPriceOracle();
      const targetCollateralCToken = await retrievedAdapter.targetCollateralCToken();
      const targetBorrowCToken = await retrievedAdapter.targetBorrowCToken();
      const collateralAsset = await retrievedAdapter.collateralAsset();
      const borrowAsset = await retrievedAdapter.borrowAsset();

      expect(setToken).to.eq(subjectInstances[0]);
      expect(compoundLeverageModule).to.eq(subjectInstances[1]);
      expect(manager).to.eq(subjectInstances[2]);
      expect(comptroller).to.eq(subjectInstances[3]);
      expect(compoundPriceOracle).to.eq(subjectInstances[4]);
      expect(targetCollateralCToken).to.eq(subjectInstances[5]);
      expect(targetBorrowCToken).to.eq(subjectInstances[6]);
      expect(collateralAsset).to.eq(subjectInstances[7]);
      expect(borrowAsset).to.eq(subjectInstances[8]);
    });

    it("should set the correct asset decimals", async () => {
      const retrievedAdapter = await subject();

      const collateralAssetDecimals = await retrievedAdapter.collateralAssetDecimals();
      const borrowAssetDecimals = await retrievedAdapter.borrowAssetDecimals();

      expect(collateralAssetDecimals).to.eq(subjectAssetDecimals[0]);
      expect(borrowAssetDecimals).to.eq(subjectAssetDecimals[1]);
    });

    it("should set the correct methodology parameters", async () => {
      const retrievedAdapter = await subject();

      const targetLeverageRatio = await retrievedAdapter.targetLeverageRatio();
      const minLeverageRatio = await retrievedAdapter.minLeverageRatio();
      const maxLeverageRatio = await retrievedAdapter.maxLeverageRatio();
      const recenteringSpeed = await retrievedAdapter.recenteringSpeed();
      const rebalanceInterval = await retrievedAdapter.rebalanceInterval();

      expect(targetLeverageRatio).to.eq(subjectMethodologyParams[0]);
      expect(minLeverageRatio).to.eq(subjectMethodologyParams[1]);
      expect(maxLeverageRatio).to.eq(subjectMethodologyParams[2]);
      expect(recenteringSpeed).to.eq(subjectMethodologyParams[3]);
      expect(rebalanceInterval).to.eq(subjectMethodologyParams[4]);
    });

    it("should set the correct execution parameters", async () => {
      const retrievedAdapter = await subject();

      const bufferPercentage = await retrievedAdapter.bufferPercentage();
      const maxTradeSize = await retrievedAdapter.maxTradeSize();
      const twapCooldown = await retrievedAdapter.twapCooldown();
      const slippageTolerance = await retrievedAdapter.slippageTolerance();

      expect(bufferPercentage).to.eq(subjectExecutionParams[0]);
      expect(maxTradeSize).to.eq(subjectExecutionParams[1]);
      expect(twapCooldown).to.eq(subjectExecutionParams[2]);
      expect(slippageTolerance).to.eq(subjectExecutionParams[3]);
    });

    it("should set the correct initial exchange name", async () => {
      const retrievedAdapter = await subject();

      const exchangeName = await retrievedAdapter.exchangeName();

      expect(exchangeName).to.eq(subjectExchangeName);
    });

    it("should set the correct initial exchange data", async () => {
      const retrievedAdapter = await subject();

      const exchangeData = await retrievedAdapter.exchangeData();

      expect(exchangeData).to.eq(EMPTY_BYTES);
    });
  });

  describe("#engage", async () => {
    let destinationTokenQuantity: BigNumber;
    let subjectCaller: Account;

    context("when notional is greater than max trade size and total rebalance notional is greater than max borrow", async () => {
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

      it("should set TWAP state", async () => {
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(isTWAP).to.be.true;
        expect(twapState.twapNewLeverageRatio).to.eq(targetLeverageRatio);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
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

      it("should update to engaged", async () => {
        await subject();

        const isEngaged = await flexibleLeverageStrategyAdapter.isEngaged();
        expect(isEngaged).to.be.true;
      });

      it("should update last rebalance timestamp", async () => {
        await subject();

        const lastRebalanceTimestamp = await flexibleLeverageStrategyAdapter.lastRebalanceTimestamp();
        expect(lastRebalanceTimestamp).to.be.eq(await getLastBlockTimestamp());
      });

      describe("when the manager is already engaged", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must not be engaged");
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

      describe("when debt is non zero", async () => {
        beforeEach(async () => {
          const mockFlexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
            [
              setToken.address,                  // SetToken address
              compoundLeverageModule.address,    // Compound leverage module
              icManagerV2.address,               // ICManager address
              compoundSetup.comptroller.address, // Comptroller
              compoundSetup.priceOracle.address, // Compound open oracle
              cEther.address,                    // Target cToken collateral
              cUSDC.address,                     // Target cToken borrow
              setV2Setup.weth.address,           // Target underlying collateral
              setV2Setup.usdc.address,           // Target underlying borrow
            ],
            [
              "18",
              "6",
            ],
            [
              targetLeverageRatio.toString(),    // Target leverage ratio
              minLeverageRatio.toString(),       // Min leverage ratio
              maxLeverageRatio.toString(),       // Max leverage ratio
              recenteringSpeed.toString(),       // Recentering speed (5%)
              rebalanceInterval.toString(),      // Rebalance interval in seconds
            ],
            [
              bufferPercentage.toString(),         // Buffer percentage
              maxTradeSize.toString(),             // Max trade size in collateral base units
              twapCooldown.toString(),             // TWAP cooldown in seconds
              slippageTolerance.toString(),        // Slippage tolerance percentage
            ],
            "MockTradeAdapter",
            EMPTY_BYTES
          );

          // Add adapter
          await icManagerV2.connect(methodologist.wallet).addAdapter(mockFlexibleLeverageStrategyAdapter.address);
          await icManagerV2.connect(owner.wallet).addAdapter(mockFlexibleLeverageStrategyAdapter.address);

          await mockFlexibleLeverageStrategyAdapter.engage();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Debt must be 0");
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

    context("when notional is less than max trade size and total rebalance notional is greater than max borrow", async () => {
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

      it("should set TWAP state", async () => {
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(isTWAP).to.be.true;
        expect(twapState.twapNewLeverageRatio).to.eq(targetLeverageRatio);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
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

    context("when notional is less than max trade size and total rebalance notional is less than max borrow", async () => {
      before(async () => {
        customTargetLeverageRatio = ether(1.25); // Change to 1.25x
      });

      after(async () => {
        customTargetLeverageRatio = undefined;
      });

      beforeEach(async () => {
        customTargetLeverageRatio = ether(1.25); // Change to 1.25x

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

      it("should not set TWAP state", async () => {
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(isTWAP).to.be.false;
        expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
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

    beforeEach(async () => {
      // Approve tokens to issuance module and call issue
      await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken
      const issueQuantity = ether(1);
      await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

      // Engage to initial leverage
      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(BigNumber.from(3600));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
      await flexibleLeverageStrategyAdapter.rebalance();
    });

    context("when current leverage ratio is below target and no TWAP", async () => {
      beforeEach(async () => {
        destinationTokenQuantity = ether(0.1);
        await increaseTimeAsync(BigNumber.from(86400));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1010));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.rebalance();
      }

      it("should not set TWAP state", async () => {
        const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(previousIsTWAP).to.be.false;
        expect(currentIsTWAP).to.be.false;
        expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
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

        it("should not set TWAP state", async () => {
          const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          await subject();

          const twapState = await flexibleLeverageStrategyAdapter.twapState();
          const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          expect(previousIsTWAP).to.be.false;
          expect(currentIsTWAP).to.be.false;
          expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
          expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
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

        it("should set TWAP state", async () => {
          const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
          const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          await subject();

          const twapState = await flexibleLeverageStrategyAdapter.twapState();
          const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          expect(previousIsTWAP).to.be.false;
          expect(currentIsTWAP).to.be.true;
          expect(twapState.twapNewLeverageRatio).to.eq(expectedNewLeverageRatio);
          expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
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
          await expect(subject()).to.be.revertedWith("Rebalance interval not yet elapsed");
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

    context("when current leverage ratio is below target and is TWAP rebalance", async () => {
      beforeEach(async () => {
        await increaseTimeAsync(BigNumber.from(86400));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1100));

        destinationTokenQuantity = ether(0.05);
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(destinationTokenQuantity);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.rebalance();
      }

      it("should set TWAP state", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
        const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          currentLeverageRatio,
          targetLeverageRatio,
          minLeverageRatio,
          maxLeverageRatio,
          recenteringSpeed
        );
        expect(previousIsTWAP).to.be.false;
        expect(currentIsTWAP).to.be.true;
        expect(twapState.twapNewLeverageRatio).to.eq(expectedNewLeverageRatio);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
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

      describe("when TWAP cooldown has not elapsed", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("TWAP cooldown not yet elapsed");
        });
      });
    });

    context("when current leverage ratio is above target and no TWAP", async () => {
      beforeEach(async () => {
        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await increaseTimeAsync(BigNumber.from(86400));
        // Set to $990 so need to delever
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(990));
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(20000000));
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.rebalance();
      }

      it("should not set TWAP state", async () => {
        const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(previousIsTWAP).to.be.false;
        expect(currentIsTWAP).to.be.false;
        expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
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

      describe("when rebalance interval has not elapsed but is above max leverage ratio and lower than max trade size", async () => {
        beforeEach(async () => {
          await subject();
          // ~2.4x leverage
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(700));
          await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(2));
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(600000000));
        });

        it("should not set TWAP state", async () => {
          const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          await subject();

          const twapState = await flexibleLeverageStrategyAdapter.twapState();
          const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          expect(previousIsTWAP).to.be.false;
          expect(currentIsTWAP).to.be.false;
          expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
          expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
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
        beforeEach(async () => {
          await subject();

          // > Max trade size
          maxTradeSize = ether(0.01);
          await flexibleLeverageStrategyAdapter.setMaxTradeSize(maxTradeSize);
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(700));
          await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(600000000));
        });

        it("should set TWAP state", async () => {
          const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
          const previousIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          await subject();

          const twapState = await flexibleLeverageStrategyAdapter.twapState();
          const currentIsTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

          const expectedNewLeverageRatio = calculateNewLeverageRatio(
            currentLeverageRatio,
            targetLeverageRatio,
            minLeverageRatio,
            maxLeverageRatio,
            recenteringSpeed
          );
          expect(previousIsTWAP).to.be.false;
          expect(currentIsTWAP).to.be.true;
          expect(twapState.twapNewLeverageRatio).to.eq(expectedNewLeverageRatio);
          expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is decreased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Max TWAP collateral units
          const exchangeRate = await cEther.exchangeRateStored();
          const newUnits = preciseDiv(maxTradeSize, exchangeRate);
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
    });
  });

  describe("#disengage", async () => {
    let subjectCaller: Account;

    context("when notional is greater than max trade size and total rebalance notional is greater than max borrow", async () => {
      beforeEach(async () => {
        // Approve tokens to issuance module and call issue
        await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));

        // Engage to initial leverage
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(3600));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.rebalance();

        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(550000000));
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

      it("should set TWAP state", async () => {
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(isTWAP).to.be.true;
        expect(twapState.twapNewLeverageRatio).to.eq(ether(1)); // Leverage to 1x. 10 ^ 18
        expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Max TWAP collateral units
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(maxTradeSize, exchangeRate);
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

      it("should update to not engaged", async () => {
        await subject();

        const isEngaged = await flexibleLeverageStrategyAdapter.isEngaged();
        expect(isEngaged).to.be.false;
      });

      it("should update last rebalance timestamp", async () => {
        await subject();

        const lastRebalanceTimestamp = await flexibleLeverageStrategyAdapter.lastRebalanceTimestamp();
        expect(lastRebalanceTimestamp).to.be.eq(await getLastBlockTimestamp());
      });

      describe("when the manager is not engaged", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be engaged");
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
        await flexibleLeverageStrategyAdapter.engage();
        await increaseTimeAsync(BigNumber.from(3600));
        await setV2Setup.weth.transfer(tradeAdapterMock.address, ether(0.5));
        await flexibleLeverageStrategyAdapter.rebalance();

        // Withdraw balance of USDC from exchange contract from engage
        await tradeAdapterMock.withdraw(setV2Setup.usdc.address);
        await setV2Setup.usdc.transfer(tradeAdapterMock.address, BigNumber.from(800000000)); // 800 USDC
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(2));
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

      it("should set TWAP state", async () => {
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(isTWAP).to.be.true;
        expect(twapState.twapNewLeverageRatio).to.eq(ether(1)); // 1x leverage
        expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        // Get max borrow
        const previousCTokenBalance = await cEther.balanceOf(setToken.address);
        const exchangeRate = await cEther.exchangeRateStored();
        const previousCollateralBalance = preciseMul(previousCTokenBalance, exchangeRate);

        const borrowValue = (await cUSDC.borrowBalanceStored(setToken.address)).mul(ether(1)).div(BigNumber.from(1000000)); // Normalize decimals
        const accountLiquidity = (await compoundSetup.comptroller.getAccountLiquidity(setToken.address))[1];

        await subject();

        // cEther position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const maxRedeemCollateral = calculateMaxBorrowForDelever(
          previousCollateralBalance,
          borrowValue,
          bufferPercentage,
          ether(1),
          accountLiquidity
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
      });

      after(async () => {
        customTargetLeverageRatio = undefined;
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
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(ether(2));
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
        return flexibleLeverageStrategyAdapter.disengage();
      }

      it("should not set TWAP state", async () => {
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        expect(isTWAP).to.be.false;
        expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
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
      const actualValue = await flexibleLeverageStrategyAdapter.maxTradeSize();
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
      const actualValue = await flexibleLeverageStrategyAdapter.twapCooldown();
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

  describe("#setBufferPercentage", async () => {
    let subjectBuffer: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectBuffer = ether(0.1);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setBufferPercentage(subjectBuffer);
    }

    it("should set the correct value", async () => {
      await subject();
      const actualValue = await flexibleLeverageStrategyAdapter.bufferPercentage();
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

  describe("#setRecenteringSpeed", async () => {
    let subjectRecenteringSpeed: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectRecenteringSpeed = ether(0.05);
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
      return flexibleLeverageStrategyAdapter.setRecenteringSpeed(subjectRecenteringSpeed);
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
});
