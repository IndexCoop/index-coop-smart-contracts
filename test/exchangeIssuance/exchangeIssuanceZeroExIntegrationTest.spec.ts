import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import { cacheBeforeEach, ether, getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { ExchangeIssuanceZeroEx, StandardTokenMock, WETH9 } from "@utils/contracts/index";
import axios from "axios";
import qs from "qs";
import hre, { ethers } from "hardhat";

const expect = getWaffleExpect();

type ZeroExSwapQuote = {
  sellToken: Address;
  buyToken: Address;
  swapCallData: string;
};

type SetTokenScenario = {
  setToken: Address;
  controller: Address;
  issuanceModule: Address;
};

type TokenName = "SimpleToken" | "DPI";

function logIfVerboseMode(...args: any[]) {
  if (process.env.VERBOSE) console.log(...args);
}

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceZeroEx - Integration Test", async () => {
    let owner: Account;

    let setV2Setup: SetFixture;
    let deployer: DeployHelper;

    // Contract Addresses
    let wethAddress: Address;
    let wbtcAddress: Address;
    let daiAddress: Address;
    let zeroExProxyAddress: Address;
    let controllerAddress: Address;
    let issuanceModuleAddress: Address;
    const DPI_ADDRESS: Address = "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b";

    // Contract Instances
    let wbtc: StandardTokenMock;
    let dai: StandardTokenMock;
    let weth: WETH9;
    let exchangeIssuanceZeroEx: ExchangeIssuanceZeroEx;
    let simpleSetToken: SetToken;
    let setToken: SetToken;

    let daiUnits: BigNumber;
    let wbtcUnits: BigNumber;

    const setTokenScenarios: Partial<Record<TokenName, SetTokenScenario>> = {};
    // Test Parameterization
    const SET_TOKEN_NAMES: TokenName[] = ["SimpleToken", "DPI"];
    const SET_TOKEN_AMOUNTS: Record<TokenName, number[]> = {
      SimpleToken: [1],
      DPI: [1, 100, 1000],
    };

    cacheBeforeEach(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setV2Setup = getSetFixture(owner.address);
      await setV2Setup.initialize();

      ({ dai, wbtc, weth } = setV2Setup);
    });

    async function deployExchangeIssuanceZeroEx() {
      exchangeIssuanceZeroEx = await deployer.extensions.deployExchangeIssuanceZeroEx(
        wethAddress,
        controllerAddress,
        issuanceModuleAddress,
        zeroExProxyAddress,
      );
    }

    cacheBeforeEach(async () => {
      // Mainnet addresses
      wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
      daiAddress = "0x6b175474e89094c44da98b954eedeac495271d0f";
      wbtcAddress = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
      zeroExProxyAddress = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

      dai = dai.attach(daiAddress);
      weth = weth.attach(wethAddress);
      wbtc = wbtc.attach(wbtcAddress);

      daiUnits = BigNumber.from("23252699054621733");
      wbtcUnits = UnitsUtils.wbtc(0.005);
      simpleSetToken = await setV2Setup.createSetToken(
        [daiAddress, wbtcAddress],
        [daiUnits, wbtcUnits],
        [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.issuanceModule.initialize(simpleSetToken.address, ADDRESS_ZERO);

      setTokenScenarios["SimpleToken"] = {
        setToken: simpleSetToken.address,
        controller: setV2Setup.controller.address,
        issuanceModule: setV2Setup.issuanceModule.address,
      };

      const dpiToken = simpleSetToken.attach(DPI_ADDRESS);
      const dpiController = await dpiToken.controller();
      const [dpiIssuanceModule] = await dpiToken.getModules();

      setTokenScenarios["DPI"] = {
        setToken: DPI_ADDRESS,
        controller: dpiController,
        issuanceModule: dpiIssuanceModule,
      };
    });

    const API_QUOTE_URL = "https://api.0x.org/swap/v1/quote";
    async function getQuote(params: any) {
      const url = `${API_QUOTE_URL}?${qs.stringify(params)}`;
      logIfVerboseMode(`Getting quote from ${params.sellToken} to ${params.buyToken}`);
      logIfVerboseMode("Sending quote request to:", url);
      const response = await axios(url);
      return response.data;
    }

    async function logQuote(quote: any) {
      logIfVerboseMode("Sell Amount:", quote.sellAmount);
      logIfVerboseMode("Buy Amount:", quote.buyAmount);
      logIfVerboseMode("Swap Target:", quote.to);
      logIfVerboseMode("Allowance Target:", quote.allowanceTarget);
      logIfVerboseMode(
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
      const implementation = await proxyContract.getFunctionImplementation(callData.slice(0, 10));
      logIfVerboseMode("Implementation Address: ", implementation);
      const abiResponse = await axios.get(ABI_ENDPOINT + implementation);
      const abi = JSON.parse(abiResponse.data.result);
      const iface = new ethers.utils.Interface(abi);
      const decodedTransaction = iface.parseTransaction({
        data: callData,
      });
      logIfVerboseMode("Called Function Signature: ", decodedTransaction.signature);
    }

    for (const tokenName of SET_TOKEN_NAMES) {
      context(`When set token is ${tokenName}`, () => {
        beforeEach(async () => {
          const scenario = setTokenScenarios[tokenName];
          if (scenario != undefined) {
            controllerAddress = scenario.controller;
            issuanceModuleAddress = scenario.issuanceModule;
            setToken = simpleSetToken.attach(scenario.setToken);
          }
        });
        for (const setTokenAmount of SET_TOKEN_AMOUNTS[tokenName]) {
          context(`When set token amount is ${setTokenAmount}`, () => {
            describe("#issueExactSetFromToken", async () => {
              let subjectInputToken: StandardTokenMock | WETH9;
              let subjectInputTokenAmount: BigNumber;
              let subjectAmountSetToken: number;
              let subjectAmountSetTokenWei: BigNumber;
              let subjectInputSwapQuote: ZeroExSwapQuote;
              let subjectPositionSwapQuotes: ZeroExSwapQuote[];

              // Helper function to generate 0xAPI quote for UniswapV2
              async function getQuotes(
                setToken: SetToken,
                inputTokenAddress: Address,
                setAmount: number,
                slippagePercents: number,
                excludedSources: string | undefined = undefined,
              ): Promise<[ZeroExSwapQuote, ZeroExSwapQuote[], BigNumber]> {
                const positions = await setToken.getPositions();
                const positionQuotes: ZeroExSwapQuote[] = [];
                let buyAmountWeth = BigNumber.from(0);
                const slippagePercentage = slippagePercents / 100;

                for (const position of positions) {
                  logIfVerboseMode("\n\n###################COMPONENT QUOTE##################");
                  const buyAmount = position.unit.mul(setAmount).toString();
                  const buyToken = position.component;
                  const sellToken = wethAddress;
                  const quote = await getQuote({
                    buyToken,
                    sellToken,
                    buyAmount,
                    excludedSources,
                    slippagePercentage,
                  });
                  await logQuote(quote);
                  positionQuotes.push({
                    sellToken: sellToken,
                    buyToken: buyToken,
                    swapCallData: quote.data,
                  });
                  buyAmountWeth = buyAmountWeth.add(BigNumber.from(quote.sellAmount));
                }
                // I assume that this is the correct math to make sure we have enough weth to cover the slippage
                // based on the fact that the slippagePercentage is limited between 0.0 and 1.0 on the 0xApi
                // TODO: Review if correct
                buyAmountWeth = buyAmountWeth.mul(100).div(100 - slippagePercents);

                logIfVerboseMode("\n\n###################INPUT TOKEN QUOTE##################");
                const inputTokenApiResponse = await getQuote({
                  buyToken: wethAddress,
                  sellToken: inputTokenAddress,
                  buyAmount: buyAmountWeth.toString(),
                  excludedSources,
                  slippagePercentage,
                });
                await logQuote(inputTokenApiResponse);
                let inputTokenAmount = BigNumber.from(inputTokenApiResponse.sellAmount);
                inputTokenAmount = inputTokenAmount.mul(100).div(100 - slippagePercents);
                logIfVerboseMode("Input token amount", inputTokenAmount.toString());
                const inputQuote = {
                  buyToken: wethAddress,
                  sellToken: inputTokenAddress,
                  swapCallData: inputTokenApiResponse.data,
                };
                return [inputQuote, positionQuotes, inputTokenAmount];
              }

              const initializeSubjectVariables = async (_amountSetToken: number) => {
                // TODO: Analyse what a good value would be in production
                const SLIPPAGE_PERCENTAGE = 50;

                subjectInputToken = dai;
                subjectAmountSetToken = _amountSetToken;
                subjectAmountSetTokenWei = ether(subjectAmountSetToken);
                [
                  subjectInputSwapQuote,
                  subjectPositionSwapQuotes,
                  subjectInputTokenAmount,
                ] = await getQuotes(
                  setToken,
                  subjectInputToken.address,
                  subjectAmountSetToken,
                  SLIPPAGE_PERCENTAGE,
                );
              };

              async function obtainAndApproveInputToken() {
                const inputTokenWhaleAddress = "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549";
                const whaleTokenBalance = await subjectInputToken.balanceOf(inputTokenWhaleAddress);

                if (whaleTokenBalance.gt(0)) {
                  logIfVerboseMode(
                    "\n\n###################OBTAIN INPUT TOKEN FROM WHALE##################",
                  );
                  await hre.network.provider.request({
                    method: "hardhat_impersonateAccount",
                    params: [inputTokenWhaleAddress],
                  });
                  const inputTokenWhaleSigner = ethers.provider.getSigner(inputTokenWhaleAddress);
                  await subjectInputToken
                    .connect(inputTokenWhaleSigner)
                    .transfer(owner.address, whaleTokenBalance);
                  logIfVerboseMode(
                    "New owner balance",
                    ethers.utils.formatEther(await subjectInputToken.balanceOf(owner.address)),
                  );
                }

                subjectInputToken.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
              }

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

              beforeEach(async () => {
                await deployExchangeIssuanceZeroEx();
                await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
                await initializeSubjectVariables(setTokenAmount);
                await obtainAndApproveInputToken();
              });
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
    }
  });
}
