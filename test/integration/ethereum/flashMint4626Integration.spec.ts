import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, usdc, getSetFixture, preciseMul } from "@utils/index";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import {
  IWETH,
  IUniswapV2Router,
  FlashMintWrapped,
  IERC20,
  IDebtIssuanceModule,
  SetToken,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, ZERO, ZERO_BYTES } from "@utils/constants";
import { ether } from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { formatUnits } from "ethers/lib/utils";

const expect = getWaffleExpect();
const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;

const erc4626WrapV2AdapterName: string = "ERC4626WrapV2Adapter";

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
  // unwrapped token version, e.g. DAI
  underlyingERC20: Address;

  // // swap data for DEX operation: fees, path, etc. see DEXAdapter.SwapData
  dexData: SwapData;

  // ONLY relevant for issue, not used for redeem:
  // amount that has to be bought of the unwrapped token version (to cover required wrapped component amounts for issuance)
  // this amount has to be computed beforehand through the exchange rate of wrapped Component <> unwrappedComponent
  // i.e. getRequiredComponentIssuanceUnits() on the IssuanceModule and then convert units through exchange rate to unwrapped component units
  // e.g. 300 cDAI needed for issuance of 1 Set token. exchange rate 1cDAI = 0.05 DAI. -> buyUnderlyingAmount = 0.05 DAI * 300 = 15 DAI
  buyUnderlyingAmount: BigNumber;
};

type ComponentWrapData = {
  integrationName: string; // wrap adapter integration name as listed in the IntegrationRegistry for the wrapModule
  wrapData: string; // optional wrapData passed to the wrapAdapter
};

const maUSDC = "0xA5269A8e31B93Ff27B887B56720A25F844db0529"; // maUSDC

class TestHelper {
  async getIssuanceComponentSwapData(
    inputToken: Address,
    issueSetAmount: BigNumber,
    setToken: Address,
    issuanceModule: IDebtIssuanceModule,
  ) {
    // get required issuance components
    const [
      issuanceComponents, // maUSDC
      ,
    ] = await issuanceModule.getRequiredComponentIssuanceUnits(setToken, issueSetAmount);

    if (
      JSON.stringify([maUSDC]).toLowerCase() !==
      JSON.stringify(issuanceComponents).toLowerCase()
    ) {
      throw new Error("issuance components test case not implemented");
    }

    const componentSwapData: ComponentSwapData[] = [{
      underlyingERC20: addresses.tokens.USDC,
      dexData: {
        path: [inputToken, addresses.tokens.weth, addresses.tokens.USDC],
        fees: [3000],
        pool: ADDRESS_ZERO,
        exchange: Exchange.UniV3,
      },
      buyUnderlyingAmount: usdc(200),
    },
    ];

    return componentSwapData;
  }

