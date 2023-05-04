import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, usdc, getSetFixture, preciseMul } from "@utils/index";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import {
  IWETH,
  IUniswapV2Router,
  FlashMint4626,
  IERC20,
  IERC4626,
  SetToken,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether } from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { formatUnits } from "ethers/lib/utils";

const expect = getWaffleExpect();
const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;


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


const maUSDC = "0xA5269A8e31B93Ff27B887B56720A25F844db0529"; // maUSDC
process.env.INTEGRATIONTEST && describe("FlashMint4626 - Integration Test", async () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setToken: SetToken;
  let USDC: IERC20;
  let MaUSDC: IERC4626;

  let weth: IWETH;
  let setV2Setup: SetFixture;
  let setTokenAddr: string;

  before(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    USDC = (await ethers.getContractAt(
      "IERC20",
      addresses.tokens.USDC,
    )) as IERC20;

    MaUSDC = (await ethers.getContractAt(
      "IERC4626",
      maUSDC,
    )) as IERC4626;

    // create set token with morpho-aave usdc component
    setToken = await setV2Setup.createSetToken(
      [MaUSDC.address],
      [await MaUSDC.convertToShares(usdc(100))],
      [
        setV2Setup.debtIssuanceModule.address,
        setV2Setup.streamingFeeModule.address,
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

    weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;
  });

  context("When flash mint wrapped is deployed and a setToken approved", () => {
    let flashMintContract: FlashMint4626;
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
      );
      await flashMintContract.approveSetToken(setTokenAddr);
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

    describe(`When input/output token is USDC`, () => {
      describe(
        "#issueExactSetFromERC20",
        () => {
          let inputToken: IERC20;

          let subjectSetToken: Address;
          let subjectMaxAmountIn: BigNumber;

          let issueSetAmount: BigNumber;
          let inputAmount: BigNumber;

          let componentSwapData: ComponentSwapData[];

          beforeEach(async () => {

            inputToken = USDC;
            inputAmount = usdc(201);
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
              BigNumber.from("1699894490"), // November 13, 2023 4:54:50 PM GMT
              { value: ether(100) },
            );

            componentSwapData = [{
              underlyingERC20: addresses.tokens.USDC,
              dexData: {
                path: [inputToken.address, addresses.tokens.weth, addresses.tokens.USDC],
                fees: [3000],
                pool: ADDRESS_ZERO,
                exchange: Exchange.UniV3,
              },
              buyUnderlyingAmount: usdc(200),
            }];

            await inputToken
              .connect(owner.wallet)
              .approve(flashMintContract.address, subjectMaxAmountIn);

          });

          async function subject() {
            return await flashMintContract.issueExactSetFromERC20(
              subjectSetToken,
              inputToken.address,
              issueSetAmount,
              subjectMaxAmountIn,
              componentSwapData,
            );
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
            const inputBalanceBefore = await inputToken.balanceOf(owner.address);
            await subject();
            const inputBalanceAfter = await inputToken.balanceOf(owner.address);
            const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
            expect(inputSpent.gt(0)).to.be.true;
            expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
          });

          it("should quote the correct input amount", async () => {
            const inputBalanceBefore = await inputToken.balanceOf(owner.address);
            await subject();
            const inputBalanceAfter = await inputToken.balanceOf(owner.address);
            const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

            const quotedInputAmount = await subjectQuote();
            expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
            expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
          });
        },
      );
    });
  });
});
