import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import {
  Address,
  Account,
} from "@utils/types";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { FlexibleLeverageStrategyAdapter, BaseManager, SimpleCompoundErc20FLIArb, TradeAdapterMock, DydxSoloMock } from "@utils/contracts/index";
import { CompoundLeverageModule, SetToken } from "@utils/contracts/setV2";
import { UniswapV2Pair } from "@utils/contracts/uniswap";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  bitcoin,
  ether,
  usdc,
  getAccounts,
  getEthBalance,
  getSetFixture,
  getCompoundFixture,
  getUniswapFixture,
  getWaffleExpect,
  increaseTimeAsync,
} from "@utils/index";
import { SetFixture, CompoundFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("SimpleCompoundErc20FLIArb", () => {
  let owner: Account;
  let methodologist: Account;
  let treasury: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;
  let uniswapSetup: UniswapFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let cWBTC: CERc20;
  let tradeAdapterMock: TradeAdapterMock;
  let dydxSoloMock: DydxSoloMock;

  let flexibleLeverageStrategyAdapter: FlexibleLeverageStrategyAdapter;
  let compoundLeverageModule: CompoundLeverageModule;
  let baseManagerV2: BaseManager;

  let simpleCompoundErc20FLIArb: SimpleCompoundErc20FLIArb;

  cacheBeforeEach(async () => {
    [
      owner,
      methodologist,
      treasury,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();
    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(
      owner.address,
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      setV2Setup.usdc.address
    );

    await setV2Setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(10000),
      usdc(10000000),
      ether(999),
      usdc(999000),
      owner.address,
      MAX_UINT_256
    );

    await setV2Setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.wbtc.address,
      setV2Setup.weth.address,
      bitcoin(100),
      ether(4000),
      bitcoin(99),
      ether(3900),
      owner.address,
      MAX_UINT_256
    );

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

    cWBTC = await compoundSetup.createAndEnableCToken(
      setV2Setup.wbtc.address,
      ether(0.02),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound WBTC",
      "cWBTC",
      8,
      ether(0.75),
      ether(500000000000000) // $50,000
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cWBTC.address, cUSDC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
    await setV2Setup.wbtc.approve(cWBTC.address, ether(100000));
    await cUSDC.mint(usdc(10000000));
    await cWBTC.mint(bitcoin(1000));
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

    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      setV2Setup.debtIssuanceModule.address,
    );

    // Deploy dYdX Solo mock
    dydxSoloMock = await deployer.mocks.deployDydxSoloMock(setV2Setup.weth.address);
  });

  const initializeRootScopeContracts = async () => {
    setToken = await setV2Setup.createSetToken(
      [cWBTC.address],
      [BigNumber.from(5000000000)], // Equivalent to 1 WBTC
      [
        setV2Setup.streamingFeeModule.address,
        compoundLeverageModule.address,
        setV2Setup.debtIssuanceModule.address,
      ]
    );
    await compoundLeverageModule.updateAnySetAllowed(true);

    // Initialize modules
    await setV2Setup.debtIssuanceModule.initialize(setToken.address, ether(1), ZERO, ZERO, owner.address, ADDRESS_ZERO);
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
      [setV2Setup.wbtc.address],
      [setV2Setup.usdc.address]
    );

    baseManagerV2 = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address,
    );

    // Transfer ownership to ic manager
    await setToken.connect(owner.wallet).setManager(baseManagerV2.address);

    // Deploy adapter
    const targetLeverageRatio = ether(2);
    const minLeverageRatio = ether(1.7);
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

    const strategy = {
      setToken: setToken.address,
      leverageModule: compoundLeverageModule.address,
      comptroller: compoundSetup.comptroller.address,
      priceOracle: compoundSetup.priceOracle.address,
      targetCollateralCToken: cWBTC.address,
      targetBorrowCToken: cUSDC.address,
      collateralAsset: setV2Setup.wbtc.address,
      borrowAsset: setV2Setup.usdc.address,
    };
    const methodology = {
      targetLeverageRatio: targetLeverageRatio,
      minLeverageRatio: minLeverageRatio,
      maxLeverageRatio: maxLeverageRatio,
      recenteringSpeed: recenteringSpeed,
      rebalanceInterval: rebalanceInterval,
    };
    const execution = {
      unutilizedLeveragePercentage: unutilizedLeveragePercentage,
      twapMaxTradeSize: twapMaxTradeSize,
      twapCooldownPeriod: twapCooldownPeriod,
      slippageTolerance: slippageTolerance,
      exchangeName: "MockTradeAdapter",
      leverExchangeData: EMPTY_BYTES,
      deleverExchangeData: EMPTY_BYTES,
    };
    const incentive = {
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

    // Approve tokens to issuance module and call issue
    await cWBTC.approve(setV2Setup.debtIssuanceModule.address, ether(1000));

    // Issue 10 SetToken
    await setV2Setup.debtIssuanceModule.issue(setToken.address, ether(10), owner.address);

    await setV2Setup.wbtc.transfer(tradeAdapterMock.address, bitcoin(10));

    // Add allowed trader
    await flexibleLeverageStrategyAdapter.updateCallerStatus([owner.address], [true]);

    // Engage to initial leverage
    await flexibleLeverageStrategyAdapter.engage();
    await increaseTimeAsync(BigNumber.from(100000));
    await setV2Setup.wbtc.transfer(tradeAdapterMock.address, bitcoin(7));
    await flexibleLeverageStrategyAdapter.iterateRebalance();
    // Deploy Arb bot
    simpleCompoundErc20FLIArb = await deployer.bots.deploySimpleCompoundErc20FLIArb(
      dydxSoloMock.address,
      uniswapSetup.router.address,
      setV2Setup.debtIssuanceModule.address,
      setV2Setup.weth.address,
      uniswapSetup.factory.address,
      treasury.address,
    );

    // Configure mock// Configure mock solo contract
    await dydxSoloMock.setShouldOperate(true);
    await dydxSoloMock.addArbContract(simpleCompoundErc20FLIArb.address);
  };

  describe("#constructor", async () => {
    let subjectSolo: Address;
    let subjectRouter: Address;
    let subjectDebtIssuanceModule: Address;
    let subjectWeth: Address;
    let subjectFactory: Address;
    let subjectIndexCoopTreasury: Address;

    cacheBeforeEach(initializeRootScopeContracts);

    beforeEach(async () => {
      // Configure to false for testing constructor
      await dydxSoloMock.setShouldOperate(false);

      subjectSolo = dydxSoloMock.address;
      subjectRouter = uniswapSetup.router.address;
      subjectDebtIssuanceModule = setV2Setup.debtIssuanceModule.address;
      subjectWeth = setV2Setup.weth.address;
      subjectFactory = uniswapSetup.factory.address;
      subjectIndexCoopTreasury = treasury.address;
    });

    async function subject(): Promise<SimpleCompoundErc20FLIArb> {
      return deployer.bots.deploySimpleCompoundErc20FLIArb(
        subjectSolo,
        subjectRouter,
        subjectDebtIssuanceModule,
        subjectWeth,
        subjectFactory,
        subjectIndexCoopTreasury
      );
    }

    it("should set the correct addresses", async () => {
      const retrievedBot = await subject();

      const solo = await retrievedBot.solo();
      const router = await retrievedBot.router();
      const debtIssuanceModule = await retrievedBot.debtIssuanceModule();
      const weth = await retrievedBot.weth();
      const factory = await retrievedBot.factory();
      const indexCoopTreasury = await retrievedBot.indexCoopTreasury();

      expect(solo).to.eq(subjectSolo);
      expect(router).to.eq(subjectRouter);
      expect(debtIssuanceModule).to.eq(subjectDebtIssuanceModule);
      expect(weth).to.eq(subjectWeth);
      expect(factory).to.eq(subjectFactory);
      expect(indexCoopTreasury).to.eq(subjectIndexCoopTreasury);
    });

    it("should set approvals for weth to solo", async () => {
      const retrievedBot = await subject();
      const routerWethAllowance = await setV2Setup.weth.allowance(retrievedBot.address, dydxSoloMock.address);

      expect(routerWethAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for weth to router", async () => {
      const retrievedBot = await subject();
      const routerWethAllowance = await setV2Setup.weth.allowance(retrievedBot.address, uniswapSetup.router.address);
      expect(routerWethAllowance).to.eq(MAX_UINT_256);
    });

    it("should deposit 2 wei into solo", async () => {
      // Since mock does not execute operations, deposit 2 wei in dYdX
      await setV2Setup.weth.transfer(dydxSoloMock.address, 2);

      await subject();

      const balanceOfWeth = await setV2Setup.weth.balanceOf(dydxSoloMock.address);

      expect(balanceOfWeth).to.eq(2);
    });
  });

  describe("approveAll", () => {
    let subjectSetToken: Address;

    cacheBeforeEach(initializeRootScopeContracts);

    beforeEach(async () => {
      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<any> {
      return simpleCompoundErc20FLIArb.approveAll(subjectSetToken);
    }

    it("should set approvals for set token to router", async () => {
      await subject();
      const routerSetTokenAllowance = await setToken.allowance(simpleCompoundErc20FLIArb.address, uniswapSetup.router.address);
      expect(routerSetTokenAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for collateral to router", async () => {
      await subject();
      const routerCollateralAssetAllowance = await setV2Setup.wbtc.allowance(simpleCompoundErc20FLIArb.address, uniswapSetup.router.address);
      expect(routerCollateralAssetAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for ctoken to issuance module", async () => {
      await subject();
      const issuanceModuleCTokenAllowance = await cWBTC.allowance(simpleCompoundErc20FLIArb.address, setV2Setup.debtIssuanceModule.address);
      expect(issuanceModuleCTokenAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for borrow asset to issuance module", async () => {
      await subject();

      const issuanceModuleBorrowAssetAllowance =
        await setV2Setup.usdc.allowance(simpleCompoundErc20FLIArb.address, setV2Setup.debtIssuanceModule.address);
      expect(issuanceModuleBorrowAssetAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for borrow to router", async () => {
      await subject();
      const routerBorrowAssetAllowance = await setV2Setup.usdc.allowance(simpleCompoundErc20FLIArb.address, uniswapSetup.router.address);
      expect(routerBorrowAssetAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for underlying to cToken", async () => {
      await subject();

      const cTokenUnderlyingAssetAllowance =
        await setV2Setup.wbtc.allowance(simpleCompoundErc20FLIArb.address, cWBTC.address);

      expect(cTokenUnderlyingAssetAllowance).to.eq(MAX_UINT_256);
    });
  });

  describe.only("executeFlashLoanArb", () => {
    let subjectSetToken: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectLoanAmount: BigNumber;
    let subjectMaxTradeSlippage: BigNumber;
    let subjectPoolSetReserves: BigNumber;
    let subjectIsIssueArb: boolean;
    let subjectSetPoolToken: Address;
    let subjectGasPrice: BigNumber;

    cacheBeforeEach(initializeRootScopeContracts);

    async function subject(): Promise<any> {
      return simpleCompoundErc20FLIArb.executeFlashLoanArb(
        subjectSetToken,
        subjectSetTokenQuantity,
        subjectLoanAmount,
        subjectMaxTradeSlippage,
        subjectPoolSetReserves,
        subjectIsIssueArb,
        subjectSetPoolToken,
        { gasPrice: subjectGasPrice }
      );
    }

    context("when arbing Set issuance", async () => {
      let uniswapPair: UniswapV2Pair;

      beforeEach(async () => {
        uniswapPair = await uniswapSetup.createNewPair(setV2Setup.wbtc.address, setToken.address);

        await setV2Setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
        await setToken.approve(uniswapSetup.router.address, MAX_UINT_256);
        await uniswapSetup.router.addLiquidity(
          setV2Setup.wbtc.address,
          setToken.address,
          bitcoin(20),
          ether(10),
          bitcoin(9),
          ether(9),
          owner.address,
          MAX_UINT_256
        );

        await simpleCompoundErc20FLIArb.approveAll(setToken.address);
        // Since mock does not execute loan, deposit 100 ETH
        await setV2Setup.weth.transfer(simpleCompoundErc20FLIArb.address, ether(200));

        subjectSetToken = setToken.address;
        subjectSetTokenQuantity = ether(1);
        subjectLoanAmount = ether(100);
        subjectMaxTradeSlippage = ether(0.02);
        subjectPoolSetReserves = ether(100);
        subjectIsIssueArb = true; // Issue arb
        subjectSetPoolToken = setV2Setup.wbtc.address;
        subjectGasPrice = BigNumber.from(1000000000); // 1 GWEI
      });

      it("should send profits to treasury", async () => {
        const previousTreasuryBalance = await getEthBalance(treasury.address);

        await subject();

        const currentTreasuryBalance = await getEthBalance(treasury.address);

        expect(currentTreasuryBalance).to.gt(previousTreasuryBalance);
      });

      it("should send gas back to caller (slightly less)", async () => {
        const previousCallerBalance = await getEthBalance(owner.address);

        await subject();

        const currentCallerBalance = await getEthBalance(owner.address);
        expect(currentCallerBalance).to.gte(previousCallerBalance);
      });

      describe("when eth profit is less than than gas used", async () => {
        beforeEach(async () => {
          // Lower Set price until its barely profitable to arb
          await uniswapSetup.router.swapExactTokensForTokens(
            bitcoin(4),
            ZERO,
            [setV2Setup.wbtc.address, setToken.address],
            owner.address,
            MAX_UINT_256
          );

          // Set gas extremely high to make it not profitable to arb
          subjectGasPrice = ether(1);
        });

        it("should not send profits to treasury", async () => {
          const previousTreasuryBalance = await getEthBalance(treasury.address);

          await subject();

          const currentTreasuryBalance = await getEthBalance(treasury.address);

          expect(previousTreasuryBalance).to.eq(currentTreasuryBalance);
        });

        it("should send balance back to caller", async () => {
          const previousCallerBalance = await getEthBalance(owner.address);

          await subject();

          const currentCallerBalance = await getEthBalance(owner.address);
          expect(currentCallerBalance).to.lt(previousCallerBalance);
        });
      });

      describe("when pool set balance is more than actual (frontran)", async () => {
        beforeEach(async () => {
          subjectPoolSetReserves = ether(1);
        });

        it("should not arb", async () => {
          const previousBalanceOfSetToken = await setToken.balanceOf(uniswapPair.address);

          await subject();

          const currentBalanceOfSetToken = await setToken.balanceOf(uniswapPair.address);
          expect(previousBalanceOfSetToken).to.eq(currentBalanceOfSetToken);
        });
      });
    });

    context("when arbing Set redemption", async () => {
      let uniswapPair: UniswapV2Pair;

      beforeEach(async () => {
        uniswapPair = await uniswapSetup.createNewPair(setV2Setup.wbtc.address, setToken.address);
        await setV2Setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
        await setToken.approve(uniswapSetup.router.address, MAX_UINT_256);
        await uniswapSetup.router.addLiquidity(
          setV2Setup.wbtc.address,
          setToken.address,
          bitcoin(5),
          ether(10),
          bitcoin(9),
          ether(9),
          owner.address,
          MAX_UINT_256
        );

        await simpleCompoundErc20FLIArb.approveAll(setToken.address);
        // Since mock does not execute loan, deposit 100 ETH
        await setV2Setup.weth.transfer(simpleCompoundErc20FLIArb.address, ether(200));

        // When arbing redeems, there is rounding issues when reading stored debt balance, and therefore we need to send reserves to the contract
        await setV2Setup.usdc.transfer(simpleCompoundErc20FLIArb.address, usdc(200));

        subjectSetToken = setToken.address;
        subjectSetTokenQuantity = ether(1);
        subjectLoanAmount = ether(100);
        subjectMaxTradeSlippage = ether(0.02);
        subjectPoolSetReserves = ether(1);
        subjectIsIssueArb = false; // Redeem arb
        subjectSetPoolToken = setV2Setup.wbtc.address;
        subjectGasPrice = BigNumber.from(100000000000); // 100 GWEI
      });

      it("should send profits to treasury", async () => {
        const previousTreasuryBalance = await getEthBalance(treasury.address);

        await subject();

        const currentTreasuryBalance = await getEthBalance(treasury.address);

        expect(currentTreasuryBalance).to.gt(previousTreasuryBalance);
      });

      it("should send gas back to caller", async () => {
        const previousCallerBalance = await getEthBalance(owner.address);

        await subject();

        const currentCallerBalance = await getEthBalance(owner.address);
        expect(currentCallerBalance).to.gte(previousCallerBalance);
      });

      describe("when pool set balance is less than actual (frontran)", async () => {
        beforeEach(async () => {
          subjectPoolSetReserves = ether(100);
        });

        it("should not arb", async () => {
          const previousBalanceOfSetToken = await setToken.balanceOf(uniswapPair.address);

          await subject();

          const currentBalanceOfSetToken = await setToken.balanceOf(uniswapPair.address);
          expect(previousBalanceOfSetToken).to.eq(currentBalanceOfSetToken);
        });
      });
    });
  });

  describe("getSpread", () => {
    let subjectSetToken: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectSetPoolToken: Address;

    cacheBeforeEach(initializeRootScopeContracts);

    async function subject(): Promise<any> {
      return simpleCompoundErc20FLIArb.getSpread(
        subjectSetToken,
        subjectSetTokenQuantity,
        subjectSetPoolToken
      );
    }

    context("when there is an issuance arb opportunity", async () => {
      beforeEach(async () => {
        await setV2Setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
        await setToken.approve(uniswapSetup.router.address, MAX_UINT_256);
        await uniswapSetup.router.addLiquidity(
          setV2Setup.wbtc.address,
          setToken.address,
          bitcoin(50),
          ether(10),
          bitcoin(9),
          ether(9),
          owner.address,
          MAX_UINT_256
        );

        subjectSetToken = setToken.address;
        subjectSetTokenQuantity = ether(1);
        subjectSetPoolToken = setV2Setup.wbtc.address;
      });

      it("should return the correct spread", async () => {
        const spread = await subject();

        expect(spread[0]).to.gte(ZERO);
        expect(spread[1]).to.eq(ZERO);
      });
    });

    context("when there is a redemption arb opportunity", async () => {
      beforeEach(async () => {
        await setV2Setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
        await setToken.approve(uniswapSetup.router.address, MAX_UINT_256);
        await uniswapSetup.router.addLiquidity(
          setV2Setup.wbtc.address,
          setToken.address,
          bitcoin(5),
          ether(10),
          bitcoin(3),
          ether(9),
          owner.address,
          MAX_UINT_256
        );

        subjectSetToken = setToken.address;
        subjectSetTokenQuantity = ether(1);
        subjectSetPoolToken = setV2Setup.wbtc.address;
      });

      it("should return the correct spread", async () => {
        const spread = await subject();

        expect(spread[1]).to.gte(ZERO);
        expect(spread[0]).to.eq(ZERO);
      });
    });
  });
});
