import "module-alias/register";
import { Account, CustomOracleNAVIssuanceSettings, TargetWeightWrapParams } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ether, getAccounts, getWaffleExpect, usdc } from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256, ONE_DAY_IN_SECONDS, ZERO, ZERO_BYTES } from "@utils/constants";
import {
  addSnapshotBeforeRestoreAfterEach,
  increaseTimeAsync,
  setBlockNumber,
} from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import {
  BaseManagerV2,
  DebtIssuanceModuleV3,
  IERC20,
  IERC20__factory,
  SetToken,
  SetTokenCreator__factory,
  SetValuer,
  TargetWeightWrapExtension,
  RebasingComponentModule,
  Controller,
  Controller__factory,
  CustomOracleNavIssuanceModule,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetToken__factory,
  WrapModuleV2,
} from "../../../typechain";

const expect = getWaffleExpect();

const contractAddresses = {
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  protocol_owner: "0x6904110f17feD2162a11B5FA66B188d801443Ea4",
  set_token_creator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  aaveV2Pool: "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9",
};

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  aEthUSDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  cUSDCv3: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  aUSDC: "0xBcca60bB61934080951369a648Fb03DF4F96263C",
  gtUSDC: "0xdd0f28e19C1780eb6396170735D45153D261490d",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

const whales = {
  usdc: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  justin_sun: "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296", // aEthUSDC
  wan_liang: "0xCcb12611039c7CD321c0F23043c841F1d97287A5", // cUSDCv3
  mane_lee: "0xBF370B6E9d97D928497C2f2d72FD74f4D9ca5825", // aUSDC
  morpho_seeding: "0x6ABfd6139c7C3CC270ee2Ce132E309F59cAaF6a2", // gtUSDC
};

