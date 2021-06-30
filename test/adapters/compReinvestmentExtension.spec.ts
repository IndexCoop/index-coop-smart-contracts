import "module-alias/register";

import { Address, Account, ReapSettings } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ZERO } from "@utils/constants";
import { COMPReinvestmentExtension, BaseManager, TradeAdapterMock } from "@utils/contracts/index";
import { CompoundWrapAdapter, ComptrollerMock, CompClaimAdapter, ContractCallerMock, SetToken } from "@utils/contracts/setV2";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getCompoundFixture,
  getRandomAccount,
  getRandomAddress,
  getSetFixture,
  getWaffleExpect,
  preciseMul,
  preciseDiv,
} from "@utils/index";
import { CompoundFixture, SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("COMPReinvestmentExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let setV2Setup: SetFixture;
  let compoundSetup: CompoundFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let cEther: CEther;
  let cComp: CERc20;
  let compClaimAdapter: CompClaimAdapter;
  let compoundWrapAdapter: CompoundWrapAdapter;
  let tradeAdapterMock: TradeAdapterMock;
  let comptrollerMock: ComptrollerMock;

  let baseManagerV2: BaseManager;
  let compReinvestmentExtension: COMPReinvestmentExtension;

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

    cComp = await compoundSetup.createAndEnableCToken(
      compoundSetup.comp.address,
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound COMP",
      "cComp",
      8,
      ether(0.75), // 75% collateral factor
      ether(300) // $300
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cComp.address]);

    // Mint cTokens
    await compoundSetup.comp.approve(cComp.address, ether(100000));
    await cComp.mint(ether(1));
    await cEther.mint({value: ether(1000)});

    // Deploy mock trade adapter
    tradeAdapterMock = await deployer.mocks.deployTradeAdapterMock();
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.tradeModule.address,
      "MockTradeAdapter",
      tradeAdapterMock.address,
    );

    // Deploy Comptroller Mock
    comptrollerMock = await deployer.setV2.deployComptrollerMock(compoundSetup.comp.address, ether(1), cEther.address);

    compClaimAdapter = await deployer.setV2.deployCompClaimAdapter(comptrollerMock.address);
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
      [setV2Setup.weth.address, cEther.address, cComp.address],
      [ether(1), BigNumber.from(5000000000), BigNumber.from(5000000000)],
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

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(.1),
      ZERO,
      ZERO,
      baseManagerV2.address,
      ADDRESS_ZERO
    );

    // Transfer ownership to BaseManager
    await setToken.setManager(baseManagerV2.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectCollateralAsset: Address;
    let subjectCollateralCToken: Address;
    let subjectComptroller: Address;
    let subjectCompToken: Address;
    let subjectCEther: Address;
    let subjectReapSettings: ReapSettings;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectCollateralAsset = setV2Setup.weth.address;
      subjectCollateralCToken = cEther.address;
      subjectComptroller = compoundSetup.comptroller.address;
      subjectCompToken = compoundSetup.comp.address;
      subjectCEther = cEther.address;
      subjectReapSettings = {
        claimModule: setV2Setup.claimModule.address,
        claimAdapterName: "CompClaimAdapter",
        airdropModule: setV2Setup.airdropModule.address,
        wrapModule: setV2Setup.wrapModule.address,
        wrapAdapterName: "CompoundWrapAdapter",
        tradeModule: setV2Setup.tradeModule.address,
        exchangeAdapterName: "MockTradeAdapter",
        exchangeData: EMPTY_BYTES,
      } as ReapSettings;
    });

    async function subject(): Promise<COMPReinvestmentExtension> {
      return await deployer.adapters.deployCOMPReinvestmentExtension(
        subjectManager,
        subjectCollateralAsset,
        subjectCollateralCToken,
        subjectComptroller,
        subjectCompToken,
        subjectCEther,
        subjectReapSettings,
      );
    }

    it("should set the correct SetToken address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualToken = await returnedCompReinvestmentExtension.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualManager = await returnedCompReinvestmentExtension.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct collateral asset address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualCollateralAsset = await returnedCompReinvestmentExtension.collateralAsset();
      expect(actualCollateralAsset).to.eq(subjectCollateralAsset);
    });

    it("should set the correct collateral cToken address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualCollateralCToken = await returnedCompReinvestmentExtension.collateralCToken();
      expect(actualCollateralCToken).to.eq(subjectCollateralCToken);
    });

    it("should set the correct comptroller address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualComptroller = await returnedCompReinvestmentExtension.comptroller();
      expect(actualComptroller).to.eq(subjectComptroller);
    });

    it("should set the correct COMP address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualCompToken = await returnedCompReinvestmentExtension.compToken();
      expect(actualCompToken).to.eq(subjectCompToken);
    });

    it("should set the correct cETH address", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualCEther = await returnedCompReinvestmentExtension.cEther();
      expect(actualCEther).to.eq(subjectCEther);
    });

    it("should set the correct reap settings", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualReapSettings = await returnedCompReinvestmentExtension.reapSettings();

      expect(actualReapSettings.claimModule).to.eq(subjectReapSettings.claimModule);
      expect(actualReapSettings.claimAdapterName).to.eq(subjectReapSettings.claimAdapterName);
      expect(actualReapSettings.wrapModule).to.eq(subjectReapSettings.wrapModule);
      expect(actualReapSettings.wrapAdapterName).to.eq(subjectReapSettings.wrapAdapterName);
      expect(actualReapSettings.airdropModule).to.eq(subjectReapSettings.airdropModule);
      expect(actualReapSettings.tradeModule).to.eq(subjectReapSettings.tradeModule);
      expect(actualReapSettings.exchangeAdapterName).to.eq(subjectReapSettings.exchangeAdapterName);
      expect(actualReapSettings.exchangeData).to.eq(subjectReapSettings.exchangeData);
    });
  });

  describe("#reap", async () => {
    context("when collateral cToken is cEther", async () => {
      let reapSettings: ReapSettings;
      let collateralAssetNotional: BigNumber;
      let compAccrued: BigNumber;
      let airdropFee: BigNumber;

      beforeEach(async () => {
        reapSettings = {
          claimModule: setV2Setup.claimModule.address,
          claimAdapterName: "CompClaimAdapter",
          airdropModule: setV2Setup.airdropModule.address,
          wrapModule: setV2Setup.wrapModule.address,
          wrapAdapterName: "CompoundWrapAdapter",
          tradeModule: setV2Setup.tradeModule.address,
          exchangeAdapterName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };

        compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
          baseManagerV2.address,
          setV2Setup.weth.address,
          cEther.address,
          comptrollerMock.address, // Use Comptroller Mock which allows us to specify COMP amount
          compoundSetup.comp.address,
          cEther.address,
          reapSettings
        );

        await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

        // Initialize modules
        airdropFee = ether(0.5);
        await compReinvestmentExtension.connect(operator.wallet).initializeModules(airdropFee);

        await setV2Setup.weth.approve(setV2Setup.debtIssuanceModule.address, ether(1));
        await cEther.approve(setV2Setup.debtIssuanceModule.address, ether(1));
        await cComp.approve(setV2Setup.debtIssuanceModule.address, ether(1));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, ether(1), owner.address);

        // Transfer 1 WETH to exchange
        collateralAssetNotional = ether(1);
        await setV2Setup.weth.transfer(tradeAdapterMock.address, collateralAssetNotional);

        // Set up Comptroller Mock
        compAccrued = ether(1);
        await comptrollerMock.addSetTokenAddress(setToken.address, { gasLimit: 500000 });
        await comptrollerMock.setCompAccrued(setToken.address, compAccrued, { gasLimit: 500000 });
        await compoundSetup.comp.transfer(comptrollerMock.address, compAccrued);
      });

      async function subject(): Promise<ContractTransaction> {
        return await compReinvestmentExtension.reap();
      }

      it("should accrue the correct amount of COMP to the fee recipient", async () => {
        const previousOperatorCOMPBalance = await compoundSetup.comp.balanceOf(operator.address);

        await subject();

        const currentOperatorCOMPBalance = await compoundSetup.comp.balanceOf(operator.address);
        const expectedOperatoCOMPBalance = preciseMul(compAccrued, airdropFee);

        expect(previousOperatorCOMPBalance).to.eq(ZERO);
        expect(expectedOperatoCOMPBalance).to.eq(currentOperatorCOMPBalance);
      });

      it("should update the units correctly on the SetToken", async () => {
        const previousCollateralCTokenUnits = await setToken.getDefaultPositionRealUnit(cEther.address);
        const previousCollateralUnderlyingUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
        const previousCOMPUnits = await setToken.getDefaultPositionRealUnit(compoundSetup.comp.address);

        await subject();

        const currentCollateralCTokenUnits = await setToken.getDefaultPositionRealUnit(cEther.address);
        const exchangeRate = await cEther.exchangeRateStored();
        const newUnits = preciseDiv(collateralAssetNotional, exchangeRate);
        const expectedCollateralCTokenUnits = previousCollateralCTokenUnits.add(newUnits);
        const currentCollateralUnderlyingUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
        const currentCOMPUnits = await setToken.getDefaultPositionRealUnit(compoundSetup.comp.address);

        expect(currentCollateralCTokenUnits).to.eq(expectedCollateralCTokenUnits);
        expect(previousCollateralUnderlyingUnits).to.eq(currentCollateralUnderlyingUnits);
        expect(previousCOMPUnits).to.eq(currentCOMPUnits);
      });

      it("should emit COMPReaped event", async () => {
        await expect(subject()).to.emit(compReinvestmentExtension, "COMPReaped").withArgs(
          preciseMul(compAccrued, airdropFee),
          collateralAssetNotional,
          owner.address,
        );
      });

      describe("when absorb fee is 100%", async () => {
        beforeEach(async () => {
          await compReinvestmentExtension.connect(operator.wallet).updateAirdropFee(ether(1));
        });

        it("should accrue the correct amount of COMP to the fee recipient", async () => {
          const previousOperatorCOMPBalance = await compoundSetup.comp.balanceOf(operator.address);
          await subject();

          const currentOperatorCOMPBalance = await compoundSetup.comp.balanceOf(operator.address);

          expect(previousOperatorCOMPBalance).to.eq(ZERO);
          expect(compAccrued).to.eq(currentOperatorCOMPBalance);
        });

        it("should update the units correctly on the SetToken", async () => {
          const previousCollateralCTokenUnits = await setToken.getDefaultPositionRealUnit(cEther.address);
          const previousCollateralUnderlyingUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
          const previousCOMPUnits = await setToken.getDefaultPositionRealUnit(compoundSetup.comp.address);

          await subject();

          const currentCollateralCTokenUnits = await setToken.getDefaultPositionRealUnit(cEther.address);
          const currentCollateralUnderlyingUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
          const currentCOMPUnits = await setToken.getDefaultPositionRealUnit(compoundSetup.comp.address);

          expect(previousCollateralCTokenUnits).to.eq(currentCollateralCTokenUnits);
          expect(previousCollateralUnderlyingUnits).to.eq(currentCollateralUnderlyingUnits);
          expect(previousCOMPUnits).to.eq(currentCOMPUnits);
        });
      });

      describe("when caller is a contract", async () => {
        let subjectTarget: Address;
        let subjectCallData: string;
        let subjectValue: BigNumber;

        let contractCaller: ContractCallerMock;

        beforeEach(async () => {
          contractCaller = await deployer.setV2.deployContractCallerMock();

          subjectTarget = compReinvestmentExtension.address;
          subjectCallData = compReinvestmentExtension.interface.encodeFunctionData("reap");
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

    context("when collateral cToken is cCOMP", async () => {
      let reapSettings: ReapSettings;

      beforeEach(async () => {
        reapSettings = {
          claimModule: setV2Setup.claimModule.address,
          claimAdapterName: "CompClaimAdapter",
          airdropModule: setV2Setup.airdropModule.address,
          wrapModule: setV2Setup.wrapModule.address,
          wrapAdapterName: "CompoundWrapAdapter",
          tradeModule: setV2Setup.tradeModule.address,
          exchangeAdapterName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };

        compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
          baseManagerV2.address,
          compoundSetup.comp.address,
          cComp.address,
          comptrollerMock.address, // Use Comptroller Mock which allows us to specify COMP amount
          compoundSetup.comp.address,
          cEther.address,
          reapSettings
        );

        await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

        // Initialize modules
        airdropFee = ether(0.5);
        await compReinvestmentExtension.connect(operator.wallet).initializeModules(airdropFee);

        await setV2Setup.weth.approve(setV2Setup.debtIssuanceModule.address, ether(1));
        await cEther.approve(setV2Setup.debtIssuanceModule.address, ether(1));
        await cComp.approve(setV2Setup.debtIssuanceModule.address, ether(1));
        await setV2Setup.debtIssuanceModule.issue(setToken.address, ether(1), owner.address);

        // Set up Comptroller Mock
        compAccrued = ether(1);
        await comptrollerMock.addSetTokenAddress(setToken.address, { gasLimit: 500000 });
        await comptrollerMock.setCompAccrued(setToken.address, compAccrued, { gasLimit: 500000 });
        await compoundSetup.comp.transfer(comptrollerMock.address, compAccrued);
      });

      async function subject(): Promise<ContractTransaction> {
        return await compReinvestmentExtension.reap();
      }

      it("should accrue the correct amount of COMP to the fee recipient", async () => {
        const previousOperatorCOMPBalance = await compoundSetup.comp.balanceOf(operator.address);

        await subject();

        const currentOperatorCOMPBalance = await compoundSetup.comp.balanceOf(operator.address);
        const expectedOperatoCOMPBalance = preciseMul(compAccrued, airdropFee);

        expect(previousOperatorCOMPBalance).to.eq(ZERO);
        expect(expectedOperatoCOMPBalance).to.eq(currentOperatorCOMPBalance);
      });

      it("should update the units correctly on the SetToken", async () => {
        const previousCollateralCTokenUnits = await setToken.getDefaultPositionRealUnit(cComp.address);
        const previousCollateralUnderlyingUnits = await setToken.getDefaultPositionRealUnit(compoundSetup.comp.address);

        await subject();

        const currentCollateralCTokenUnits = await setToken.getDefaultPositionRealUnit(cComp.address);
        const exchangeRate = await cComp.exchangeRateStored();
        // New units is calculated by total accrued COMP (net of fees) divded by the cCOMP exchange rate
        const newUnits = preciseDiv(preciseMul(compAccrued, ether(1).sub(airdropFee)), exchangeRate);
        const expectedCollateralCTokenUnits = previousCollateralCTokenUnits.add(newUnits);
        const currentCollateralUnderlyingUnits = await setToken.getDefaultPositionRealUnit(compoundSetup.comp.address);

        expect(currentCollateralCTokenUnits).to.eq(expectedCollateralCTokenUnits);
        expect(previousCollateralUnderlyingUnits).to.eq(currentCollateralUnderlyingUnits);
      });

      describe("when mint returns a nonzero value on Compound. Will be a transaction success but returns an error code", async () => {
        beforeEach(async () => {
          const newComptroller = await deployer.external.deployComptroller();

          await cComp._setComptroller(newComptroller.address);
        });

        afterEach(async () => {
          await cComp._setComptroller(compoundSetup.comptroller.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Wrap failed on Compound");
        });
      });
    });
  });

  describe("#initializeModules", async () => {
    context("when collateral cToken is cEther", async () => {
      let reapSettings: ReapSettings;

      let subjectAirdropFee: BigNumber;
      let subjectCaller: Account;

      beforeEach(async () => {
        reapSettings = {
          claimModule: setV2Setup.claimModule.address,
          claimAdapterName: "CompClaimAdapter",
          airdropModule: setV2Setup.airdropModule.address,
          wrapModule: setV2Setup.wrapModule.address,
          wrapAdapterName: "CompoundWrapAdapter",
          tradeModule: setV2Setup.tradeModule.address,
          exchangeAdapterName: "MockTradeAdapter",
          exchangeData: EMPTY_BYTES,
        };

        compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
          baseManagerV2.address,
          setV2Setup.weth.address,
          cEther.address,
          comptrollerMock.address, // Use Comptroller Mock which allows us to specify COMP amount
          compoundSetup.comp.address,
          cEther.address,
          reapSettings
        );

        await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

        subjectAirdropFee = ether(0.5); // 50%
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await compReinvestmentExtension.connect(subjectCaller.wallet).initializeModules(subjectAirdropFee);
      }

      it("should initialize the AirdropModule on the SetToken", async () => {
        await subject();
        const isAirdropModuleInitialized = await setToken.isInitializedModule(setV2Setup.airdropModule.address);

        expect(isAirdropModuleInitialized).to.be.true;
      });

      it("should initialize the TradeModule on the SetToken", async () => {
        await subject();
        const isTradeModuleInitialized = await setToken.isInitializedModule(setV2Setup.tradeModule.address);

        expect(isTradeModuleInitialized).to.be.true;
      });

      it("should initialize the WrapModule on the SetToken", async () => {
        await subject();
        const isWrapModuleInitialized = await setToken.isInitializedModule(setV2Setup.wrapModule.address);

        expect(isWrapModuleInitialized).to.be.true;
      });

      it("should initialize the ClaimModule on the SetToken", async () => {
        await subject();
        const isClaimModuleInitialized = await setToken.isInitializedModule(setV2Setup.claimModule.address);

        expect(isClaimModuleInitialized).to.be.true;
      });

      it("should set the AirdropModule fee correctly", async () => {
        await subject();
        const actualAirdropSettings = await setV2Setup.airdropModule.airdropSettings(setToken.address);

        expect(actualAirdropSettings.airdropFee).to.eq(subjectAirdropFee);
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
  });

  describe("#setReapSettings", async () => {
    let subjectReapSettings: ReapSettings;
    let subjectCaller: Account;

    beforeEach(async () => {
      const initialReapSettings = {
        claimModule: setV2Setup.claimModule.address,
        claimAdapterName: "CompClaimAdapter",
        airdropModule: setV2Setup.airdropModule.address,
        wrapModule: setV2Setup.wrapModule.address,
        wrapAdapterName: "CompoundWrapAdapter",
        tradeModule: setV2Setup.tradeModule.address,
        exchangeAdapterName: "MockTradeAdapter",
        exchangeData: EMPTY_BYTES,
      };

      compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
        baseManagerV2.address,
        setV2Setup.weth.address,
        cEther.address,
        comptrollerMock.address, // Use Comptroller Mock which allows us to specify COMP amount
        compoundSetup.comp.address,
        cEther.address,
        initialReapSettings
      );

      await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

      subjectReapSettings = {
        claimModule: await getRandomAddress(),
        claimAdapterName: "CompClaimAdapter2",
        airdropModule: await getRandomAddress(),
        wrapModule: await getRandomAddress(),
        wrapAdapterName: "CompoundWrapAdapter2",
        tradeModule: await getRandomAddress(),
        exchangeAdapterName: "MockTradeAdapter2",
        exchangeData: "0x01",
      };
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return await compReinvestmentExtension.connect(subjectCaller.wallet).setReapSettings(subjectReapSettings);
    }

    it("should set the correct reap settings", async () => {
      await subject();
      const actualReapSettings = await compReinvestmentExtension.reapSettings();

      expect(actualReapSettings.claimModule).to.eq(subjectReapSettings.claimModule);
      expect(actualReapSettings.claimAdapterName).to.eq(subjectReapSettings.claimAdapterName);
      expect(actualReapSettings.wrapModule).to.eq(subjectReapSettings.wrapModule);
      expect(actualReapSettings.wrapAdapterName).to.eq(subjectReapSettings.wrapAdapterName);
      expect(actualReapSettings.airdropModule).to.eq(subjectReapSettings.airdropModule);
      expect(actualReapSettings.tradeModule).to.eq(subjectReapSettings.tradeModule);
      expect(actualReapSettings.exchangeAdapterName).to.eq(subjectReapSettings.exchangeAdapterName);
      expect(actualReapSettings.exchangeData).to.eq(subjectReapSettings.exchangeData);
    });

    it("should emit ReapSettingsUpdated event", async () => {
      await expect(subject()).to.emit(compReinvestmentExtension, "ReapSettingsUpdated").withArgs(
        subjectReapSettings.claimModule,
        subjectReapSettings.claimAdapterName,
        subjectReapSettings.airdropModule,
        subjectReapSettings.wrapModule,
        subjectReapSettings.wrapAdapterName,
        subjectReapSettings.tradeModule,
        subjectReapSettings.exchangeAdapterName,
        subjectReapSettings.exchangeData,
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
  });

  describe("#updateAirdropFee", async () => {
    let subjectAirdropFee: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      const initialReapSettings = {
        claimModule: setV2Setup.claimModule.address,
        claimAdapterName: "CompClaimAdapter",
        airdropModule: setV2Setup.airdropModule.address,
        wrapModule: setV2Setup.wrapModule.address,
        wrapAdapterName: "CompoundWrapAdapter",
        tradeModule: setV2Setup.tradeModule.address,
        exchangeAdapterName: "MockTradeAdapter",
        exchangeData: EMPTY_BYTES,
      };

      compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
        baseManagerV2.address,
        setV2Setup.weth.address,
        cEther.address,
        comptrollerMock.address, // Use Comptroller Mock which allows us to specify COMP amount
        compoundSetup.comp.address,
        cEther.address,
        initialReapSettings
      );

      await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

      // Initialize modules
      await compReinvestmentExtension.connect(operator.wallet).initializeModules(ether(0.5));

      subjectAirdropFee = ether(0);
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return await compReinvestmentExtension.connect(subjectCaller.wallet).updateAirdropFee(subjectAirdropFee);
    }

    it("should set the AirdropModule fee correctly", async () => {
      await subject();
      const actualAirdropSettings = await setV2Setup.airdropModule.airdropSettings(setToken.address);

      expect(actualAirdropSettings.airdropFee).to.eq(subjectAirdropFee);
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

  describe("#updateAirdropFeeRecipient", async () => {
    let subjectAirdropFeeRecipient: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const initialReapSettings = {
        claimModule: setV2Setup.claimModule.address,
        claimAdapterName: "CompClaimAdapter",
        airdropModule: setV2Setup.airdropModule.address,
        wrapModule: setV2Setup.wrapModule.address,
        wrapAdapterName: "CompoundWrapAdapter",
        tradeModule: setV2Setup.tradeModule.address,
        exchangeAdapterName: "MockTradeAdapter",
        exchangeData: EMPTY_BYTES,
      };

      compReinvestmentExtension = await deployer.adapters.deployCOMPReinvestmentExtension(
        baseManagerV2.address,
        setV2Setup.weth.address,
        cEther.address,
        comptrollerMock.address, // Use Comptroller Mock which allows us to specify COMP amount
        compoundSetup.comp.address,
        cEther.address,
        initialReapSettings
      );

      await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

      // Initialize modules
      await compReinvestmentExtension.connect(operator.wallet).initializeModules(ether(0.5));

      subjectAirdropFeeRecipient = await getRandomAddress();
      subjectCaller = operator;
    });

    async function subject(): Promise<ContractTransaction> {
      return await compReinvestmentExtension.connect(subjectCaller.wallet).updateAirdropFeeRecipient(subjectAirdropFeeRecipient);
    }

    it("should set the AirdropModule fee recipient correctly", async () => {
      await subject();
      const actualAirdropSettings = await setV2Setup.airdropModule.airdropSettings(setToken.address);

      expect(actualAirdropSettings.feeRecipient).to.eq(subjectAirdropFeeRecipient);
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
});