  getWrapData(): ComponentWrapData[] {
    return [
      {
        integrationName: erc4626WrapV2AdapterName,
        wrapData: ZERO_BYTES,
      },
    ];
  }

}
process.env.INTEGRATIONTEST && describe("FlashMint4626 - Integration Test", async () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setToken: SetToken;
  let USDC: IERC20;
  let MaUSDC: IERC20;

  let weth: IWETH;
  let setV2Setup: SetFixture;
  let setTokenAddr: string;

  before(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // deploy ERC4626WrapV2Adapter
    const erc4626WrapAdapter = await deployer.setV2.deployERC4626WrapV2Adapter();
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModule.address,
      erc4626WrapV2AdapterName,
      erc4626WrapAdapter.address,
    );

    // create set token with morpho-aave usdc component
    setToken = await setV2Setup.createSetToken(
      [maUSDC],
      [ether(0.991424841884336539).mul(100)],
      [
        setV2Setup.debtIssuanceModule.address,
        setV2Setup.streamingFeeModule.address,
        setV2Setup.wrapModule.address,
      ],
    );
    setTokenAddr = setToken.address;

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ZERO,
      ZERO,
      ZERO,
      ADDRESS_ZERO,
      ADDRESS_ZERO,
    );

    USDC = (await ethers.getContractAt(
      "IERC20",
      addresses.tokens.USDC,
    )) as IERC20;

    MaUSDC = (await ethers.getContractAt(
      "IERC20",
      maUSDC,
    )) as IERC20;


    weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;
  });

  context("When flash mint wrapped is deployed", () => {
    let flashMintContract: FlashMintWrapped;
    //#region basic setup and constructor with addresses set correctly checks
    before(async () => {
      flashMintContract = await deployer.extensions.deployFlashMint4626(
        addresses.tokens.weth,
        addresses.dexes.uniV2.router,
        addresses.dexes.sushiswap.router,
        addresses.dexes.uniV3.router,
        addresses.dexes.uniV3.quoter,
        addresses.dexes.curve.addressProvider,
        addresses.dexes.curve.calculator,
        setV2Setup.controller.address,
        setV2Setup.debtIssuanceModule.address,
        setV2Setup.wrapModule.address,
      );
    });

    it("weth address is set correctly", async () => {
      const returnedAddresses = await flashMintContract.dexAdapter();
      expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
    });

    it("sushi router address is set correctly", async () => {
      const returnedAddresses = await flashMintContract.dexAdapter();
      expect(returnedAddresses.sushiRouter).to.eq(
        utils.getAddress(addresses.dexes.sushiswap.router),
      );
    });

    it("uniV2 router address is set correctly", async () => {
      const returnedAddresses = await flashMintContract.dexAdapter();
      expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
    });

    it("uniV3 router address is set correctly", async () => {
      const returnedAddresses = await flashMintContract.dexAdapter();
      expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
    });

    it("uniV3 quoter address is set correctly", async () => {
      const returnedAddresses = await flashMintContract.dexAdapter();
      expect(returnedAddresses.uniV3Quoter).to.eq(utils.getAddress(addresses.dexes.uniV3.quoter));
    });

    it("controller address is set correctly", async () => {
      expect(await flashMintContract.setController()).to.eq(
        utils.getAddress(setV2Setup.controller.address),
      );
    });

    it("debt issuance module address is set correctly", async () => {
      expect(await flashMintContract.issuanceModule()).to.eq(
        utils.getAddress(setV2Setup.debtIssuanceModule.address),
      );
    });
    //#endregion

    describe("When setToken is approved", () => {
      before(async () => {
        console.log(setTokenAddr);
        await flashMintContract.approveSetToken(setTokenAddr);
      });

      ["USDC"].forEach(tokenName => {
        describe(`When input/output token is ${tokenName}`, () => {
          const testHelper = new TestHelper();

          describe(
            tokenName == "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
            () => {
              let inputToken: IERC20;

              let subjectSetToken: Address;
              let subjectMaxAmountIn: BigNumber;

              let issueSetAmount: BigNumber;
              let inputAmount: BigNumber;

              let componentSwapData: ComponentSwapData[];

              beforeEach(async () => {

                inputToken = USDC;
                inputAmount = usdc(200);
                subjectSetToken = setTokenAddr;
                issueSetAmount = ether(2);
                subjectMaxAmountIn = inputAmount;

                const uniV2Router = (await ethers.getContractAt(
                  "IUniswapV2Router",
                  addresses.dexes.uniV2.router,
                )) as IUniswapV2Router;

                const usdcbeforetest = await inputToken.balanceOf(owner.address);
                await inputToken.transfer("0x00000000000000000000000000000000DeaDBeef", usdcbeforetest);
                await uniV2Router.swapETHForExactTokens(
                  inputAmount,
                  [weth.address, USDC.address],
                  owner.address,
                  BigNumber.from("1688894490"),
                  { value: ether(100) },
                );

                await inputToken
                  .connect(owner.wallet)
                  .approve(flashMintContract.address, subjectMaxAmountIn);

                componentSwapData = await testHelper.getIssuanceComponentSwapData(
                  inputToken.address,
                  issueSetAmount,
                  subjectSetToken,
                  setV2Setup.debtIssuanceModule,
                );
              });

              async function subject() {
                if (tokenName !== "ETH") {
                  return await flashMintContract.issueExactSetFromERC20(
                    subjectSetToken,
                    inputToken.address,
                    issueSetAmount,
                    subjectMaxAmountIn,
                    componentSwapData,
                    testHelper.getWrapData(),
                  );
                } else {
                  return await flashMintContract.issueExactSetFromETH(
                    subjectSetToken,
                    issueSetAmount,
                    componentSwapData,
                    testHelper.getWrapData(),
                    { value: subjectMaxAmountIn },
                  );
                }
              }

              async function subjectQuote() {
                return flashMintContract.callStatic.getIssueExactSet(
                  subjectSetToken,
                  inputToken.address,
                  issueSetAmount,
                  componentSwapData,
                );
              }

              it("should issue the correct amount of tokens", async () => {
                const setBalanceBefore = await setToken.balanceOf(owner.address);
                await subject();
                const setBalanceAfter = await setToken.balanceOf(owner.address);
                const setObtained = setBalanceAfter.sub(setBalanceBefore);
                expect(setObtained).to.eq(issueSetAmount);
              });

              it("should not retain any component tokens", async () => {
                const componentBalanceBefore = await MaUSDC.balanceOf(flashMintContract.address);
                await subject();
                const componentBalanceAfter = await MaUSDC.balanceOf(flashMintContract.address);
                const componentRetained = componentBalanceAfter.sub(componentBalanceBefore);

                const actual = formatUnits(componentRetained);
                const expected = formatUnits(ether(0));
                expect(actual).to.eq(expected);
              });

              it("should not retain any input tokens", async () => {
                const inputTokenDecimals = 6;
                const inputTokenBalanceBefore = await inputToken.balanceOf(flashMintContract.address);
                await subject();
                const inputTokenBalanceAfter = await inputToken.balanceOf(flashMintContract.address);
                const inputTokensRetained = inputTokenBalanceAfter.sub(inputTokenBalanceBefore);

                const actual = formatUnits(inputTokensRetained, inputTokenDecimals);
                const expected = formatUnits(0, inputTokenDecimals);
                expect(actual).to.eq(expected);
              });

              it("should spend less than specified max amount", async () => {
                const inputBalanceBefore =
                  tokenName == "ETH"
                    ? await owner.wallet.getBalance()
                    : await inputToken.balanceOf(owner.address);
                await subject();
                const inputBalanceAfter =
                  tokenName == "ETH"
                    ? await owner.wallet.getBalance()
                    : await inputToken.balanceOf(owner.address);
                const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                expect(inputSpent.gt(0)).to.be.true;
                expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
              });

              it("should quote the correct input amount", async () => {
                const inputBalanceBefore =
                  tokenName == "ETH"
                    ? await owner.wallet.getBalance()
                    : await inputToken.balanceOf(owner.address);
                const result = await subject();
                const inputBalanceAfter =
                  tokenName == "ETH"
                    ? await owner.wallet.getBalance()
                    : await inputToken.balanceOf(owner.address);
                let inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

                if (tokenName == "ETH") {
                  const gasFee = await flashMintContract.estimateGas.issueExactSetFromETH(
                    subjectSetToken,
                    issueSetAmount,
                    componentSwapData,
                    testHelper.getWrapData(),
                    { value: subjectMaxAmountIn },
                  );
                  const gasCost = gasFee.mul(result.gasPrice);

                  inputSpent = inputSpent.sub(gasCost);
                }
                const quotedInputAmount = await subjectQuote();
                expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
                expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
              });
            },
          );
        });
      });
    });
  });
});
