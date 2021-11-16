import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_96, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getRandomAddress,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import {
  ExchangeIssuanceZeroEx,
  ZeroExExchangeProxyMock,
  StandardTokenMock,
  WETH9,
} from "@utils/contracts/index";
import { getAllowances } from "@utils/common/exchangeIssuanceUtils";
import axios from "axios";
import qs from "qs";
import hre, { ethers } from "hardhat";

const expect = getWaffleExpect();

type ZeroExSwapQuote = {
  sellToken: Address;
  buyToken: Address;
  swapCallData: string;
};

describe("ExchangeIssuanceZeroEx", async () => {
  let owner: Account;

  let setV2Setup: SetFixture;
  let zeroExMock: ZeroExExchangeProxyMock;
  let deployer: DeployHelper;

  let setToken: SetToken;
  let wbtc: StandardTokenMock;
  let dai: StandardTokenMock;
  let weth: WETH9;

  let daiUnits: BigNumber;
  let wbtcUnits: BigNumber;

  cacheBeforeEach(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    ({ dai, wbtc, weth } = setV2Setup);

    zeroExMock = await deployer.mocks.deployZeroExExchangeProxyMock();

    daiUnits = BigNumber.from("23252699054621733");
    wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [dai.address, wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
    );
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
  });

  if (!process.env.INTEGRATIONTEST) {
    describe("#constructor", async () => {
      let subjectWethAddress: Address;
      let subjectControllerAddress: Address;
      let subjectBasicIssuanceModuleAddress: Address;
      let subjectSwapTarget: Address;

      cacheBeforeEach(async () => {
        subjectWethAddress = weth.address;
        subjectBasicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
        subjectControllerAddress = setV2Setup.controller.address;
        subjectSwapTarget = zeroExMock.address;
      });

      async function subject(): Promise<ExchangeIssuanceZeroEx> {
        return await deployer.extensions.deployExchangeIssuanceZeroEx(
          subjectWethAddress,
          subjectControllerAddress,
          subjectBasicIssuanceModuleAddress,
          subjectSwapTarget,
        );
      }

      it("verify state set properly via constructor", async () => {
        const exchangeIssuanceContract: ExchangeIssuanceZeroEx = await subject();

        const expectedWethAddress = await exchangeIssuanceContract.WETH();
        expect(expectedWethAddress).to.eq(subjectWethAddress);

        const expectedControllerAddress = await exchangeIssuanceContract.setController();
        expect(expectedControllerAddress).to.eq(subjectControllerAddress);

        const expectedBasicIssuanceModuleAddress = await exchangeIssuanceContract.basicIssuanceModule();
        expect(expectedBasicIssuanceModuleAddress).to.eq(subjectBasicIssuanceModuleAddress);

        const swapTarget = await exchangeIssuanceContract.swapTarget();
        expect(swapTarget).to.eq(subjectSwapTarget);
      });
    });

    context("when exchange issuance is deployed", async () => {
      let wethAddress: Address;
      let controllerAddress: Address;
      let basicIssuanceModuleAddress: Address;
      let exchangeIssuanceZeroEx: ExchangeIssuanceZeroEx;

      cacheBeforeEach(async () => {
        wethAddress = weth.address;
        controllerAddress = setV2Setup.controller.address;
        basicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
        exchangeIssuanceZeroEx = await deployer.extensions.deployExchangeIssuanceZeroEx(
          wethAddress,
          controllerAddress,
          basicIssuanceModuleAddress,
          zeroExMock.address,
        );
      });

      describe("#approveSetToken", async () => {
        let subjectSetToApprove: SetToken | StandardTokenMock;

        beforeEach(async () => {
          subjectSetToApprove = setToken;
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuanceZeroEx.approveSetToken(subjectSetToApprove.address);
        }
        it("should update the approvals correctly", async () => {
          const tokens = [dai, dai];
          const spenders = [basicIssuanceModuleAddress];

          await subject();

          const finalAllowances = await getAllowances(
            tokens,
            exchangeIssuanceZeroEx.address,
            spenders,
          );

          for (let i = 0; i < finalAllowances.length; i++) {
            const actualAllowance = finalAllowances[i];
            const expectedAllowance = MAX_UINT_96;
            expect(actualAllowance).to.eq(expectedAllowance);
          }
        });

        context("when the input token is not a set", async () => {
          beforeEach(async () => {
            subjectSetToApprove = dai;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET");
          });
        });
      });

      describe("#setSwapTarget", async () => {
        let subjectSwapTarget: Address;

        beforeEach(async () => {
          subjectSwapTarget = await getRandomAddress();
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuanceZeroEx.setSwapTarget(subjectSwapTarget);
        }
        it("should update the swap target correctly", async () => {
          await subject();
          const swapTarget = await exchangeIssuanceZeroEx.swapTarget();
          expect(swapTarget).to.eq(subjectSwapTarget);
        });
      });

      describe("#issueExactSetFromToken", async () => {
        let subjectInputToken: StandardTokenMock | WETH9;
        let subjectInputTokenAmount: BigNumber;
        let subjectWethAmount: BigNumber;
        let subjectAmountSetToken: number;
        let subjectAmountSetTokenWei: BigNumber;
        let subjectInputSwapQuote: ZeroExSwapQuote;
        let subjectPositionSwapQuotes: ZeroExSwapQuote[];

        // Helper function to generate 0xAPI quote for UniswapV2
        function getUniswapV2Quote(
          sellToken: Address,
          sellAmount: BigNumber,
          buyToken: Address,
          minBuyAmount: BigNumber,
        ): ZeroExSwapQuote {
          const isSushi = false;
          return {
            sellToken,
            buyToken,
            swapCallData: zeroExMock.interface.encodeFunctionData("sellToUniswap", [
              [sellToken, buyToken],
              sellAmount,
              minBuyAmount,
              isSushi,
            ]),
          };
        }

        const initializeSubjectVariables = async () => {
          subjectInputTokenAmount = ether(1000);
          subjectInputToken = dai;
          subjectWethAmount = ether(1);
          subjectAmountSetToken = 1;
          subjectAmountSetTokenWei = ether(subjectAmountSetToken);
          subjectInputSwapQuote = getUniswapV2Quote(
            dai.address,
            subjectInputTokenAmount,
            weth.address,
            subjectWethAmount,
          );

          const positions = await setToken.getPositions();
          subjectPositionSwapQuotes = positions.map(position =>
            getUniswapV2Quote(
              weth.address,
              subjectWethAmount.div(2),
              position.component,
              position.unit.mul(subjectAmountSetToken),
            ),
          );
        };

        beforeEach(async () => {
          initializeSubjectVariables();
          await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
          dai.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
          await weth.transfer(zeroExMock.address, subjectWethAmount);
          await wbtc.transfer(zeroExMock.address, wbtcUnits.mul(subjectAmountSetToken));
          await dai.transfer(zeroExMock.address, daiUnits.mul(subjectAmountSetToken));
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuanceZeroEx.issueExactSetFromToken(
            setToken.address,
            subjectInputToken.address,
            subjectInputSwapQuote,
            subjectAmountSetTokenWei,
            subjectInputTokenAmount,
            subjectPositionSwapQuotes,
          );
        }

        it("should issue correct amount of set tokens", async () => {
          const initialBalanceOfSet = await setToken.balanceOf(owner.address);
          await subject();
          const finalSetBalance = await setToken.balanceOf(owner.address);
          const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });

        it("should use correct amount of input tokens", async () => {
          const initialBalanceOfInput = await subjectInputToken.balanceOf(owner.address);
          await subject();
          const finalInputBalance = await subjectInputToken.balanceOf(owner.address);
          const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
          expect(finalInputBalance).to.eq(expectedInputBalance);
        });

        context("when the input swap generates surplus WETH", async () => {
          beforeEach(async () => {
            await weth.transfer(zeroExMock.address, subjectWethAmount);
            await zeroExMock.setBuyMultiplier(weth.address, ether(2));
          });
          it("should return surplus WETH to user", async () => {
            const initialBalanceOfSet = await setToken.balanceOf(owner.address);
            const wethBalanceBefore = await weth.balanceOf(owner.address);
            await subject();
            const finalSetBalance = await setToken.balanceOf(owner.address);
            const wethBalanceAfter = await weth.balanceOf(owner.address);
            const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
            const expectedWethBalance = wethBalanceBefore.add(subjectWethAmount);
            expect(wethBalanceAfter).to.equal(expectedWethBalance);
            expect(finalSetBalance).to.eq(expectedSetBalance);
          });
        });

        context("when the input token is weth", async () => {
          beforeEach(async () => {
            subjectInputToken = weth;
            subjectInputTokenAmount = subjectWethAmount;
            await weth.approve(exchangeIssuanceZeroEx.address, subjectInputTokenAmount);
          });
          it("should issue correct amount of set tokens", async () => {
            const initialBalanceOfSet = await setToken.balanceOf(owner.address);
            await subject();
            const finalSetBalance = await setToken.balanceOf(owner.address);
            const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
            expect(finalSetBalance).to.eq(expectedSetBalance);
          });
          it("should use correct amount of input tokens", async () => {
            const initialBalanceOfInput = await subjectInputToken.balanceOf(owner.address);
            await subject();
            const finalInputBalance = await subjectInputToken.balanceOf(owner.address);
            const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
            expect(finalInputBalance).to.eq(expectedInputBalance);
          });
        });

        context("when a position quote is missing", async () => {
          beforeEach(async () => {
            subjectPositionSwapQuotes = [subjectPositionSwapQuotes[0]];
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("WRONG NUMBER OF COMPONENT QUOTES");
          });
        });

        context("when a position quote has the wrong buyTokenAddress", async () => {
          beforeEach(async () => {
            subjectPositionSwapQuotes[0].buyToken = await getRandomAddress();
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("COMPONENT / QUOTE ADDRESS MISMATCH");
          });
        });

        context("when a position quote has a non-WETH sellToken address", async () => {
          beforeEach(async () => {
            subjectPositionSwapQuotes[0].sellToken = await getRandomAddress();
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("INVALID SELL TOKEN");
          });
        });

        context("when the input swap yields insufficient WETH", async () => {
          beforeEach(async () => {
            await zeroExMock.setBuyMultiplier(weth.address, ether(0.5));
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SWAP CALL FAILED");
          });
        });

        context("when a component swap spends too much weth", async () => {
          beforeEach(async () => {
            // Simulate left over weth balance left in contract
            await weth.transfer(exchangeIssuanceZeroEx.address, subjectWethAmount);
            await zeroExMock.setSellMultiplier(weth.address, ether(2));
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("OVERSPENT WETH");
          });
        });

        context("when a component swap yields insufficient component token", async () => {
          beforeEach(async () => {
            // Simulating left over component balance left in contract
            await wbtc.transfer(exchangeIssuanceZeroEx.address, wbtcUnits);
            await zeroExMock.setBuyMultiplier(wbtc.address, ether(0.5));
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("UNDERBOUGHT COMPONENT");
          });
        });

        context("when a swap call fails", async () => {
          beforeEach(async () => {
            // Trigger revertion in mock by trying to return more buy tokens than available in balance
            await zeroExMock.setBuyMultiplier(wbtc.address, ether(100));
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("SWAP CALL FAILED");
          });
        });
      });
    });
  }
  if (process.env.INTEGRATIONTEST) {
    context("integration tests", async () => {
      let wethAddress: Address;
      let wbtcAddress: Address;
      let daiAddress: Address;
      let basicIssuanceModuleAddress: Address;
      let exchangeIssuanceZeroEx: ExchangeIssuanceZeroEx;
      let zeroExProxyAddress: Address;
      let setToken: SetToken;

      cacheBeforeEach(async () => {
        // Mainnet addresses
        wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
        daiAddress = "0x6b175474e89094c44da98b954eedeac495271d0f";
        wbtcAddress = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
        basicIssuanceModuleAddress = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D";
        zeroExProxyAddress = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

        dai = dai.attach(daiAddress);
        weth = weth.attach(wethAddress);
        wbtc = wbtc.attach(wbtcAddress);
        setToken = await setV2Setup.createSetToken(
          [daiAddress, wbtcAddress],
          [daiUnits, wbtcUnits],
          [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
        );

        exchangeIssuanceZeroEx = await deployer.extensions.deployExchangeIssuanceZeroEx(
          wethAddress,
          setV2Setup.controller.address,
          setV2Setup.issuanceModule.address,
          zeroExProxyAddress,
        );
        await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      });

      describe("#approveSetToken", async () => {
        let subjectSetToApprove: SetToken | StandardTokenMock;

        beforeEach(async () => {
          subjectSetToApprove = setToken;
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuanceZeroEx.approveSetToken(subjectSetToApprove.address);
        }
        it("should update the approvals correctly", async () => {
          const tokens = [dai, wbtc];
          const spenders = [basicIssuanceModuleAddress];

          await subject();

          const finalAllowances = await getAllowances(
            tokens,
            exchangeIssuanceZeroEx.address,
            spenders,
          );

          for (let i = 0; i < finalAllowances.length; i++) {
            const actualAllowance = finalAllowances[i];
            const expectedAllowance = MAX_UINT_96;
            expect(actualAllowance).to.eq(expectedAllowance);
          }
        });

        context("when the input token is not a set", async () => {
          beforeEach(async () => {
            subjectSetToApprove = dai;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET");
          });
        });
      });

      describe("#setSwapTarget", async () => {
        let subjectSwapTarget: Address;

        beforeEach(async () => {
          subjectSwapTarget = await getRandomAddress();
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuanceZeroEx.setSwapTarget(subjectSwapTarget);
        }
        it("should update the swap target correctly", async () => {
          await subject();
          const swapTarget = await exchangeIssuanceZeroEx.swapTarget();
          expect(swapTarget).to.eq(subjectSwapTarget);
        });
      });

      describe("#issueExactSetFromToken", async () => {
        let subjectInputToken: StandardTokenMock | WETH9;
        let subjectInputTokenAmount: BigNumber;
        let subjectAmountSetToken: number;
        let subjectAmountSetTokenWei: BigNumber;
        let subjectInputSwapQuote: ZeroExSwapQuote;
        let subjectPositionSwapQuotes: ZeroExSwapQuote[];

        const API_QUOTE_URL = "https://api.0x.org/swap/v1/quote";
        async function getQuote(params: any) {
          const url = `${API_QUOTE_URL}?${qs.stringify(params)}`;
          console.log(`Getting quote from ${params.sellToken} to ${params.buyToken}`);
          console.log("Sending quote request to:", url);
          const response = await axios(url);
          return response.data;
        }

        async function logQuote(quote: any) {
          console.log("Sell Amount:", quote.sellAmount);
          console.log("Buy Amount:", quote.buyAmount);
          console.log("Swap Target:", quote.to);
          console.log("Allowance Target:", quote.allowanceTarget);
          console.log(
            "Sources:",
            quote.sources.filter((source: any) => source.proportion > "0"),
          );
          await decodeCallData(quote.data, quote.to);
        }

        async function decodeCallData(callData: string, proxyAddress: Address) {
          const API_KEY = "X28YB9Z9TQD4KSSC6A6QTKHYGPYGIP8D7I";
          const ABI_ENDPOINT = `https://api.etherscan.io/api?module=contract&action=getabi&apikey=${API_KEY}&address=`;
          const proxyAbi = await axios
            .get(ABI_ENDPOINT + proxyAddress)
            .then(response => JSON.parse(response.data.result));
          const proxyContract = await ethers.getContractAt(proxyAbi, proxyAddress);
          await proxyContract.deployed();
          const implementation = await proxyContract.getFunctionImplementation(
            callData.slice(0, 10),
          );
          console.log("Implementation Address: ", implementation);
          const abiResponse = await axios.get(ABI_ENDPOINT + implementation);
          const abi = JSON.parse(abiResponse.data.result);
          const iface = new ethers.utils.Interface(abi);
          const decodedTransaction = iface.parseTransaction({
            data: callData,
          });
          console.log("Called Function Signature: ", decodedTransaction.signature);
        }

        // Helper function to generate 0xAPI quote for UniswapV2
        async function getQuotes(
          setToken: SetToken,
          inputTokenAddress: Address,
          setAmount: number,
          inputTokenMultiplierPercentage: number,
          wethMultiplierPercentage: number,
          excludedSources: string | undefined = undefined,
        ): Promise<[ZeroExSwapQuote, ZeroExSwapQuote[], BigNumber]> {
          const positions = await setToken.getPositions();
          const positionQuotes: ZeroExSwapQuote[] = [];
          let buyAmountWeth = BigNumber.from(0);

          for (const position of positions) {
            console.log("\n\n###################COMPONENT QUOTE##################");
            const buyAmount = position.unit.mul(setAmount).toString();
            const buyToken = position.component;
            const sellToken = wethAddress;
            const quote = await getQuote({ buyToken, sellToken, buyAmount, excludedSources });
            await logQuote(quote);
            positionQuotes.push({
              sellToken: sellToken,
              buyToken: buyToken,
              swapCallData: quote.data,
            });
            buyAmountWeth = buyAmountWeth.add(BigNumber.from(quote.sellAmount));
          }

          buyAmountWeth = buyAmountWeth.mul(wethMultiplierPercentage).div(100);

          console.log("\n\n###################INPUT TOKEN QUOTE##################");
          const inputTokenApiResponse = await getQuote({
            buyToken: wethAddress,
            sellToken: inputTokenAddress,
            buyAmount: buyAmountWeth.toString(),
          });
          await logQuote(inputTokenApiResponse);
          const inputTokenAmount = BigNumber.from(inputTokenApiResponse.sellAmount)
            .mul(inputTokenMultiplierPercentage)
            .div(100);
          console.log("Input token amount", inputTokenAmount.toString());
          const inputQuote = {
            buyToken: wethAddress,
            sellToken: inputTokenAddress,
            swapCallData: inputTokenApiResponse.data,
          };
          return [inputQuote, positionQuotes, inputTokenAmount];
        }

        const initializeSubjectVariables = async () => {
          // Currently "invalid dai balance" errors get thrown by ZeroEx UniswapV3Feature when we transfer only the sellAmount returned by 0xAPI
          // so we add some margin for extra safety
          // TODO: Review to understand why this happens and how to handle in production
          const INPUT_TOKEN_MULTIPLIER_PERCENTAGE = 110;
          const WETH_MULTIPLIER_PERCENTAGE = 110;
          // During testing swaps including Sushi frequently reverted, so excluding it for now
          // TODO: Review to understand why this happens and how to handle in production
          const EXCLUDED_SOURCES = "SushiSwap";

          subjectInputToken = dai;
          subjectAmountSetToken = 1;
          subjectAmountSetTokenWei = ether(subjectAmountSetToken);
          [
            subjectInputSwapQuote,
            subjectPositionSwapQuotes,
            subjectInputTokenAmount,
          ] = await getQuotes(
            setToken,
            subjectInputToken.address,
            subjectAmountSetToken,
            INPUT_TOKEN_MULTIPLIER_PERCENTAGE,
            WETH_MULTIPLIER_PERCENTAGE,
            EXCLUDED_SOURCES,
          );
        };

        beforeEach(async () => {
          await initializeSubjectVariables();
          await exchangeIssuanceZeroEx.approveSetToken(setToken.address);

          console.log("\n\n###################OBTAIN INPUT TOKEN FROM WHALE##################");
          const inputTokenWhaleAddress = "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549";
          await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [inputTokenWhaleAddress],
          });
          const inputTokenWhaleSigner = ethers.provider.getSigner(inputTokenWhaleAddress);
          const whaleTokenBalance = await subjectInputToken.balanceOf(inputTokenWhaleAddress);
          await subjectInputToken
            .connect(inputTokenWhaleSigner)
            .transfer(owner.address, whaleTokenBalance);
          console.log(
            "New owner balance",
            (await subjectInputToken.balanceOf(owner.address)).toString(),
          );
          subjectInputToken.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
          subjectInputTokenAmount = await subjectInputToken.balanceOf(owner.address);
        });

        async function subject(): Promise<ContractTransaction> {
          return await exchangeIssuanceZeroEx.issueExactSetFromToken(
            setToken.address,
            subjectInputToken.address,
            subjectInputSwapQuote,
            subjectAmountSetTokenWei,
            subjectInputTokenAmount,
            subjectPositionSwapQuotes,
          );
        }

        it("should issue correct amount of set tokens", async () => {
          const initialBalanceOfSet = await setToken.balanceOf(owner.address);
          await subject();
          const finalSetBalance = await setToken.balanceOf(owner.address);
          const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });
      });
    });
  }
});
