import "module-alias/register";

import { Address, Account, AirdropSettings, ModuleSettings } from "@utils/types";
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
  getSetFixture,
  getWaffleExpect,
  preciseMul,
  preciseDiv,
} from "@utils/index";
import { CompoundFixture, SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

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
  let cComp: CERc20;
  let compClaimAdapter: CompClaimAdapter;
  let compoundWrapAdapter: CompoundWrapAdapter;
  let tradeAdapterMock: TradeAdapterMock;
  let comptrollerMock: ComptrollerMock;

  let airdropSettings: AirdropSettings;

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

    airdropSettings = {
      airdrops: [compoundSetup.comp.address],
      feeRecipient: baseManagerV2.address,
      airdropFee: ether(0.5), // 50%
      anyoneAbsorb: false,
    };

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(.1),
      ZERO,
      ZERO,
      baseManagerV2.address,
      ADDRESS_ZERO
    );
    await setV2Setup.tradeModule.initialize(setToken.address, { gasLimit: 200000 });
    await setV2Setup.wrapModule.initialize(setToken.address, { gasLimit: 200000 });
    await setV2Setup.airdropModule.initialize(setToken.address, airdropSettings, { gasLimit: 500000 });
    await setV2Setup.claimModule.initialize(setToken.address, false, [comptrollerMock.address], ["CompClaimAdapter"], { gasLimit: 500000 });
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
        exchangeAdapterName: "MockTradeAdapter",
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

    it("should set the correct module settings", async () => {
      const returnedCompReinvestmentExtension = await subject();

      const actualModuleSettings = await returnedCompReinvestmentExtension.moduleSettings();

      expect(actualModuleSettings.claimModule).to.eq(subjectModuleSettings.claimModule);
      expect(actualModuleSettings.claimAdapterName).to.eq(subjectModuleSettings.claimAdapterName);
      expect(actualModuleSettings.wrapModule).to.eq(subjectModuleSettings.wrapModule);
      expect(actualModuleSettings.wrapAdapterName).to.eq(subjectModuleSettings.wrapAdapterName);
      expect(actualModuleSettings.airdropModule).to.eq(subjectModuleSettings.airdropModule);
      expect(actualModuleSettings.tradeModule).to.eq(subjectModuleSettings.tradeModule);
      expect(actualModuleSettings.exchangeAdapterName).to.eq(subjectModuleSettings.exchangeAdapterName);
      expect(actualModuleSettings.exchangeData).to.eq(subjectModuleSettings.exchangeData);
    });
  });

  describe.only("#reap", async () => {
    context("when collateral cToken is cEther", async () => {
      let moduleSettings: ModuleSettings;
      let collateralAssetNotional: BigNumber;
      let compAccrued: BigNumber;

      beforeEach(async () => {
        moduleSettings = {
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
          moduleSettings
        );

        await baseManagerV2.connect(operator.wallet).addAdapter(compReinvestmentExtension.address);

        // Transfer ownership to BaseManager
        await setToken.setManager(baseManagerV2.address);
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
        const previousManagerCOMPBalance = await compoundSetup.comp.balanceOf(baseManagerV2.address);

        await subject();

        const currentManagerCOMPBalance = await compoundSetup.comp.balanceOf(baseManagerV2.address);
        const expectedManagerCOMPBalance = preciseMul(compAccrued, airdropSettings.airdropFee);

        expect(previousManagerCOMPBalance).to.eq(ZERO);
        expect(expectedManagerCOMPBalance).to.eq(currentManagerCOMPBalance);
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
          preciseMul(compAccrued, airdropSettings.airdropFee),
          collateralAssetNotional,
          owner.address,
        );
      });

      describe("when absorb fee is 100%", async () => {
        beforeEach(async () => {
          await compReinvestmentExtension.connect(operator.wallet).updateAirdropFee(ether(1));
        });

        it("should accrue the correct amount of COMP to the fee recipient", async () => {
          const previousManagerCOMPBalance = await compoundSetup.comp.balanceOf(setToken.address);
          await subject();

          const currentManagerCOMPBalance = await compoundSetup.comp.balanceOf(baseManagerV2.address);

          expect(previousManagerCOMPBalance).to.eq(ZERO);
          expect(compAccrued).to.eq(currentManagerCOMPBalance);
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
  });
});