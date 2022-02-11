import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import { ether, getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { ExchangeIssuanceZeroEx, StandardTokenMock, WETH9 } from "@utils/contracts/index";
import axios from "axios";
import qs from "qs";
import hre, { ethers } from "hardhat";

const expect = getWaffleExpect();

type SetTokenScenario = {
  setToken: Address;
  controller: Address;
  issuanceModuleAddress: Address;
  isDebtIssuance: boolean;
};

type TokenName = "SimpleToken" | "DPI";

function logVerbose(...args: any[]) {
  if (process.env.VERBOSE) console.log(...args);
}

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceZeroEx - Integration Test", async () => {
    let owner: Account;
    let user: Account;

    let setV2Setup: SetFixture;
    let deployer: DeployHelper;

    // Contract Addresses
    let wethAddress: Address;
    let wbtcAddress: Address;
    let daiAddress: Address;
    let dpiAddress: Address;
    let zeroExProxyAddress: Address;
    let controllerAddress: Address;
    let issuanceModuleAddress: Address;
    let isDebtIssuance: boolean;

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
    const SET_TOKEN_NAMES: TokenName[] = ["DPI", "SimpleToken"];
    const SET_TOKEN_AMOUNTS: Record<TokenName, number[]> = {
      SimpleToken: [1],
      DPI: [3000, 1],
    };

    async function deployExchangeIssuanceZeroEx() {
      exchangeIssuanceZeroEx = await deployer.extensions.deployExchangeIssuanceZeroEx(
        wethAddress,
        controllerAddress,
        zeroExProxyAddress,
      );
    }

    before(async () => {
      [owner, user] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      setV2Setup = getSetFixture(owner.address);
      await setV2Setup.initialize();

      ({ dai, wbtc, weth } = setV2Setup);
      // Mainnet addresses
      wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
      daiAddress = "0x6b175474e89094c44da98b954eedeac495271d0f";
      wbtcAddress = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
      zeroExProxyAddress = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";
      dpiAddress = "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b";

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
        issuanceModuleAddress: setV2Setup.issuanceModule.address,
        isDebtIssuance: false,
      };

      const dpiToken = simpleSetToken.attach(dpiAddress);
      const dpiController = await dpiToken.controller();
      const [dpiIssuanceModule] = await dpiToken.getModules();

      setTokenScenarios["DPI"] = {
        setToken: dpiAddress,
        controller: dpiController,
        issuanceModuleAddress: dpiIssuanceModule,
        isDebtIssuance: false,
      };
    });

    const API_QUOTE_URL = "https://api.0x.org/swap/v1/quote";
    async function getQuote(params: any) {
      const url = `${API_QUOTE_URL}?${qs.stringify(params)}`;
      logVerbose(`Getting quote from ${params.sellToken} to ${params.buyToken}`);
      logVerbose("Sending quote request to:", url);
      const response = await axios(url);
      return response.data;
    }

    async function logQuote(quote: any) {
      logVerbose("Sell Amount:", quote.sellAmount);
      logVerbose("Buy Amount:", quote.buyAmount);
      logVerbose("Swap Target:", quote.to);
      logVerbose("Allowance Target:", quote.allowanceTarget);
      logVerbose(
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
      logVerbose("Implementation Address: ", implementation);
      const abiResponse = await axios.get(ABI_ENDPOINT + implementation);
      const abi = JSON.parse(abiResponse.data.result);
      const iface = new ethers.utils.Interface(abi);
      const decodedTransaction = iface.parseTransaction({
        data: callData,
      });
      logVerbose("Called Function Signature: ", decodedTransaction.signature);
    }

    for (const tokenName of SET_TOKEN_NAMES) {
      context(`When set token is ${tokenName}`, () => {
        beforeEach(async () => {
          const scenario = setTokenScenarios[tokenName];
          if (scenario != undefined) {
            controllerAddress = scenario.controller;
            issuanceModuleAddress = scenario.issuanceModuleAddress;
            isDebtIssuance = scenario.isDebtIssuance;
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
              let subjectPositionSwapQuotes: string[];

              async function getIssuanceQuotes(
                setToken: SetToken,
                inputTokenAddress: Address,
                setAmount: number,
                slippagePercents: number,
                excludedSources: string | undefined = undefined,
              ): Promise<[string[], BigNumber]> {
                const positions = await setToken.getPositions();
                const positionQuotes: string[] = [];
                let inputTokenAmount = BigNumber.from(0);
                // 0xAPI expects percentage as value between 0-1 e.g. 5% -> 0.05
                const slippagePercentage = slippagePercents / 100;

                for (const position of positions) {
                  logVerbose("\n\n###################COMPONENT QUOTE##################");
                  const buyAmount = position.unit.mul(setAmount).toString();
                  const buyToken = position.component;
                  const sellToken = inputTokenAddress;
                  if (ethers.utils.getAddress(buyToken) == ethers.utils.getAddress(sellToken)) {
                    logVerbose("Component equal to input token skipping zero ex api call");
                    positionQuotes.push(ethers.utils.formatBytes32String("FOOBAR"));
                    inputTokenAmount = inputTokenAmount.add(position.unit.mul(setAmount));
                  } else {
                    const quote = await getQuote({
                      buyToken,
                      sellToken,
                      buyAmount,
                      excludedSources,
                      slippagePercentage,
                    });
                    await logQuote(quote);
                    positionQuotes.push(quote.data);
                    inputTokenAmount = inputTokenAmount.add(BigNumber.from(quote.sellAmount));
                  }
                }
                // I assume that this is the correct math to make sure we have enough weth to cover the slippage
                // based on the fact that the slippagePercentage is limited between 0.0 and 1.0 on the 0xApi
                // TODO: Review if correct
                inputTokenAmount = inputTokenAmount.mul(100).div(100 - slippagePercents);
                return [positionQuotes, inputTokenAmount];
              }

              const initializeSubjectVariables = async (_amountSetToken: number) => {
                // TODO: Analyse what a good value would be in production
                const SLIPPAGE_PERCENTAGE = 50;

                subjectInputToken = dai;
                subjectAmountSetToken = _amountSetToken;
                subjectAmountSetTokenWei = ether(subjectAmountSetToken);
                [subjectPositionSwapQuotes, subjectInputTokenAmount] = await getIssuanceQuotes(
                  setToken,
                  subjectInputToken.address,
                  subjectAmountSetToken,
                  SLIPPAGE_PERCENTAGE,
                );
              };

              async function obtainAndApproveInputToken() {
                // Obtaining the input token by taking it from a large holder introduces an external dependency
                // .i.e. the tests will fail if this address does not have enough input token (DAI) anymore
                // TODO: Review if this needs changing.
                const inputTokenWhaleAddress = "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503";
                const whaleTokenBalance = await subjectInputToken.balanceOf(inputTokenWhaleAddress);

                if (whaleTokenBalance.gt(0)) {
                  logVerbose(
                    "\n\n###################OBTAIN INPUT TOKEN FROM WHALE##################",
                  );
                  await user.wallet.sendTransaction({
                    to: inputTokenWhaleAddress,
                    value: ethers.utils.parseEther("2.0"),
                  });
                  logVerbose("Sent ether to whale");
                  await hre.network.provider.request({
                    method: "hardhat_impersonateAccount",
                    params: [inputTokenWhaleAddress],
                  });
                  logVerbose("Impersonated whale");
                  const inputTokenWhaleSigner = ethers.provider.getSigner(inputTokenWhaleAddress);
                  await subjectInputToken
                    .connect(inputTokenWhaleSigner)
                    .transfer(user.address, whaleTokenBalance);
                  logVerbose(
                    "New user balance",
                    ethers.utils.formatEther(await subjectInputToken.balanceOf(user.address)),
                  );
                }

                subjectInputToken
                  .connect(user.wallet)
                  .approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
              }

              async function subject(): Promise<ContractTransaction> {
                return await exchangeIssuanceZeroEx
                  .connect(user.wallet)
                  .issueExactSetFromToken(
                    setToken.address,
                    subjectInputToken.address,
                    subjectAmountSetTokenWei,
                    subjectInputTokenAmount,
                    subjectPositionSwapQuotes,
                    issuanceModuleAddress,
                    isDebtIssuance,
                  );
              }

              beforeEach(async () => {
                await deployExchangeIssuanceZeroEx();
                await exchangeIssuanceZeroEx.approveSetToken(
                  setToken.address,
                  issuanceModuleAddress,
                );
                await initializeSubjectVariables(setTokenAmount);
                await obtainAndApproveInputToken();
              });
              it("should issue correct amount of set tokens", async () => {
                const initialBalanceOfSet = await setToken.balanceOf(user.address);
                await subject();
                const finalSetBalance = await setToken.balanceOf(user.address);
                const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
                expect(finalSetBalance).to.eq(expectedSetBalance);
              });
            });

            describe("#redeemExactSetForToken", async () => {
              // Note that this test will only succeed if the previous issuance test succeeded
              // since it redeems the thereby obtained tokens
              // TODO: Review if this dependency is an issue
              let subjectOutputToken: StandardTokenMock | WETH9;
              let subjectOutputTokenAmount: BigNumber;
              let subjectAmountSetToken: number;
              let subjectAmountSetTokenWei: BigNumber;
              let subjectPositionSwapQuotes: string[];

              // Helper function to generate 0xAPI quote for UniswapV2
              async function getRedemptionQuotes(
                setToken: SetToken,
                outputTokenAddress: Address,
                setAmount: number,
                slippagePercents: number,
                excludedSources: string | undefined = undefined,
              ): Promise<[string[], BigNumber]> {
                const positions = await setToken.getPositions();
                const positionQuotes: string[] = [];
                let outputTokenAmount = BigNumber.from(0);
                const slippagePercentage = slippagePercents / 100;

                for (const position of positions) {
                  logVerbose("\n\n###################COMPONENT QUOTE##################");
                  const sellAmount = position.unit.mul(setAmount).toString();
                  const sellToken = position.component;
                  const buyToken = outputTokenAddress;
                  if (ethers.utils.getAddress(buyToken) == ethers.utils.getAddress(sellToken)) {
                    logVerbose("Component equal to output token skipping zero ex api call");
                    positionQuotes.push(ethers.utils.formatBytes32String("FOOBAR"));
                    outputTokenAmount = outputTokenAmount.add(position.unit.mul(setAmount));
                  } else {
                    const quote = await getQuote({
                      buyToken,
                      sellToken,
                      sellAmount,
                      excludedSources,
                      slippagePercentage,
                    });
                    await logQuote(quote);
                    positionQuotes.push(quote.data);
                    outputTokenAmount = outputTokenAmount.add(BigNumber.from(quote.buyAmount));
                  }
                }
                // I assume that this is the correct math to make sure we have enough weth to cover the slippage
                // based on the fact that the slippagePercentage is limited between 0.0 and 1.0 on the 0xApi
                // TODO: Review if correct
                outputTokenAmount = outputTokenAmount.div(100).mul(100 - slippagePercents);

                return [positionQuotes, outputTokenAmount];
              }

              const initializeSubjectVariables = async (_amountSetToken: number) => {
                const SLIPPAGE_PERCENTAGE = 50;
                subjectOutputTokenAmount = ether(1000);
                subjectOutputToken = dai;
                subjectAmountSetToken = _amountSetToken;
                subjectAmountSetTokenWei = ether(subjectAmountSetToken);
                [subjectPositionSwapQuotes, subjectOutputTokenAmount] = await getRedemptionQuotes(
                  setToken,
                  subjectOutputToken.address,
                  subjectAmountSetToken,
                  SLIPPAGE_PERCENTAGE,
                );
              };
              async function subject(): Promise<ContractTransaction> {
                return await exchangeIssuanceZeroEx
                  .connect(user.wallet)
                  .redeemExactSetForToken(
                    setToken.address,
                    subjectOutputToken.address,
                    subjectAmountSetTokenWei,
                    subjectOutputTokenAmount,
                    subjectPositionSwapQuotes,
                    issuanceModuleAddress,
                    isDebtIssuance,
                  );
              }
              beforeEach(async () => {
                await deployExchangeIssuanceZeroEx();
                await exchangeIssuanceZeroEx.approveSetToken(
                  setToken.address,
                  issuanceModuleAddress,
                );
                await initializeSubjectVariables(setTokenAmount);
                await setToken
                  .connect(user.wallet)
                  .approve(exchangeIssuanceZeroEx.address, subjectAmountSetTokenWei);
              });
              it("should consume correct amount of set tokens", async () => {
                const initialBalanceOfSet = await setToken.balanceOf(user.address);
                const initialBalanceOfOutputToken = await subjectOutputToken.balanceOf(
                  user.address,
                );
                await subject();
                const finalSetBalance = await setToken.balanceOf(user.address);
                const expectedSetBalance = initialBalanceOfSet.sub(subjectAmountSetTokenWei);
                expect(finalSetBalance).to.eq(expectedSetBalance);
                const finalOutputBalance = await subjectOutputToken.balanceOf(user.address);
                const expectedOutputBalance = initialBalanceOfOutputToken.add(
                  subjectOutputTokenAmount,
                );
                expect(finalOutputBalance.gte(expectedOutputBalance));
              });
            });
          });
        }
      });
    }
  });
}
