import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ether, getAccounts, getWaffleExpect, preciseMul, usdc } from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO, ZERO_BYTES } from "@utils/constants";
import {
  addSnapshotBeforeRestoreAfterEach,
  setBlockNumber,
} from "@utils/test/testingUtils";
import { impersonateAccount } from "./utils";
import {
  DebtIssuanceModuleV3,
  IERC20,
  IERC20__factory,
  SetToken,
  SetTokenCreator__factory,
  RebasingComponentModule,
  Controller,
  Controller__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetToken__factory,
  WrapModuleV2,
  FlashMintWrapped,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { BigNumber, utils } from "ethers";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

type ComponentSwapData = {
  underlyingERC20: Address;
  dexData: SwapData;
  buyUnderlyingAmount: BigNumber;
};

type ComponentWrapData = {
  integrationName: string;
  wrapData: string;
};

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
  describe.only("FlashMintWrapped - RebasingComponentModule Integration Test", async () => {
    const TOKEN_TRANSFER_BUFFER = 10;
    const addresses = PRODUCTION_ADDRESSES;

    let owner: Account;
    let deployer: DeployHelper;

    let controller: Controller;
    let integrationRegistry: IntegrationRegistry;
    let debtIssuanceModuleV3: DebtIssuanceModuleV3;
    let rebasingComponentModule: RebasingComponentModule;
    let wrapModuleV2: WrapModuleV2;

    let setToken: SetToken;

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
      [ owner ] = await getAccounts();
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
      const units = [usdc(20), usdc(20), usdc(20), usdc(20), ether(19.37)];
      const modules = [debtIssuanceModuleV3.address, rebasingComponentModule.address, wrapModuleV2.address];
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
    });

    addSnapshotBeforeRestoreAfterEach();

    context("when FlashMintWrapped is deployed", () => {
      let flashMintWrapped: FlashMintWrapped;

      before(async () => {
        flashMintWrapped = await deployer.extensions.deployFlashMintWrappedExtension(
          tokenAddresses.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.dexes.curve.calculator,
          addresses.dexes.curve.addressProvider,
          controller.address,
          debtIssuanceModuleV3.address,
          wrapModuleV2.address,
        );
      });

      it("should set the dexAdapter correctly", async () => {
        const returnedAddresses = await flashMintWrapped.dexAdapter();

        expect(returnedAddresses.weth).to.eq(utils.getAddress(tokenAddresses.weth));
        expect(returnedAddresses.sushiRouter).to.eq(utils.getAddress(addresses.dexes.sushiswap.router));
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
        expect(returnedAddresses.curveAddressProvider).to.eq(utils.getAddress(addresses.dexes.curve.addressProvider));
        expect(returnedAddresses.curveCalculator).to.eq(utils.getAddress(addresses.dexes.curve.calculator));
      });

      it("should set the index protocol contracts correctly", async () => {
        expect(await flashMintWrapped.setController()).to.eq(utils.getAddress(controller.address));
        expect(await flashMintWrapped.issuanceModule()).to.eq(utils.getAddress(debtIssuanceModuleV3.address));
        expect(await flashMintWrapped.wrapModule()).to.eq(utils.getAddress(wrapModuleV2.address));
      });

      context("When setToken is approved", () => {
        before(async () => {
          await flashMintWrapped.approveSetToken(setToken.address);
        });

        context("When input/output token is USDC", () => {
          describe("#issueExactSetFromERC20", () => {
            let subjectSetToken: Address;
            let subjectInputToken: Address;
            let subjectAmountSetToken: BigNumber;
            let subjectMaxAmountInputToken: BigNumber;
            let subjectSwapData: ComponentSwapData[];
            let subjectWrapData: ComponentWrapData[];
            let subjectCaller: Account;

            before(async () => {
              await usdcErc20.connect(owner.wallet).approve(flashMintWrapped.address, MAX_UINT_256);

              subjectWrapData = [
                {
                  integrationName: "",
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: aaveV3WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: compoundV3WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: aaveV2WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: erc4626WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
              ];

              subjectSwapData = [
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(21),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(21),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(21),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(21),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(21),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
              ];

              subjectSetToken = setToken.address;
              subjectInputToken = tokenAddresses.usdc;
              subjectAmountSetToken = ether(1);
              subjectMaxAmountInputToken = usdc(105);
              subjectCaller = owner;
            });

            async function subject() {
              return await flashMintWrapped.connect(subjectCaller.wallet).issueExactSetFromERC20(
                subjectSetToken,
                subjectInputToken,
                subjectAmountSetToken,
                subjectMaxAmountInputToken,
                subjectSwapData,
                subjectWrapData,
              );
            }

            async function subjectQuote() {
              return flashMintWrapped.callStatic.getIssueExactSet(
                subjectSetToken,
                subjectInputToken,
                subjectAmountSetToken,
                subjectSwapData,
              );
            }

            it("should issue the correct amount of tokens", async () => {
              const setBalancebefore = await setToken.balanceOf(owner.address);
              await subject();
              const setBalanceAfter = await setToken.balanceOf(owner.address);
              const setObtained = setBalanceAfter.sub(setBalancebefore);
              expect(setObtained).to.eq(subjectAmountSetToken);
            });

            it("should spend less than specified max amount", async () => {
              const inputBalanceBefore = await usdcErc20.balanceOf(owner.address);
              await subject();
              const inputBalanceAfter = await usdcErc20.balanceOf(owner.address);
              const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
              expect(inputSpent.gt(0)).to.be.true;
              expect(inputSpent.lte(subjectMaxAmountInputToken)).to.be.true;
            });

            it("should quote the approximate input amount", async () => {
              const inputBalanceBefore = await usdcErc20.balanceOf(owner.address);

              const quotedInputAmount = await subjectQuote();

              await subject();
              const inputBalanceAfter = await usdcErc20.balanceOf(owner.address);
              const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

              expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
              expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
            });
          });

          describe("#redeemExactSetForERC20", () => {
            let subjectSetToken: Address;
            let subjectOutputToken: Address;
            let subjectRedeemSetAmount: BigNumber;
            let subjectMinAmountOutput: BigNumber;
            let subjectSwapData: ComponentSwapData[];
            let subjectWrapData: ComponentWrapData[];
            let subjectCaller: Account;

            before(async () => {
              await setToken.connect(owner.wallet).approve(flashMintWrapped.address, MAX_UINT_256);

              subjectWrapData = [
                {
                  integrationName: "",
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: aaveV3WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: compoundV3WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: aaveV2WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
                {
                  integrationName: erc4626WrapV2AdapterName,
                  wrapData: ZERO_BYTES,
                },
              ];

              subjectSwapData = [
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(20),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(20),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(20),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(20),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
                {
                  underlyingERC20: tokenAddresses.usdc,
                  buyUnderlyingAmount: usdc(20),
                  dexData: {
                    fees: [],
                    path: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  },
                },
              ];

              subjectSetToken = setToken.address;
              subjectOutputToken = tokenAddresses.usdc;
              subjectRedeemSetAmount = ether(1);
              subjectMinAmountOutput = usdc(99);
              subjectCaller = owner;
            });

            async function subject() {
              return await flashMintWrapped.connect(subjectCaller.wallet).redeemExactSetForERC20(
                subjectSetToken,
                subjectOutputToken,
                subjectRedeemSetAmount,
                subjectMinAmountOutput,
                subjectSwapData,
                subjectWrapData,
              );
            }

            async function subjectQuote(): Promise<BigNumber> {
              return flashMintWrapped.callStatic.getRedeemExactSet(
                subjectSetToken,
                subjectOutputToken,
                subjectRedeemSetAmount,
                subjectSwapData,
              );
            }

            it("should redeem the correct amount of tokens", async () => {
              const setBalanceBefore = await setToken.balanceOf(owner.address);
              await subject();
              const setBalanceAfter = await setToken.balanceOf(owner.address);
              const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
              expect(setRedeemed).to.eq(subjectRedeemSetAmount);
            });

            it("should return at least the specified minimum of output tokens", async () => {
              const outputBalanceBefore = await usdcErc20.balanceOf(owner.address);
              await subject();
              const outputBalanceAfter = await usdcErc20.balanceOf(owner.address);
              const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
              expect(outputObtained).to.be.gte(subjectMinAmountOutput);
            });

            it("should quote the approximate output amount", async () => {
              const outputBalanceBefore = await usdcErc20.balanceOf(owner.address);

              const quotedOutputAmount = await subjectQuote();

              await subject();
              const outputBalanceAfter = await usdcErc20.balanceOf(owner.address);
              const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);

              expect(quotedOutputAmount).to.gt(preciseMul(outputObtained, ether(0.99)));
              expect(quotedOutputAmount).to.lt(preciseMul(outputObtained, ether(1.01)));
            });
          });
        });
      });
    });
  });
}