if (process.env.INTEGRATIONTEST) {
  describe.only("TargetWeightWrapExtension - RebasingComponentModule Nav Issuance Integration Test", async () => {
    const TOKEN_TRANSFER_BUFFER = 10;

    let owner: Account;
    let feeRecipient: Account;
    let deployer: DeployHelper;

    let controller: Controller;
    let integrationRegistry: IntegrationRegistry;
    let setValuer: SetValuer;
    let debtIssuanceModuleV3: DebtIssuanceModuleV3;
    let rebasingComponentModule: RebasingComponentModule;
    let navIssuanceModule: CustomOracleNavIssuanceModule;
    let wrapModuleV2: WrapModuleV2;

    let setToken: SetToken;
    let baseManager: BaseManagerV2;
    let targetWeightWrapExtension: TargetWeightWrapExtension;

    let usdcErc20: IERC20;
    let aEthUSDC: IERC20;
    let cUSDCv3: IERC20;
    let aUSDC: IERC20;
    let gtUSDC: IERC20;

    let aaveV2WrapV2AdapterName: string;
    let aaveV3WrapV2AdapterName: string;
    let compoundV3WrapV2AdapterName: string;
    let erc4626WrapV2AdapterName: string;

    setBlockNumber(20528609);

    before(async () => {
      [ owner, feeRecipient ] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      // Token setup
      usdcErc20 = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
      aEthUSDC = IERC20__factory.connect(tokenAddresses.aEthUSDC, owner.wallet);
      cUSDCv3 = IERC20__factory.connect(tokenAddresses.cUSDCv3, owner.wallet);
      aUSDC = IERC20__factory.connect(tokenAddresses.aUSDC, owner.wallet);
      gtUSDC = IERC20__factory.connect(tokenAddresses.gtUSDC, owner.wallet);

      // Index Protocol setup
      const protocolOwner = await impersonateAccount(contractAddresses.protocol_owner);
      controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);
      const integrationRegistryAddress = await controller.resourceId(0);
      integrationRegistry = IntegrationRegistry__factory.connect(integrationRegistryAddress, owner.wallet);

      debtIssuanceModuleV3 = await deployer.setV2.deployDebtIssuanceModuleV3(
        controller.address,
        TOKEN_TRANSFER_BUFFER,
      );
      await controller.connect(protocolOwner).addModule(debtIssuanceModuleV3.address);

      rebasingComponentModule = await deployer.setV2.deployRebasingComponentModule(controller.address);
      await controller.connect(protocolOwner).addModule(rebasingComponentModule.address);

      navIssuanceModule = await deployer.setV2.deployCustomOracleNavIssuanceModule(
        controller.address,
        tokenAddresses.weth,
      );
      await controller.connect(protocolOwner).addModule(navIssuanceModule.address);

      const erc4626Oracle = await deployer.setV2.deployERC4626Oracle(
        tokenAddresses.gtUSDC,
        usdc(1),
        "gtUSDC/USDC Oracle",
      );
      const preciseUnitOracle = await deployer.setV2.deployPreciseUnitOracle("Rebasing USDC Oracle");

      const priceOracle = await deployer.setV2.deployPriceOracle(
        controller.address,
        tokenAddresses.usdc,
        [erc4626Oracle.address, preciseUnitOracle.address],
        [tokenAddresses.usdc, tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC, tokenAddresses.gtUSDC],
        [tokenAddresses.usdc, tokenAddresses.usdc, tokenAddresses.usdc, tokenAddresses.usdc, tokenAddresses.usdc],
        [preciseUnitOracle.address, preciseUnitOracle.address, preciseUnitOracle.address, preciseUnitOracle.address, erc4626Oracle.address],
      );
      await controller.connect(protocolOwner).addResource(priceOracle.address, 1);

      setValuer = await deployer.setV2.deploySetValuer(controller.address);
      await controller.connect(protocolOwner).addResource(setValuer.address, 2);

      wrapModuleV2 = await deployer.setV2.deployWrapModuleV2(controller.address, tokenAddresses.weth);
      await controller.connect(protocolOwner).addModule(wrapModuleV2.address);

      aaveV2WrapV2AdapterName = "Aave_V2_Wrap_V2_Adapter";
      const aaveV2WrapV2Adapter = await deployer.setV2.deployAaveV2WrapV2Adapter(contractAddresses.aaveV2Pool);
      await integrationRegistry.connect(protocolOwner).addIntegration(wrapModuleV2.address, aaveV2WrapV2AdapterName, aaveV2WrapV2Adapter.address);

      aaveV3WrapV2AdapterName = "Aave_V3_Wrap_V2_Adapter";
      const aaveV3WrapV2Adapter = await deployer.setV2.deployAaveV3WrapV2Adapter(contractAddresses.aaveV3Pool);
      await integrationRegistry.connect(protocolOwner).addIntegration(wrapModuleV2.address, aaveV3WrapV2AdapterName, aaveV3WrapV2Adapter.address);

      compoundV3WrapV2AdapterName = "Compound_V3_USDC_Wrap_V2_Adapter";
      const compoundV3WrapV2Adapter = await deployer.setV2.deployCompoundV3WrapV2Adapter(tokenAddresses.cUSDCv3);
      await integrationRegistry.connect(protocolOwner).addIntegration(wrapModuleV2.address, compoundV3WrapV2AdapterName, compoundV3WrapV2Adapter.address);

      erc4626WrapV2AdapterName = "ERC4626_Wrap_V2_Adapter";
      const erc4626WrapV2Adapter = await deployer.setV2.deployERC4626WrapV2Adapter();
      await integrationRegistry.connect(protocolOwner).addIntegration(wrapModuleV2.address, erc4626WrapV2AdapterName, erc4626WrapV2Adapter.address);

      // Deploy SetToken
      const setTokenCreator = SetTokenCreator__factory.connect(contractAddresses.set_token_creator, owner.wallet);
      const components = [tokenAddresses.usdc, tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC, tokenAddresses.gtUSDC];
      const units = [usdc(20), usdc(20), usdc(20), usdc(20), ether(20)];
      const modules = [debtIssuanceModuleV3.address, rebasingComponentModule.address, navIssuanceModule.address, wrapModuleV2.address];
      const setTokenAddress = await setTokenCreator.callStatic.create(components, units, modules, owner.address, "USDC Index", "USDCI");
      await setTokenCreator.create(components, units, modules, owner.address, "USDC Index", "USDCI");
      setToken = SetToken__factory.connect(setTokenAddress, owner.wallet);

      // Initialize Modules
      await debtIssuanceModuleV3.initialize(
        setToken.address,
        ZERO,
        ZERO,
        ZERO,
        owner.address,
        ADDRESS_ZERO
      );

      await rebasingComponentModule.initialize(
        setToken.address,
        [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC]
      );

      const navIssuanceSettings = {
        managerIssuanceHook: rebasingComponentModule.address,
        managerRedemptionHook: rebasingComponentModule.address,
        setValuer: ADDRESS_ZERO,
        reserveAssets: [tokenAddresses.usdc],
        feeRecipient: feeRecipient.address,
        managerFees: [ether(0.001), ether(0.002)],
        maxManagerFee: ether(0.02),
        premiumPercentage: ether(0.01),
        maxPremiumPercentage: ether(0.1),
        minSetTokenSupply: ether(5),
      } as CustomOracleNAVIssuanceSettings;

      await navIssuanceModule.initialize(
        setToken.address,
        navIssuanceSettings
      );

      // Issue initial units via the debt issuance module V3
      const justin_sun = await impersonateAccount(whales.justin_sun);
      const wan_liang = await impersonateAccount(whales.wan_liang);
      const mane_lee = await impersonateAccount(whales.mane_lee);
      const morpho_seeding = await impersonateAccount(whales.morpho_seeding);
      await usdcErc20.connect(justin_sun).transfer(owner.address, usdc(2000));
      await aEthUSDC.connect(justin_sun).transfer(owner.address, usdc(10000));
      await cUSDCv3.connect(wan_liang).transfer(owner.address, usdc(10000));
      await aUSDC.connect(mane_lee).transfer(owner.address, usdc(10000));
      await gtUSDC.connect(morpho_seeding).transfer(owner.address, ether(10000));
      await usdcErc20.connect(owner.wallet).approve(debtIssuanceModuleV3.address, MAX_UINT_256);
      await aEthUSDC.connect(owner.wallet).approve(debtIssuanceModuleV3.address, MAX_UINT_256);
      await cUSDCv3.connect(owner.wallet).approve(debtIssuanceModuleV3.address, MAX_UINT_256);
      await aUSDC.connect(owner.wallet).approve(debtIssuanceModuleV3.address, MAX_UINT_256);
      await gtUSDC.connect(owner.wallet).approve(debtIssuanceModuleV3.address, MAX_UINT_256);
      await debtIssuanceModuleV3.issue(setToken.address, ether(10), owner.address);

      // Deploy BaseManager
      baseManager = await deployer.manager.deployBaseManagerV2(setToken.address, owner.address, owner.address);
      await setToken.connect(owner.wallet).setManager(baseManager.address);
      await baseManager.connect(owner.wallet).authorizeInitialization();

      // Deploy TargetWeightWrapExtension
      targetWeightWrapExtension = await deployer.extensions.deployTargetWeightWrapExtension(
        baseManager.address,
        wrapModuleV2.address,
        setValuer.address,
        true
      );
    });

    addSnapshotBeforeRestoreAfterEach();

    it("should have the correct valuation", async () => {
      increaseTimeAsync(ONE_DAY_IN_SECONDS);

      await rebasingComponentModule.sync(setToken.address);

      const reserveValuation = await setValuer.calculateComponentValuation(setToken.address, tokenAddresses.usdc, tokenAddresses.usdc);
      const aEthUSDCValuation = await setValuer.calculateComponentValuation(setToken.address, tokenAddresses.aEthUSDC, tokenAddresses.usdc);
      const cUSDCv3Valuation = await setValuer.calculateComponentValuation(setToken.address, tokenAddresses.cUSDCv3, tokenAddresses.usdc);
      const aUSDCValuation = await setValuer.calculateComponentValuation(setToken.address, tokenAddresses.aUSDC, tokenAddresses.usdc);
      const gtUSDCValuation = await setValuer.calculateComponentValuation(setToken.address, tokenAddresses.gtUSDC, tokenAddresses.usdc);
      const setTokenValuation = await setValuer.calculateSetTokenValuation(setToken.address, tokenAddresses.usdc);

      expect(reserveValuation).to.eq(ether(20));

      expect(aEthUSDCValuation).to.gt(ether(20));
      expect(cUSDCv3Valuation).to.gt(ether(20));
      expect(aUSDCValuation).to.gt(ether(20));
      expect(gtUSDCValuation).to.gt(ether(20));
      expect(setTokenValuation).to.gt(ether(100));

      expect(aEthUSDCValuation).to.lt(ether(21));
      expect(cUSDCv3Valuation).to.lt(ether(21));
      expect(aUSDCValuation).to.lt(ether(21));
      expect(gtUSDCValuation).to.lt(ether(21));
      expect(setTokenValuation).to.lt(ether(101));
    });

    it("should be able to process nav issuance as expected", async () => {
      const ownerUsdcBalanceBefore = await usdcErc20.balanceOf(owner.address);
      const ownerSetTokenBalanceBefore = await setToken.balanceOf(owner.address);

      const usdcAmount = usdc(101);

      await usdcErc20.connect(owner.wallet).approve(navIssuanceModule.address, MAX_UINT_256);
      await navIssuanceModule.connect(owner.wallet).issue(
        setToken.address,
        tokenAddresses.usdc,
        usdcAmount,
        ZERO,
        owner.address
      );

      const ownerUsdcBalanceAfter = await usdcErc20.balanceOf(owner.address);
      const ownerSetTokenBalanceAfter = await setToken.balanceOf(owner.address);

      expect(ownerUsdcBalanceAfter).to.eq(ownerUsdcBalanceBefore.sub(usdcAmount));
      expect(ownerSetTokenBalanceAfter).to.gt(ownerSetTokenBalanceBefore.add(ether(0.9)));
    });

    it("should be able to process nav redemption as expected", async () => {
      const ownerUsdcBalanceBefore = await usdcErc20.balanceOf(owner.address);
      const ownerSetTokenBalanceBefore = await setToken.balanceOf(owner.address);

      const setTokenAmount = ether(1);

      await setToken.connect(owner.wallet).approve(navIssuanceModule.address, MAX_UINT_256);
      await navIssuanceModule.connect(owner.wallet).redeem(
        setToken.address,
        tokenAddresses.usdc,
        setTokenAmount,
        ZERO,
        owner.address
      );

      const ownerUsdcBalanceAfter = await usdcErc20.balanceOf(owner.address);
      const ownerSetTokenBalanceAfter = await setToken.balanceOf(owner.address);

      expect(ownerUsdcBalanceAfter).to.gt(ownerUsdcBalanceBefore.add(usdc(99)));
      expect(ownerSetTokenBalanceAfter).to.eq(ownerSetTokenBalanceBefore.sub(setTokenAmount));
    });

    context("when the TargetWeightWrapExtension is added as extension", () => {
      before(async () => {
        await baseManager.addExtension(targetWeightWrapExtension.address);
      });

      it("should have the TargetWeightWrapExtension added as an extension", async () => {
        expect(await setToken.manager()).to.equal(baseManager.address);
        expect(await baseManager.isExtension(targetWeightWrapExtension.address)).to.be.true;
      });

      context("when the WrapModuleV2 is initialized", () => {
        before(async () => {
          await targetWeightWrapExtension.initialize();
        });

        it("should have the WrapModuleV2 initialized", async () => {
          expect(await setToken.moduleStates(wrapModuleV2.address)).to.equal(2);
        });

        context("when the target weights are set", () => {
          before(async () => {
            await targetWeightWrapExtension.setTargetWeights(
              tokenAddresses.usdc,
              ether(0.19),
              ether(0.25),
              [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC, tokenAddresses.gtUSDC],
              [
                {
                  minTargetWeight: ether(0.15),
                  maxTargetWeight: ether(0.22),
                  wrapAdapterName: aaveV3WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                  unwrapData: ZERO_BYTES,
                } as TargetWeightWrapParams,
                {
                  minTargetWeight: ether(0.15),
                  maxTargetWeight: ether(0.22),
                  wrapAdapterName: compoundV3WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                  unwrapData: ZERO_BYTES,
                } as TargetWeightWrapParams,
                {
                  minTargetWeight: ether(0.15),
                  maxTargetWeight: ether(0.22),
                  wrapAdapterName: aaveV2WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                  unwrapData: ZERO_BYTES,
                } as TargetWeightWrapParams,
                {
                  minTargetWeight: ether(0.15),
                  maxTargetWeight: ether(0.22),
                  wrapAdapterName: erc4626WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                  unwrapData: ZERO_BYTES,
                } as TargetWeightWrapParams,
              ]
            );
          });

          it("should be rebalancing", async () => {
            expect(await targetWeightWrapExtension.isRebalancingActive()).to.be.true;
          });

          context("when a sufficiently large nav issuance occurs", () => {
            before(async () => {
              await usdcErc20.connect(owner.wallet).approve(navIssuanceModule.address, MAX_UINT_256);
              await navIssuanceModule.connect(owner.wallet).issue(
                setToken.address,
                usdcErc20.address,
                usdc(500),
                ZERO,
                owner.address
              );
            });

            it("the reserve should be overweight and the targets should be underweight", async () => {
              expect(await targetWeightWrapExtension.isReserveOverweight()).to.be.true;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.aEthUSDC)).to.be.true;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.cUSDCv3)).to.be.true;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.aUSDC)).to.be.true;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.gtUSDC)).to.be.true;
            });

            it("should be able to rebalance Aave V3", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).wrap(tokenAddresses.aEthUSDC, usdc(2));

              expect(await targetWeightWrapExtension.isReserveUnderweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.aEthUSDC)).to.be.false;
            });

            it("should be able to rebalance Compound V3", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).wrap(tokenAddresses.cUSDCv3, usdc(2));

              expect(await targetWeightWrapExtension.isReserveUnderweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.cUSDCv3)).to.be.false;
            });

            it("should be able to rebalance Aave V2", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).wrap(tokenAddresses.aUSDC, usdc(2));

              expect(await targetWeightWrapExtension.isReserveUnderweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.aUSDC)).to.be.false;
            });

            it("should be able to rebalance ERC4626", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).wrap(tokenAddresses.gtUSDC, usdc(2));

              expect(await targetWeightWrapExtension.isReserveUnderweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.gtUSDC)).to.be.false;
            });
          });

          context("when a sufficiently large nav redemption occurs", () => {
            before(async () => {
              await setToken.connect(owner.wallet).approve(navIssuanceModule.address, MAX_UINT_256);
              await navIssuanceModule.connect(owner.wallet).redeem(
                setToken.address,
                tokenAddresses.usdc,
                ether(6),
                ZERO,
                owner.address
              );
            });

            it("the reserve should be underweight and the targets should be overweight", async () => {
              expect(await targetWeightWrapExtension.isReserveUnderweight()).to.be.true;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.aEthUSDC)).to.be.true;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.cUSDCv3)).to.be.true;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.aUSDC)).to.be.true;
              expect(await targetWeightWrapExtension.isTargetOverweight(tokenAddresses.gtUSDC)).to.be.true;
            });

            it("should be able to rebalance Aave V3", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).unwrap(tokenAddresses.aEthUSDC, usdc(1));

              expect(await targetWeightWrapExtension.isReserveOverweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.aEthUSDC)).to.be.false;
            });

            it("should be able to rebalance Compound V3", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).unwrap(tokenAddresses.cUSDCv3, usdc(1));

              expect(await targetWeightWrapExtension.isReserveOverweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.cUSDCv3)).to.be.false;
            });

            it("should be able to rebalance Aave V2", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).unwrap(tokenAddresses.aUSDC, usdc(1));

              expect(await targetWeightWrapExtension.isReserveOverweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.aUSDC)).to.be.false;
            });

            it("should be able to rebalance ERC4626", async () => {
              await targetWeightWrapExtension.connect(owner.wallet).unwrap(tokenAddresses.gtUSDC, ether(1));

              expect(await targetWeightWrapExtension.isReserveOverweight()).to.be.false;
              expect(await targetWeightWrapExtension.isTargetUnderweight(tokenAddresses.gtUSDC)).to.be.false;
            });
          });
        });
      });
    });
  });
}
