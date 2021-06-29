import "module-alias/register";

import { Address, Account, ModuleSettings } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES } from "@utils/constants";
import { COMPReinvestmentExtension, BaseManager, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundWrapAdapter, CompClaimAdapter, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getCompoundFixture,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { CompoundFixture, SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe.only("COMPReinvestmentExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let cEther: CEther;
  let cUSDC: CERc20;
  let compClaimAdapter: CompClaimAdapter;
  let compoundWrapAdapter: CompoundWrapAdapter;
  let tradeAdapterMock: TradeAdapterMock;

  let baseManagerV2: BaseManager;
  // let compReinvestmentExtension: COMPReinvestmentExtension;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
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

    // Deploy mock trade adapter
    tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.tradeModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );

    compClaimAdapter = await deployer.setV2.deployCompClaimAdapter(compoundSetup.comptroller.address);
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.claimModule.address,
      "CompClaimAdapter",
      compClaimAdapter.address,
    );

    compoundWrapAdapter = await deployer.setV2.deployCompoundWrapAdapter();
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModule.address,
      "CompoundWrapAdapter",
      compoundWrapAdapter.address,
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address],
      [ether(1)],
      [
        setV2Setup.debtIssuanceModule.address,
        setV2Setup.tradeModule.address,
        setV2Setup.wrapModule.address,
        setV2Setup.airdropModule.address,
        setV2Setup.claimModule.address,
      ]
    );

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManager(
      setToken.address,
      operator.address,
      methodologist.address
    );

    const airdropSettings = {
      airdrops: [compoundSetup.comp.address],
      feeRecipient: baseManagerV2.address,
      airdropFee: ether(1),
      anyoneAbsorb: true,
    };

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(.1),
      ether(.01),
      ether(.005),
      baseManagerV2.address,
      ADDRESS_ZERO
    );
    await setV2Setup.tradeModule.initialize(setToken.address, { gasLimit: 200000 });
    await setV2Setup.wrapModule.initialize(setToken.address, { gasLimit: 200000 });
    await setV2Setup.airdropModule.initialize(setToken.address, airdropSettings, { gasLimit: 500000 });
    await setV2Setup.claimModule.initialize(setToken.address, true, [compoundSetup.comptroller.address], ["CompClaimAdapter"], { gasLimit: 500000 });
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectCollateralAsset: Address;
    let subjectCollateralCToken: Address;
    let subjectComptroller: Address;
    let subjectCompToken: Address;
    let subjectCEther: Address;
    let subjectModuleSettings: ModuleSettings;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectCollateralAsset = setV2Setup.weth.address;
      subjectCollateralCToken = cEther.address;
      subjectComptroller = compoundSetup.comptroller.address;
      subjectCompToken = compoundSetup.comp.address;
      subjectCEther = cEther.address;
      subjectModuleSettings = {
        claimModule: setV2Setup.claimModule.address,
        claimAdapterName: "CompClaimAdapter",
        airdropModule: setV2Setup.airdropModule.address,
        wrapModule: setV2Setup.wrapModule.address,
        wrapAdapterName: "CompoundWrapAdapter",
        tradeModule: setV2Setup.tradeModule.address,
        exchangeAdapterName: "TradeAdapterMock",
        exchangeData: EMPTY_BYTES,
      } as ModuleSettings;
    });

    async function subject(): Promise<COMPReinvestmentExtension> {
      return await deployer.adapters.deployCOMPReinvestmentExtension(
        subjectManager,
        subjectCollateralAsset,
        subjectCollateralCToken,
        subjectComptroller,
        subjectCompToken,
        subjectCEther,
        subjectModuleSettings,
      );
    }

    it("should set the correct SetToken address", async () => {
      const compReinvestmentExtension = await subject();

      const actualToken = await compReinvestmentExtension.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const compReinvestmentExtension = await subject();

      const actualManager = await compReinvestmentExtension.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct collateral asset address", async () => {
      const compReinvestmentExtension = await subject();

      const actualCollateralAsset = await compReinvestmentExtension.collateralAsset();
      expect(actualCollateralAsset).to.eq(subjectCollateralAsset);
    });

    it("should set the correct collateral cToken address", async () => {
      const compReinvestmentExtension = await subject();

      const actualCollateralCToken = await compReinvestmentExtension.collateralCToken();
      expect(actualCollateralCToken).to.eq(subjectCollateralCToken);
    });

    it("should set the correct comptroller address", async () => {
      const compReinvestmentExtension = await subject();

      const actualComptroller = await compReinvestmentExtension.comptroller();
      expect(actualComptroller).to.eq(subjectComptroller);
    });

    it("should set the correct COMP address", async () => {
      const compReinvestmentExtension = await subject();

      const actualCompToken = await compReinvestmentExtension.compToken();
      expect(actualCompToken).to.eq(subjectCompToken);
    });

    it("should set the correct cETH address", async () => {
      const compReinvestmentExtension = await subject();

      const actualCEther = await compReinvestmentExtension.cEther();
      expect(actualCEther).to.eq(subjectCEther);
    });

    it("should set the correct module settings", async () => {
      const compReinvestmentExtension = await subject();

      const actualModuleSettings = await compReinvestmentExtension.moduleSettings();

      expect(actualModuleSettings.claimModule).to.eq(subjectModuleSettings.claimModule);
      expect(actualModuleSettings.claimAdapterName).to.eq(subjectModuleSettings.claimModule);
      expect(actualModuleSettings.wrapModule).to.eq(subjectModuleSettings.wrapModule);
      expect(actualModuleSettings.wrapAdapterName).to.eq(subjectModuleSettings.wrapAdapterName);
      expect(actualModuleSettings.airdropModule).to.eq(subjectModuleSettings.airdropModule);
      expect(actualModuleSettings.tradeModule).to.eq(subjectModuleSettings.tradeModule);
      expect(actualModuleSettings.exchangeAdapterName).to.eq(subjectModuleSettings.exchangeAdapterName);
      expect(actualModuleSettings.exchangeData).to.eq(subjectModuleSettings.exchangeData);
    });
  });

  // context("when reinvestment adapter is deployed and system fully set up", async () => {
  //   const operatorSplit: BigNumber = ether(.7);

  //   beforeEach(async () => {
  //     compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
  //       baseManagerV2.address,
  //       setV2Setup.streamingFeeModule.address,
  //       setV2Setup.debtIssuanceModule.address,
  //       operatorSplit
  //     );

  //     await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

  //     // Transfer ownership to BaseManager
  //     await setToken.setManager(baseManagerV2.address);
  //   });

  //   describe("#accrueFeesAndDistribute", async () => {
  //     let mintedTokens: BigNumber;
  //     const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

  //     beforeEach(async () => {
  //       mintedTokens = ether(2);
  //       await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
  //       await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

  //       await increaseTimeAsync(timeFastForward);
  //     });

  //     async function subject(): Promise<ContractTransaction> {
  //       return await compReinvestmentExtension.accrueFeesAndDistribute();
  //     }

  //     it("should send correct amount of fees to operator and methodologist", async () => {
  //       const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //       const totalSupply = await setToken.totalSupply();

  //       const txnTimestamp = await getTransactionTimestamp(subject());

  //       const expectedFeeInflation = await getStreamingFee(
  //         setV2Setup.streamingFeeModule,
  //         setToken.address,
  //         feeState.lastStreamingFeeTimestamp,
  //         txnTimestamp
  //       );

  //       const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

  //       const expectedMintRedeemFees = preciseMul(mintedTokens, ether(.01));
  //       const expectedOperatorTake = preciseMul(feeInflation.add(expectedMintRedeemFees), operatorSplit);
  //       const expectedMethodologistTake = feeInflation.add(expectedMintRedeemFees).sub(expectedOperatorTake);

  //       const operatorBalance = await setToken.balanceOf(operator.address);
  //       const methodologistBalance = await setToken.balanceOf(methodologist.address);

  //       expect(operatorBalance).to.eq(expectedOperatorTake);
  //       expect(methodologistBalance).to.eq(expectedMethodologistTake);
  //     });

  //     it("should emit a FeesAccrued event", async () => {
  //       await expect(subject()).to.emit(compReinvestmentExtension, "FeesAccrued");
  //     });

  //     describe("when methodologist fees are 0", async () => {
  //       beforeEach(async () => {
  //         await compReinvestmentExtension.connect(operator.wallet).updateFeeSplit(ether(1));
  //       });

  //       it("should not send fees to methodologist", async () => {
  //         const preMethodologistBalance = await setToken.balanceOf(methodologist.address);

  //         await subject();

  //         const postMethodologistBalance = await setToken.balanceOf(methodologist.address);
  //         expect(postMethodologistBalance.sub(preMethodologistBalance)).to.eq(ZERO);
  //       });
  //     });

  //     describe("when operator fees are 0", async () => {
  //       beforeEach(async () => {
  //         await compReinvestmentExtension.connect(operator.wallet).updateFeeSplit(ZERO);
  //       });

  //       it("should not send fees to operator", async () => {
  //         const preOperatorBalance = await setToken.balanceOf(operator.address);

  //         await subject();

  //         const postOperatorBalance = await setToken.balanceOf(operator.address);
  //         expect(postOperatorBalance.sub(preOperatorBalance)).to.eq(ZERO);
  //       });
  //     });
  //   });

  //   describe("#updateStreamingFee", async () => {
  //     let mintedTokens: BigNumber;
  //     const timeFastForward: BigNumber = ONE_YEAR_IN_SECONDS;

  //     let subjectNewFee: BigNumber;
  //     let subjectCaller: Account;

  //     beforeEach(async () => {
  //       mintedTokens = ether(2);
  //       await setV2Setup.dai.approve(setV2Setup.debtIssuanceModule.address, ether(3));
  //       await setV2Setup.debtIssuanceModule.issue(setToken.address, mintedTokens, owner.address);

  //       await increaseTimeAsync(timeFastForward);

  //       subjectNewFee = ether(.01);
  //       subjectCaller = operator;
  //     });

  //     async function subject(): Promise<ContractTransaction> {
  //       return await compReinvestmentExtension.connect(subjectCaller.wallet).updateStreamingFee(subjectNewFee);
  //     }
  //     context("when no timelock period has been set", async () => {
  //       it("should update the streaming fee", async () => {
  //         await subject();

  //         const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);

  //         expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
  //       });

  //       it("should send correct amount of fees to operator and methodologist", async () => {
  //         const preManagerBalance = await setToken.balanceOf(baseManagerV2.address);
  //         const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //         const totalSupply = await setToken.totalSupply();

  //         const txnTimestamp = await getTransactionTimestamp(subject());

  //         const expectedFeeInflation = await getStreamingFee(
  //           setV2Setup.streamingFeeModule,
  //           setToken.address,
  //           feeState.lastStreamingFeeTimestamp,
  //           txnTimestamp,
  //           ether(.02)
  //         );

  //         const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

  //         const postManagerBalance = await setToken.balanceOf(baseManagerV2.address);

  //         expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
  //       });
  //     });

  //     context("when 1 day timelock period has been set", async () => {
  //       beforeEach(async () => {
  //         await compReinvestmentExtension.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
  //       });

  //       it("sets the upgradeHash", async () => {
  //         await subject();
  //         const timestamp = await getLastBlockTimestamp();
  //         const calldata = compReinvestmentExtension.interface.encodeFunctionData("updateStreamingFee", [subjectNewFee]);
  //         const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
  //         const actualTimestamp = await compReinvestmentExtension.timeLockedUpgrades(upgradeHash);
  //         expect(actualTimestamp).to.eq(timestamp);
  //       });

  //       context("when 1 day timelock has elapsed", async () => {
  //         beforeEach(async () => {
  //           await subject();
  //           await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
  //         });

  //         it("should update the streaming fee", async () => {
  //           await subject();

  //           const feeState = await setV2Setup.streamingFeeModule.feeStates(setToken.address);

  //           expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
  //         });

  //         it("should send correct amount of fees to operator and methodologist", async () => {
  //           const preManagerBalance = await setToken.balanceOf(baseManagerV2.address);
  //           const feeState: any = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //           const totalSupply = await setToken.totalSupply();

  //           const txnTimestamp = await getTransactionTimestamp(subject());

  //           const expectedFeeInflation = await getStreamingFee(
  //             setV2Setup.streamingFeeModule,
  //             setToken.address,
  //             feeState.lastStreamingFeeTimestamp,
  //             txnTimestamp,
  //             ether(.02)
  //           );

  //           const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

  //           const postManagerBalance = await setToken.balanceOf(baseManagerV2.address);

  //           expect(postManagerBalance.sub(preManagerBalance)).to.eq(feeInflation);
  //         });
  //       });
  //     });

  //     describe("when the caller is not the operator", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = methodologist;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be operator");
  //       });
  //     });
  //   });

  //   describe("#updateIssueFee", async () => {
  //     let subjectNewFee: BigNumber;
  //     let subjectCaller: Account;

  //     beforeEach(async () => {
  //       subjectNewFee = ether(.02);
  //       subjectCaller = operator;
  //     });

  //     async function subject(): Promise<ContractTransaction> {
  //       return await compReinvestmentExtension.connect(subjectCaller.wallet).updateIssueFee(subjectNewFee);
  //     }

  //     context("when no timelock period has been set", async () => {
  //       it("should update the issue fee", async () => {
  //         await subject();

  //         const issueState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

  //         expect(issueState.managerIssueFee).to.eq(subjectNewFee);
  //       });
  //     });

  //     context("when 1 day timelock period has been set", async () => {
  //       beforeEach(async () => {
  //         await compReinvestmentExtension.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
  //       });

  //       it("sets the upgradeHash", async () => {
  //         await subject();
  //         const timestamp = await getLastBlockTimestamp();
  //         const calldata = compReinvestmentExtension.interface.encodeFunctionData("updateIssueFee", [subjectNewFee]);
  //         const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
  //         const actualTimestamp = await compReinvestmentExtension.timeLockedUpgrades(upgradeHash);
  //         expect(actualTimestamp).to.eq(timestamp);
  //       });

  //       context("when 1 day timelock has elapsed", async () => {
  //         beforeEach(async () => {
  //           await subject();
  //           await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
  //         });

  //         it("sets the new streaming fee", async () => {
  //           await subject();
  //           const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //           const newStreamingFee = feeStates.streamingFeePercentage;

  //           expect(newStreamingFee).to.eq(subjectNewFee);
  //         });

  //         it("sets the upgradeHash to 0", async () => {
  //           await subject();
  //           const calldata = compReinvestmentExtension.interface.encodeFunctionData("updateIssueFee", [subjectNewFee]);
  //           const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
  //           const actualTimestamp = await compReinvestmentExtension.timeLockedUpgrades(upgradeHash);
  //           expect(actualTimestamp).to.eq(ZERO);
  //         });
  //       });
  //     });

  //     describe("when the caller is not the operator", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = methodologist;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be operator");
  //       });
  //     });
  //   });

  //   describe("#updateRedeemFee", async () => {
  //     let subjectNewFee: BigNumber;
  //     let subjectCaller: Account;

  //     beforeEach(async () => {
  //       subjectNewFee = ether(.02);
  //       subjectCaller = operator;
  //     });

  //     async function subject(): Promise<ContractTransaction> {
  //       return await compReinvestmentExtension.connect(subjectCaller.wallet).updateRedeemFee(subjectNewFee);
  //     }

  //     context("when no timelock period has been set", async () => {
  //       it("should update the redeem fee", async () => {
  //         await subject();

  //         const issuanceState: any = await setV2Setup.debtIssuanceModule.issuanceSettings(setToken.address);

  //         expect(issuanceState.managerRedeemFee).to.eq(subjectNewFee);
  //       });
  //     });

  //     context("when 1 day timelock period has been set", async () => {
  //       beforeEach(async () => {
  //         await compReinvestmentExtension.connect(owner.wallet).setTimeLockPeriod(ONE_DAY_IN_SECONDS);
  //       });

  //       it("sets the upgradeHash", async () => {
  //         await subject();
  //         const timestamp = await getLastBlockTimestamp();
  //         const calldata = compReinvestmentExtension.interface.encodeFunctionData("updateRedeemFee", [subjectNewFee]);
  //         const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
  //         const actualTimestamp = await compReinvestmentExtension.timeLockedUpgrades(upgradeHash);
  //         expect(actualTimestamp).to.eq(timestamp);
  //       });

  //       context("when 1 day timelock has elapsed", async () => {
  //         beforeEach(async () => {
  //           await subject();
  //           await increaseTimeAsync(ONE_DAY_IN_SECONDS.add(1));
  //         });

  //         it("sets the new streaming fee", async () => {
  //           await subject();
  //           const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
  //           const newStreamingFee = feeStates.streamingFeePercentage;

  //           expect(newStreamingFee).to.eq(subjectNewFee);
  //         });

  //         it("sets the upgradeHash to 0", async () => {
  //           await subject();
  //           const calldata = compReinvestmentExtension.interface.encodeFunctionData("updateRedeemFee", [subjectNewFee]);
  //           const upgradeHash = solidityKeccak256(["bytes"], [calldata]);
  //           const actualTimestamp = await compReinvestmentExtension.timeLockedUpgrades(upgradeHash);
  //           expect(actualTimestamp).to.eq(ZERO);
  //         });
  //       });
  //     });

  //     describe("when the caller is not the operator", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = methodologist;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be operator");
  //       });
  //     });
  //   });
  // });
});