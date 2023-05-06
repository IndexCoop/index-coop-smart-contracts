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
  // // swap data for DEX operation: fees, path, etc. see DEXAdapter.SwapData
  dexData: SwapData;
};


const maUSDC = "0xA5269A8e31B93Ff27B887B56720A25F844db0529"; // maUSDC
const maDAI = "0x36F8d0D0573ae92326827C4a82Fe4CE4C244cAb6"; // maDAI
// const wfDAI = "0x278039398A5eb29b6c2FB43789a38A84C6085266" // wrapped DAI

process.env.INTEGRATIONTEST && describe("FlashMint4626 - Integration Test", async () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setToken: SetToken;
  let USDC: IERC20;
  let DAI: IERC20;

  let MaUSDC: IERC4626;
  let MaDAI: IERC4626;

  let weth: IWETH;
  let setV2Setup: SetFixture;

  before(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    USDC = (await ethers.getContractAt(
      "IERC20",
      addresses.tokens.USDC,
    )) as IERC20;


    DAI = (await ethers.getContractAt(
      "IERC20",
      addresses.tokens.dai,
    )) as IERC20;


    MaUSDC = (await ethers.getContractAt(
      "IERC4626",
      maUSDC,
    )) as IERC4626;

    MaDAI = (await ethers.getContractAt(
      "IERC4626",
      maDAI,
    )) as IERC4626;

    const requiredMaUSDCShares = await MaUSDC.previewDeposit(usdc(50));
    const requiredMaDAIShares = await MaDAI.previewDeposit(ether(50));

    // create set token with morpho-aave usdc component
    setToken = await setV2Setup.createSetToken(
      [MaUSDC.address, MaDAI.address],
      [requiredMaUSDCShares, requiredMaDAIShares],
      [
        setV2Setup.debtIssuanceModule.address,
        setV2Setup.streamingFeeModule.address,
      ],
    );

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
      await flashMintContract.approveSetToken(setToken.address);
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
      let inputToken: IERC20;

      let subjectSetToken: Address;
      let subjectMaxAmountIn: BigNumber;

      let issueSetAmount: BigNumber;
      let inputAmount: BigNumber;

      let componentSwapData: ComponentSwapData[];

      const setupTest = async () => {
        inputToken = USDC;
        inputAmount = usdc(100);
        subjectSetToken = setToken.address;
        issueSetAmount = ether(1);
        subjectMaxAmountIn = inputAmount.mul(ether(1.01)).div(ether(1));

        const uniV2Router = (await ethers.getContractAt(
          "IUniswapV2Router",
          addresses.dexes.uniV2.router,
        )) as IUniswapV2Router;

        await uniV2Router.swapETHForExactTokens(
          subjectMaxAmountIn,
          [weth.address, USDC.address],
          owner.address,
          BigNumber.from("1699894490"), // November 13, 2023 4:54:50 PM GMT
          { value: ether(100) },
        );

        componentSwapData = [{
          dexData: {
            path: [inputToken.address, USDC.address],
            fees: [100],
            pool: ADDRESS_ZERO,
            exchange: Exchange.UniV3,
          },
        },
        {
          dexData: {
            path: [inputToken.address, DAI.address],
            fees: [100],
            pool: ADDRESS_ZERO,
            exchange: Exchange.UniV3,
          },
        }];

        await inputToken
          .connect(owner.wallet)
          .approve(flashMintContract.address, subjectMaxAmountIn);

        const subject = () => {
          return flashMintContract.issueExactSetFromERC20(
            subjectSetToken,
            inputToken.address,
            issueSetAmount,
            subjectMaxAmountIn,
            componentSwapData,
          );
        };
        const subjectQuote = () => {
          return flashMintContract.callStatic.getIssueExactSet(
            subjectSetToken,
            inputToken.address,
            issueSetAmount,
            componentSwapData,
          );
        };
        return { subject, subjectQuote };
      };
      describe(
        "#issueExactSetFromERC20",
        () => {
          let subject: Awaited<ReturnType<typeof setupTest>>["subject"];
          let subjectQuote: Awaited<ReturnType<typeof setupTest>>["subjectQuote"];
          beforeEach(async () => {
            const fixture = await setupTest();
            subject = fixture.subject;
            subjectQuote = fixture.subjectQuote;
          });

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
      describe("#redeemExactSetForERC20", () => {
        let subject: Awaited<ReturnType<typeof setupRedeemTest>>["subject"];
        let subjectQuote: Awaited<ReturnType<typeof setupRedeemTest>>["subjectQuote"];
        let issueQuote: Awaited<ReturnType<typeof setupRedeemTest>>["issueQuote"];

        const setupRedeemTest = async () => {
          const issueFixture = await setupTest();
          const issue = issueFixture.subject;
          const issueQuote = issueFixture.subjectQuote;

          await issue();
          await setToken
          .connect(owner.wallet)
          .approve(flashMintContract.address, issueSetAmount);

          const outputToken = inputToken;


          const componentRedeemData: ComponentSwapData[] = [{
            dexData: {
              path: [USDC.address, outputToken.address],
              fees: [3000],
              pool: ADDRESS_ZERO,
              exchange: Exchange.UniV3,
            },
          },
          {
            dexData: {
              path: [DAI.address, outputToken.address],
              fees: [3000],
              pool: ADDRESS_ZERO,
              exchange: Exchange.UniV3,
            },
          }];

          const subject = async () => {
            return flashMintContract.redeemExactSetForERC20(
              subjectSetToken,
              inputToken.address,
              issueSetAmount,
              usdc(1),
              componentRedeemData,
            );
          };
          const subjectQuote = () => {
            return flashMintContract.callStatic.getRedeemExactSet(
              subjectSetToken,
              inputToken.address,
              issueSetAmount,
              componentRedeemData,
            );
          };
          return { subject, subjectQuote, issueQuote };
        };
        beforeEach(async () => {
         const fixture = await setupRedeemTest();
         subject = fixture.subject;
          subjectQuote = fixture.subjectQuote;
          issueQuote = fixture.issueQuote;
        });
        it("should redeem the set token", async () => {
          const setBalanceBefore = await setToken.balanceOf(owner.address);
          expect(setBalanceBefore).to.eq(ether(1));
          await subject();
          const setBalanceAfter = await setToken.balanceOf(owner.address);
          expect(setBalanceAfter).to.eq(ether(0));
        });
        it.only("should return the USDC quoted", async () => {
          const usdcBalanceBefore = await USDC.balanceOf(owner.address);
          await subject();
          const usdcBalanceAfter = await USDC.balanceOf(owner.address);
          const obtained = usdcBalanceAfter.sub(usdcBalanceBefore);
          expect(await subjectQuote()).to.eq(obtained);
        });
        it("should have no DAI/USDC", async () => {
          const daiBalanceBefore = await DAI.balanceOf(flashMintContract.address);
          const usdcBalanceBefore = await USDC.balanceOf(flashMintContract.address);
          await subject();
          const daiBalanceAfter = await DAI.balanceOf(flashMintContract.address);
          const usdcBalanceAfter = await USDC.balanceOf(flashMintContract.address);
          const daiObtained = daiBalanceAfter.sub(daiBalanceBefore);
          const usdcObtained = usdcBalanceAfter.sub(usdcBalanceBefore);
          expect(formatUnits(daiObtained, 18)).to.eq(formatUnits(0, 18));
          expect(formatUnits(usdcObtained, 6)).to.eq(formatUnits(0, 6));
        });
        it("should have no leftover component shares/tokens", async () => {
          const daiBalanceBefore = await MaDAI.balanceOf(flashMintContract.address);
          const usdcBalanceBefore = await MaUSDC.balanceOf(flashMintContract.address);
          await subject();
          const daiBalanceAfter = await MaDAI.balanceOf(flashMintContract.address);
          const usdcBalanceAfter = await MaUSDC.balanceOf(flashMintContract.address);
          const daiObtained = daiBalanceAfter.sub(daiBalanceBefore);
          const usdcObtained = usdcBalanceAfter.sub(usdcBalanceBefore);
          expect(formatUnits(daiObtained, 18)).to.eq(formatUnits(0, 18));
          expect(formatUnits(usdcObtained, 18)).to.eq(formatUnits(0, 18));
        });
        it("should quote something reasonable", async () => {
          const quoted = await issueQuote();
          const quotedRedeem = await subjectQuote();
          const quotedSpread = quoted.sub(quotedRedeem);
          expect(quotedSpread).to.lt(usdc(1));
        });
      });
    });
  });
});
