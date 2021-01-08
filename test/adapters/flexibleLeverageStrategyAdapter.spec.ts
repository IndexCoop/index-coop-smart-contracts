import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account, Bytes } from "@utils/types";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, IcManagerV2, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundLeverageModule, SetToken } from "@utils/contracts/setV2";
import { CEther, CeRc20 } from "@utils/contracts/compound";
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
  calculateNewLeverageRatio
} from "@utils/index";
import { SetFixture, CompoundFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe.only("FlexibleLeverageStrategyAdapter", () => {
  let owner: Account;
  let methodologist: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CeRc20;
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

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let icManagerV2: IcManagerV2;

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

    // Deploy mock trade adapter
    tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );

    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [new BigNumber(5000000000)], // Equivalent to 1 ETH
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address, compoundLeverageModule.address]
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
    await compoundLeverageModule.initialize(
      setToken.address,
      [setV2Setup.weth.address],
      [setV2Setup.usdc.address]
    );

    icManagerV2 = await deployer.manager.deployICManagerV2(
      setToken.address,
      owner.address,
      methodologist.address
    );

    // Deploy adapter
    targetLeverageRatio = ether(2);
    minLeverageRatio = ether(1.7);
    maxLeverageRatio = ether(2.3);
    recenteringSpeed = ether(0.05);
    rebalanceInterval = new BigNumber(86400);

    bufferPercentage = ether(0.01);
    maxTradeSize = ether(0.5);
    twapCooldown = new BigNumber(3600);
    slippageTolerance = ether(0.01);

    flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
      [
        setToken.address,                  // SetToken address
        compoundLeverageModule.address,    // Compound leverage module
        icManagerV2.address,               // ICManager address
        compoundSetup.comptroller.address, // Comptroller
        compoundSetup.priceOracle.address, // Compound open oracle
        cEther.address,                    // Target cToken collateral
        cUSDC.address,                      // Target cToken borrow
        setV2Setup.weth.address,           // Target underlying collateral
        setV2Setup.usdc.address,             // Target underlying borrow
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

    // Transfer ownership to ic manager
    await setToken.setManager(icManagerV2.address);

    // Add adapter
    await icManagerV2.connect(methodologist.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
    await icManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);

    // Approve tokens to issuance module and call issue
    await cEther.approve(setV2Setup.issuanceModule.address, ether(1000));

    // Issue 1 SetToken
    const issueQuantity = ether(1);
    await setV2Setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
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
        new BigNumber(86400).toString(),   // Rebalance interval in seconds
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

    context("when notional is greater than max trade size and max borrow is less than total rebalance notional", async () => {
      beforeEach(async () => {
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

      describe("when the caller is not the operator", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when notional is less than max trade size and max borrow is less than total rebalance notional", async () => {
      beforeEach(async () => {
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

    context("when notional is less than max trade size and max borrow is greater than total rebalance notional", async () => {
      beforeEach(async () => {
        targetLeverageRatio = ether(1.25); // Change to 1.25x
        minLeverageRatio = ether(1.7);
        maxLeverageRatio = ether(2.3);
        recenteringSpeed = ether(0.05);
        rebalanceInterval = new BigNumber(86400);

        bufferPercentage = ether(0.01);
        maxTradeSize = ether(0.5);
        twapCooldown = new BigNumber(3600);
        slippageTolerance = ether(0.01);
        flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
          [
            setToken.address,                  // SetToken address
            compoundLeverageModule.address,    // Compound leverage module
            icManagerV2.address,               // ICManager address
            compoundSetup.comptroller.address, // Comptroller
            compoundSetup.priceOracle.address, // Compound open oracle
            cEther.address,                    // Target cToken collateral
            cUSDC.address,                      // Target cToken borrow
            setV2Setup.weth.address,           // Target underlying collateral
            setV2Setup.usdc.address,             // Target underlying borrow
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

  describe.only("#rebalance", async () => {
    let destinationTokenQuantity: BigNumber;

    beforeEach(async () => {
      destinationTokenQuantity = ether(0.5);
      await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);

      await flexibleLeverageStrategyAdapter.engage();
      await increaseTimeAsync(new BigNumber(3600));
      await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    });

    context("when current leverage ratio is below target and no TWAP", async () => {
      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.rebalance();
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

      describe("when rebalance interval has not elapsed", async () => {
        beforeEach(async () => {
          await subject();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebalance interval not yet elapsed");
        });
      });
    });

    context.only("when current leverage ratio is below target and is TWAP rebalance", async () => {
      beforeEach(async () => {
        await flexibleLeverageStrategyAdapter.rebalance();
        await increaseTimeAsync(new BigNumber(86400));
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(2000));

        destinationTokenQuantity = ether(0.1);
        await flexibleLeverageStrategyAdapter.setMaxTradeSize(destinationTokenQuantity);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
      });

      async function subject(): Promise<any> {
        return flexibleLeverageStrategyAdapter.rebalance();
      }

      it("should set TWAP state", async () => {
        const currentLeverageRatio = await flexibleLeverageStrategyAdapter.getCurrentLeverageRatio();
        await subject();

        const twapState = await flexibleLeverageStrategyAdapter.twapState();
        const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

        const expectedNewLeverageRatio = calculateNewLeverageRatio(
          currentLeverageRatio,
          targetLeverageRatio,
          minLeverageRatio,
          maxLeverageRatio,
          recenteringSpeed
        );
        expect(isTWAP).to.be.true;
        expect(twapState.twapNewLeverageRatio).to.eq(expectedNewLeverageRatio);
        expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        console.log((await compoundSetup.comptroller.getAccountLiquidity(setToken.address))[1]);
        await subject();
        console.log((await compoundSetup.comptroller.getAccountLiquidity(setToken.address))[1]);
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

    // context("when notional is less than max trade size and max borrow is less than total rebalance notional", async () => {
    //   beforeEach(async () => {
    //     await flexibleLeverageStrategyAdapter.connect(owner.wallet).setMaxTradeSize(ether(2));

    //     // Traded amount is equal to account liquidity * buffer percentage
    //     destinationTokenQuantity = ether(0.7425);
    //     await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //     subjectCaller = owner;
    //   });

    //   async function subject(): Promise<any> {
    //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
    //     return flexibleLeverageStrategyAdapter.engage();
    //   }

    //   it("should set TWAP state", async () => {
    //     await subject();

    //     const twapState = await flexibleLeverageStrategyAdapter.twapState();
    //     const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

    //     expect(isTWAP).to.be.true;
    //     expect(twapState.twapNewLeverageRatio).to.eq(targetLeverageRatio);
    //     expect(twapState.lastTWAPTradeTimestamp).to.eq(await getLastBlockTimestamp());
    //   });

    //   it("should update the collateral position on the SetToken correctly", async () => {
    //     const initialPositions = await setToken.getPositions();

    //     await subject();

    //     // cEther position is increased
    //     const currentPositions = await setToken.getPositions();
    //     const newFirstPosition = (await setToken.getPositions())[0];

    //     // Get expected cTokens minted
    //     const exchangeRate = await cEther.exchangeRateStored();
    //     const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
    //     const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

    //     expect(initialPositions.length).to.eq(1);
    //     expect(currentPositions.length).to.eq(2);
    //     expect(newFirstPosition.component).to.eq(cEther.address);
    //     expect(newFirstPosition.positionState).to.eq(0); // Default
    //     expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //     expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //   });

    //   it("should update the borrow position on the SetToken correctly", async () => {
    //     const initialPositions = await setToken.getPositions();

    //     await subject();

    //     // cEther position is increased
    //     const currentPositions = await setToken.getPositions();
    //     const newSecondPosition = (await setToken.getPositions())[1];

    //     const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

    //     expect(initialPositions.length).to.eq(1);
    //     expect(currentPositions.length).to.eq(2);
    //     expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
    //     expect(newSecondPosition.positionState).to.eq(1); // External
    //     expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //     expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
    //   });
    // });

    // context("when notional is less than max trade size and max borrow is greater than total rebalance notional", async () => {
    //   beforeEach(async () => {
    //     targetLeverageRatio = ether(1.25); // Change to 1.25x
    //     minLeverageRatio = ether(1.7);
    //     maxLeverageRatio = ether(2.3);
    //     recenteringSpeed = ether(0.05);
    //     rebalanceInterval = new BigNumber(86400);

    //     bufferPercentage = ether(0.01);
    //     maxTradeSize = ether(0.5);
    //     twapCooldown = new BigNumber(3600);
    //     slippageTolerance = ether(0.01);
    //     flexibleLeverageStrategyAdapter = await deployer.adapters.deployFlexibleLeverageStrategyAdapter(
    //       [
    //         setToken.address,                  // SetToken address
    //         compoundLeverageModule.address,    // Compound leverage module
    //         icManagerV2.address,               // ICManager address
    //         compoundSetup.comptroller.address, // Comptroller
    //         compoundSetup.priceOracle.address, // Compound open oracle
    //         cEther.address,                    // Target cToken collateral
    //         cUSDC.address,                      // Target cToken borrow
    //         setV2Setup.weth.address,           // Target underlying collateral
    //         setV2Setup.usdc.address             // Target underlying borrow
    //       ],
    //       [
    //         "18",
    //         "6"
    //       ],
    //       [
    //         targetLeverageRatio.toString(),               // Target leverage ratio
    //         minLeverageRatio.toString(),             // Min leverage ratio
    //         maxLeverageRatio.toString(),             // Max leverage ratio
    //         recenteringSpeed.toString(),            // Recentering speed (5%)
    //         rebalanceInterval.toString(),   // Rebalance interval in seconds
    //       ],
    //       [
    //         bufferPercentage.toString(),            // Buffer percentage
    //         maxTradeSize.toString(),             // Max trade size in collateral base units
    //         twapCooldown.toString(),            // TWAP cooldown in seconds
    //         slippageTolerance.toString(),            // Slippage tolerance percentage
    //       ],
    //       "MockTradeAdapter",
    //       EMPTY_BYTES
    //     );

    //     // Add adapter
    //     await icManagerV2.connect(methodologist.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);
    //     await icManagerV2.connect(owner.wallet).addAdapter(flexibleLeverageStrategyAdapter.address);

    //     // Traded amount is equal to account liquidity * buffer percentage
    //     destinationTokenQuantity = ether(0.25);
    //     await setV2Setup.weth.transfer(tradeAdapterMock.address, destinationTokenQuantity);
    //     subjectCaller = owner;
    //   });

    //   async function subject(): Promise<any> {
    //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
    //     return flexibleLeverageStrategyAdapter.engage();
    //   }

    //   it("should not set TWAP state", async () => {
    //     await subject();

    //     const twapState = await flexibleLeverageStrategyAdapter.twapState();
    //     const isTWAP = await flexibleLeverageStrategyAdapter.isTWAP();

    //     expect(isTWAP).to.be.false;
    //     expect(twapState.twapNewLeverageRatio).to.eq(ZERO);
    //     expect(twapState.lastTWAPTradeTimestamp).to.eq(ZERO);
    //   });

    //   it("should update the collateral position on the SetToken correctly", async () => {
    //     const initialPositions = await setToken.getPositions();

    //     await subject();

    //     // cEther position is increased
    //     const currentPositions = await setToken.getPositions();
    //     const newFirstPosition = (await setToken.getPositions())[0];

    //     // Get expected cTokens minted
    //     const exchangeRate = await cEther.exchangeRateStored();
    //     const newUnits = preciseDiv(destinationTokenQuantity, exchangeRate);
    //     const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

    //     expect(initialPositions.length).to.eq(1);
    //     expect(currentPositions.length).to.eq(2);
    //     expect(newFirstPosition.component).to.eq(cEther.address);
    //     expect(newFirstPosition.positionState).to.eq(0); // Default
    //     expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
    //     expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
    //   });

    //   it("should update the borrow position on the SetToken correctly", async () => {
    //     const initialPositions = await setToken.getPositions();

    //     await subject();

    //     // cEther position is increased
    //     const currentPositions = await setToken.getPositions();
    //     const newSecondPosition = (await setToken.getPositions())[1];

    //     const expectedSecondPositionUnit = (await cUSDC.borrowBalanceStored(setToken.address)).mul(-1);

    //     expect(initialPositions.length).to.eq(1);
    //     expect(currentPositions.length).to.eq(2);
    //     expect(newSecondPosition.component).to.eq(setV2Setup.usdc.address);
    //     expect(newSecondPosition.positionState).to.eq(1); // External
    //     expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
    //     expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
    //   });
    // });
  });

  // describe("#addAdapter", async () => {
  //   let subjectAdapter: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectAdapter = mockAdapter.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.addAdapter(subjectAdapter);
  //   }

  //   it("should log the proposed adapter hash in the mutualUpgrades mapping", async () => {
  //     const txHash = await subject();

  //     const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
  //     const isLogged = await flexibleLeverageStrategyAdapter.mutualUpgrades(expectedHash);

  //     expect(isLogged).to.be.true;
  //   });

  //   describe("when proposed adapter hash is already set", async () => {
  //     beforeEach(async () => {
  //       await flexibleLeverageStrategyAdapter.connect(owner.wallet).addAdapter(mockAdapter.address);

  //       subjectCaller = methodologist;
  //     });

  //     it("should add the adapter address", async () => {
  //       await subject();
  //       const adapters = await flexibleLeverageStrategyAdapter.getAdapters();

  //       expect(adapters[0]).to.eq(mockAdapter.address);
  //     });

  //     it("should set the adapter mapping", async () => {
  //       await subject();
  //       const isAdapter = await flexibleLeverageStrategyAdapter.isAdapter(subjectAdapter);

  //       expect(isAdapter).to.be.true;
  //     });
  //   });

  //   describe("when the adapter already exists", async () => {
  //     beforeEach(async () => {
  //       await flexibleLeverageStrategyAdapter.connect(owner.wallet).addAdapter(mockAdapter.address);
  //       subjectCaller = methodologist;
  //       await subject();
  //       await flexibleLeverageStrategyAdapter.connect(owner.wallet).addAdapter(mockAdapter.address);
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Adapter already exists");
  //     });
  //   });

  //   describe("when the caller is not the operator or methodologist", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be authorized address");
  //     });
  //   });
  // });

  // describe("#removeAdapter", async () => {
  //   let subjectAdapter: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await flexibleLeverageStrategyAdapter.connect(owner.wallet).addAdapter(mockAdapter.address);
  //     await flexibleLeverageStrategyAdapter.connect(methodologist.wallet).addAdapter(mockAdapter.address);

  //     subjectAdapter = mockAdapter.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.removeAdapter(subjectAdapter);
  //   }

  //   it("should log the proposed adapter hash in the mutualUpgrades mapping", async () => {
  //     const txHash = await subject();

  //     const expectedHash = solidityKeccak256(["bytes", "address"], [txHash.data, subjectCaller.address]);
  //     const isLogged = await flexibleLeverageStrategyAdapter.mutualUpgrades(expectedHash);

  //     expect(isLogged).to.be.true;
  //   });

  //   describe("when proposed adapter hash is already set", async () => {
  //     beforeEach(async () => {
  //       await flexibleLeverageStrategyAdapter.connect(owner.wallet).removeAdapter(mockAdapter.address);

  //       subjectCaller = methodologist;
  //     });

  //     it("should remove the adapter address", async () => {
  //       await subject();
  //       const adapters = await flexibleLeverageStrategyAdapter.getAdapters();

  //       expect(adapters.length).to.eq(0);
  //     });

  //     it("should set the adapter mapping", async () => {
  //       await subject();
  //       const isAdapter = await flexibleLeverageStrategyAdapter.isAdapter(subjectAdapter);

  //       expect(isAdapter).to.be.false;
  //     });
  //   });

  //   describe("when the adapter does not exist", async () => {
  //     beforeEach(async () => {
  //       subjectAdapter = await getRandomAddress();

  //       await flexibleLeverageStrategyAdapter.connect(owner.wallet).removeAdapter(subjectAdapter);
  //       subjectCaller = methodologist;
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Adapter does not exist");
  //     });
  //   });

  //   describe("when the caller is not the operator or methodologist", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be authorized address");
  //     });
  //   });
  // });

  // describe("#addModule", async () => {
  //   let subjectModule: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await setV2Setup.controller.addModule(otherAccount.address);

  //     subjectModule = otherAccount.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.addModule(subjectModule);
  //   }

  //   it("should add the module to the SetToken", async () => {
  //     await subject();
  //     const isModule = await setToken.isPendingModule(subjectModule);
  //     expect(isModule).to.eq(true);
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });

  // describe("#interactModule", async () => {
  //   let subjectModule: Address;
  //   let subjectCallData: Bytes;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     await flexibleLeverageStrategyAdapter.connect(owner.wallet).addAdapter(owner.address);
  //     await flexibleLeverageStrategyAdapter.connect(methodologist.wallet).addAdapter(owner.address);

  //     subjectModule = setV2Setup.streamingFeeModule.address;

  //     // Invoke update fee recipient
  //     subjectCallData = setV2Setup.streamingFeeModule.interface.functions.updateFeeRecipient.encode([
  //       setToken.address,
  //       otherAccount.address,
  //     ]);
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.interactModule(subjectModule, subjectCallData);
  //   }

  //   it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
  //     await subject();
  //     const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //     expect(feeStates.feeRecipient).to.eq(otherAccount.address);
  //   });

  //   describe("when the caller is not an adapter", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be adapter");
  //     });
  //   });
  // });

  // describe("#removeModule", async () => {
  //   let subjectModule: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectModule = setV2Setup.streamingFeeModule.address;
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.removeModule(subjectModule);
  //   }

  //   it("should remove the module from the SetToken", async () => {
  //     await subject();
  //     const isModule = await setToken.isInitializedModule(subjectModule);
  //     expect(isModule).to.eq(false);
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });

  // describe("#setMethodologist", async () => {
  //   let subjectNewMethodologist: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectNewMethodologist = await getRandomAddress();
  //     subjectCaller = methodologist;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.setMethodologist(subjectNewMethodologist);
  //   }

  //   it("should set the new methodologist", async () => {
  //     await subject();
  //     const actualIndexModule = await flexibleLeverageStrategyAdapter.methodologist();
  //     expect(actualIndexModule).to.eq(subjectNewMethodologist);
  //   });

  //   describe("when the caller is not the methodologist", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be methodologist");
  //     });
  //   });
  // });

  // describe("#setOperator", async () => {
  //   let subjectNewOperator: Address;
  //   let subjectCaller: Account;

  //   beforeEach(async () => {
  //     subjectNewOperator = await getRandomAddress();
  //     subjectCaller = owner;
  //   });

  //   async function subject(): Promise<any> {
  //     flexibleLeverageStrategyAdapter = flexibleLeverageStrategyAdapter.connect(subjectCaller.wallet);
  //     return flexibleLeverageStrategyAdapter.setOperator(subjectNewOperator);
  //   }

  //   it("should set the new operator", async () => {
  //     await subject();
  //     const actualIndexModule = await flexibleLeverageStrategyAdapter.operator();
  //     expect(actualIndexModule).to.eq(subjectNewOperator);
  //   });

  //   describe("when the caller is not the operator", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be operator");
  //     });
  //   });
  // });
});
