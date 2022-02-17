import { ethers } from "hardhat";
import { BigNumber } from "ethers";
import axios from "axios";
import qs from "qs";

const MAX_RETRIES = 40;
const RETRY_STATUSES = [503, 429];
const API_QUOTE_URL = "https://api.0x.org/swap/v1/quote";

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

async function getQuote(params: any, retryCount: number = 0): Promise<any> {
  try {
    const url = `${API_QUOTE_URL}?${qs.stringify(params)}`;
    const response = await axios(url);
    return response.data;
  } catch (error) {
    if (RETRY_STATUSES.includes(error.response?.status) && retryCount < MAX_RETRIES) {
      await sleep(1000);
      return await getQuote(params, retryCount + 1);
    } else {
      throw error;
    }
  }
}

async function getQuotes(
  positions: any[],
  inputToken: string,
  setAmount: number,
  wethStage: boolean,
) {
  const componentSwapInputToken = wethStage ? "WETH" : inputToken;
  const componentInputTokenAddress = TOKEN_ADDRESSES[componentSwapInputToken];
  const quotes = await getPositionQuotes(positions, componentInputTokenAddress, setAmount);
  if (wethStage) {
    const wethBuyAmount = quotes.reduce(
      (sum: BigNumber | number, quote: any) => BigNumber.from(quote.sellAmount).add(sum),
      0,
    );
    const wethQuote = await getQuote({
      buyToken: TOKEN_ADDRESSES["WETH"],
      sellToken: TOKEN_ADDRESSES[inputToken],
      buyAmount: wethBuyAmount.toString(),
    });
    quotes.push(wethQuote);
  }
  return quotes;
}

async function getPositionQuotes(
  positions: any[],
  inputTokenAddress: string,
  setAmount: number,
): Promise<any[]> {
  const promises = positions.map((position: any) => {
    if (
      ethers.utils.getAddress(position.component) === ethers.utils.getAddress(inputTokenAddress)
    ) {
      console.log("No swap needed");
      return Promise.resolve({ gas: "0", sellAmount: position.unit.mul(setAmount).toString() });
    } else {
      const params = {
        buyToken: position.component,
        sellToken: inputTokenAddress,
        buyAmount: position.unit.mul(setAmount).toString(),
      };
      return getQuote(params);
    }
  });
  return await Promise.all(promises);
}

type GasCostRow = {
  setToken: string;
  inputToken: string;
  setAmount: number;
  wethStage: boolean;
  gas: number;
};

const TOKEN_ADDRESSES: Record<string, string> = {
  DPI: "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",
  DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
};

async function calculateTotalGas(
  setToken: string,
  inputToken: string,
  setAmount: number,
  wethStage: boolean,
): Promise<GasCostRow> {
  const setAddress = TOKEN_ADDRESSES[setToken];
  const setContract = await ethers.getContractAt("ISetToken", setAddress);
  const positions = await setContract.getPositions();
  const positionQuotes = await getQuotes(positions, inputToken, setAmount, wethStage);
  const gas = positionQuotes.reduce((sum: number, quote: any) => sum + parseInt(quote.gas), 0);
  return { setToken, inputToken, setAmount, wethStage, gas };
}

//@ts-ignore
const f = (a, b) => [].concat(...a.map((d) => b.map((e) => [].concat(d, e))));
//@ts-ignore
const cartesian = (a, b, ...c) => (b ? cartesian(f(a, b), ...c) : a);

async function main() {
  const setTokens = ["DPI"];
  const inputTokens = ["DAI"];
  const setAmounts = [100, 1000, 10000];
  const wethStage = [false, true];
  const scenarios = cartesian(setTokens, inputTokens, setAmounts, wethStage);
  const promises = scenarios.map((params: [string, string, number, boolean]) =>
    calculateTotalGas(params[0], params[1], params[2], params[3]),
  );
  const results = await Promise.all(promises);
  console.table(results);
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
