import "module-alias/register";
import { ethers, network } from "hardhat";
import { Address, Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach, ether, getAccounts, getWaffleExpect } from "@utils/index";
import { SetToken, SlippageIssuanceModule } from "@utils/contracts/setV2";
import { BigNumber, ContractTransaction } from "ethers";
import { FlashMintPerp, StandardTokenMock, WETH9 } from "@utils/contracts/index";
import { Quoter, SwapRouter02 } from "../../../typechain";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import {
  encodePath,
  expectCloseTo,
  getUsdcAmountInForExactSet,
  getUsdcAmountOutForExactSet,
} from "@utils/common/exchangeIssuanceUtils";
import { UnitsUtils } from "@utils/common/unitsUtils";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("flashMintPerp - Integration Test", () => {
    const MNYeSetTokenAddress: Address = "0x0be27c140f9bdad3474beaff0a413ec7e19e9b93";
    const slippageIssuanceModuleAddress: Address = "0x2B67D4F9407F772374CaE8B010dB36A770C2c3ae";
    const usdcAddress: Address = "0x7F5c764cBc14f9669B88837ca1490cCa17c31607";
    const usdcWhaleAddress: Address = "0xEBb8EA128BbdFf9a1780A4902A9380022371d466";
    const wethAddress: Address = "0x4200000000000000000000000000000000000006";
    const uniV3SwapRouterAddress: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const uniV3QuoterAddress: Address = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

    let owner: Account;
    let user: Account;

    let deployer: DeployHelper;
    let setToken: SetToken;

    let exchangeIssuance: FlashMintPerp;
    let slippageIssuanceModule: SlippageIssuanceModule;

    let uniV3Router: SwapRouter02;
    let uniV3Quoter: Quoter;
    let usdc: StandardTokenMock;
    let weth: WETH9;

    cacheBeforeEach(async () => {
      [owner, user] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      setToken = <SetToken>await ethers.getContractAt("ISetToken", MNYeSetTokenAddress);
      slippageIssuanceModule = <SlippageIssuanceModule>(
        await ethers.getContractAt("ISlippageIssuanceModule", slippageIssuanceModuleAddress)
      );
      usdc = <StandardTokenMock>await ethers.getContractAt("StandardTokenMock", usdcAddress);
      weth = <WETH9>await ethers.getContractAt("IWETH", wethAddress);
      uniV3Router = <SwapRouter02>await ethers.getContractAt("ISwapRouter02", uniV3SwapRouterAddress);
      uniV3Quoter = <Quoter>await ethers.getContractAt("IQuoter", uniV3QuoterAddress);

      exchangeIssuance = await deployer.extensions.deployFlashMintPerp(
        uniV3Router.address,
        uniV3Quoter.address,
        slippageIssuanceModule.address,
        usdc.address,
      );

      // prepare 1M USDC
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [usdcWhaleAddress],
      });
      const usdcWhale = await ethers.provider.getSigner(usdcWhaleAddress);
      await usdc.connect(usdcWhale).transfer(user.address, UnitsUtils.usdc(1000000));
    });

    context("when exchange issuance is deployed", async () => {
      describe("#approve", async () => {
        let subjectToken: StandardTokenMock;
        let subjectSpender: Address;
        let subjectAmount: BigNumber;

        beforeEach(async () => {
          subjectToken = usdc;
          subjectSpender = uniV3Router.address;
          subjectAmount = ether(1000);
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuance.approve(
            subjectToken.address,
            subjectSpender,
            subjectAmount,
          );
        }

        it("should update the approvals correctly", async () => {
          await subject();

          const finalAllowance = await subjectToken.allowance(
            exchangeIssuance.address,
            subjectSpender,
          );

          expect(finalAllowance).to.eq(subjectAmount);
        });
      });

      describe("#initializeSet", async () => {
        let subjectSetToken: SetToken;
        let subjectSpotToken: StandardTokenMock | WETH9;
        let subjectSpotToUsdcRoute: string;

        beforeEach(async () => {
          subjectSetToken = setToken;
          subjectSpotToken = weth;
          subjectSpotToUsdcRoute = encodePath([weth.address, usdc.address], [3000]);
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuance.initializeSet(
            subjectSetToken.address,
            subjectSpotToUsdcRoute,
            subjectSpotToken.address,
          );
        }

        it("should initialize setPoolInfo", async () => {
          expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(false);

          await subject();

          const setPoolInfo = await exchangeIssuance.setPoolInfo(subjectSetToken.address);
          expect(setPoolInfo.spotToUsdcRoute).to.eq(subjectSpotToUsdcRoute);
          expect(setPoolInfo.spotToken).to.eq(subjectSpotToken.address);

          expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(true);
        });

        it("should approve tokens correctly", async () => {
          await subject();

          expect(
            await subjectSpotToken.allowance(exchangeIssuance.address, uniV3Router.address),
          ).to.eq(MAX_UINT_256);
          expect(
            await subjectSpotToken.allowance(
              exchangeIssuance.address,
              slippageIssuanceModule.address,
            ),
          ).to.eq(MAX_UINT_256);
        });
      });

      describe("#removeSet", async () => {
        let subjectSetToken: SetToken;

        beforeEach(async () => {
          subjectSetToken = setToken;

          await exchangeIssuance.initializeSet(
            subjectSetToken.address,
            encodePath([weth.address, usdc.address], [3000]),
            weth.address,
          );
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuance.removeSet(subjectSetToken.address);
        }

        it("should initialize setPoolInfo", async () => {
          expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(true);

          await subject();

          const setPoolInfo = await exchangeIssuance.setPoolInfo(subjectSetToken.address);
          expect(setPoolInfo.spotToUsdcRoute).to.eq("0x");
          expect(setPoolInfo.spotToken).to.eq(ADDRESS_ZERO);

          expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(false);
        });
      });

      describe("#issueFixedSetFromUsdc", async () => {
        let subjectCaller: Account;
        let subjectInputToken: StandardTokenMock;
        let subjectSetToken: SetToken;
        let subjectSetTokenAmount: BigNumber;
        let subjectMaxAmountInput: BigNumber;
        let spotToUsdcRoute: string;

        const initializeSubjectVariables = () => {
          subjectCaller = user;
          subjectInputToken = usdc;
          subjectSetToken = setToken;
          subjectSetTokenAmount = ether(1);
          subjectMaxAmountInput = UnitsUtils.usdc(10000);
        };

        cacheBeforeEach(async () => {
          initializeSubjectVariables();

          spotToUsdcRoute = encodePath([weth.address, usdc.address], [3000]);
          await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, weth.address);
          await usdc.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256);
        });

        beforeEach(initializeSubjectVariables);

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuance
            .connect(subjectCaller.wallet)
            .issueFixedSetFromUsdc(
              subjectSetToken.address,
              subjectSetTokenAmount,
              subjectMaxAmountInput,
            );
        }

        it("should issue the correct amount of Set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

          await subject();

          const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
          expect(finalSetBalance).to.eq(initialBalanceOfSet.add(subjectSetTokenAmount));
        });

        it("should use the correct amount of input token from the caller", async () => {
          const initialBalanceOfInputToken = await subjectInputToken.balanceOf(
            subjectCaller.address,
          );
          const expectedInputToken = await getUsdcAmountInForExactSet(
            subjectInputToken,
            subjectSetToken,
            subjectSetTokenAmount,
            slippageIssuanceModule,
            uniV3Quoter,
            spotToUsdcRoute,
          );

          await subject();

          const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
          const expectedTokenBalance = initialBalanceOfInputToken.sub(expectedInputToken);
          expectCloseTo(finalBalanceOfInputToken, expectedTokenBalance, 11); // 11 wei difference
        });
      });

      describe("#redeemFixedSetForUsdc", async () => {
        let subjectCaller: Account;
        let subjectOutputToken: StandardTokenMock;
        let subjectSetToken: SetToken;
        let subjectSetTokenAmount: BigNumber;
        let subjectMinAmountInput: BigNumber;
        let spotToUsdcRoute: string;

        const initializeSubjectVariables = () => {
          subjectCaller = user;
          subjectOutputToken = usdc;
          subjectSetToken = setToken;
          subjectSetTokenAmount = ether(1);
          subjectMinAmountInput = UnitsUtils.usdc(50);
        };

        cacheBeforeEach(async () => {
          initializeSubjectVariables();
          spotToUsdcRoute = encodePath([weth.address, usdc.address], [3000]);

          await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, weth.address);
          await usdc.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256);
          await exchangeIssuance
            .connect(subjectCaller.wallet)
            .issueFixedSetFromUsdc(
              subjectSetToken.address,
              subjectSetTokenAmount,
              UnitsUtils.usdc(10000),
            );

          await setToken
            .connect(subjectCaller.wallet)
            .approve(exchangeIssuance.address, MAX_UINT_256);
        });

        beforeEach(initializeSubjectVariables);

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuance
            .connect(subjectCaller.wallet)
            .redeemFixedSetForUsdc(
              subjectSetToken.address,
              subjectSetTokenAmount,
              subjectMinAmountInput,
            );
        }

        it("should redeem the correct amount of set from the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

          await subject();

          const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
          expect(finalSetBalance).to.eq(initialBalanceOfSet.sub(subjectSetTokenAmount));
        });

        it("should return the correct amount of output token to the caller", async () => {
          const initialBalanceOfOutputToken = await subjectOutputToken.balanceOf(
            subjectCaller.address,
          );
          const expectedOutputToken = await getUsdcAmountOutForExactSet(
            subjectOutputToken,
            subjectSetToken,
            subjectSetTokenAmount,
            slippageIssuanceModule,
            uniV3Quoter,
            spotToUsdcRoute,
          );

          await subject();

          const finalBalanceOfOutputToken = await subjectOutputToken.balanceOf(
            subjectCaller.address,
          );
          const expectedTokenBalance = initialBalanceOfOutputToken.add(expectedOutputToken);
          expectCloseTo(finalBalanceOfOutputToken, expectedTokenBalance, 1); // 1 wei difference
        });
      });

      describe("#getUsdcAmountInForFixedSetOffChain", async () => {
        let subjectInputToken: StandardTokenMock;
        let subjectSetToken: SetToken;
        let subjectSetTokenAmount: BigNumber;
        let spotToUsdcRoute: string;

        beforeEach(async () => {
          subjectInputToken = usdc;
          subjectSetToken = setToken;
          subjectSetTokenAmount = ether(0.1);
          spotToUsdcRoute = encodePath([weth.address, usdc.address], [3000]);

          await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, weth.address);
        });

        async function subject(): Promise<BigNumber> {
          return await exchangeIssuance.callStatic.getUsdcAmountInForFixedSetOffChain(
            subjectSetToken.address,
            subjectSetTokenAmount,
          );
        }

        it("should return correct amount of set", async () => {
          expect(await subject()).to.eq(
            await getUsdcAmountInForExactSet(
              subjectInputToken,
              subjectSetToken,
              subjectSetTokenAmount,
              slippageIssuanceModule,
              uniV3Quoter,
              spotToUsdcRoute,
            ),
          );
        });
      });

      describe("#getUsdcAmountOutForFixedSetOffChain", async () => {
        let subjectOutputToken: StandardTokenMock;
        let subjectSetToken: SetToken;
        let subjectSetTokenAmount: BigNumber;
        let spotToUsdcRoute: string;

        beforeEach(async () => {
          subjectOutputToken = usdc;
          subjectSetToken = setToken;
          subjectSetTokenAmount = ether(0.1);
          spotToUsdcRoute = encodePath([weth.address, usdc.address], [3000]);

          await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, weth.address);
        });

        async function subject(): Promise<BigNumber> {
          return await exchangeIssuance.callStatic.getUsdcAmountOutForFixedSetOffChain(
            subjectSetToken.address,
            subjectSetTokenAmount,
          );
        }

        it("should return correct amount of usdc", async () => {
          expect(await subject()).to.eq(
            await getUsdcAmountOutForExactSet(
              subjectOutputToken,
              subjectSetToken,
              subjectSetTokenAmount,
              slippageIssuanceModule,
              uniV3Quoter,
              spotToUsdcRoute,
            ),
          );
        });
      });
    });
  });
}
