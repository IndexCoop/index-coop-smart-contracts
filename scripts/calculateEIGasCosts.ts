import { ethers } from "hardhat";
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
      return Promise.resolve({ gas: 0 });
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
  gas: number;
};

const TOKEN_ADDRESSES: Record<string, string> = {
  DPI: "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",
  DAI: "0x6b175474e89094c44da98b954eedeac495271d0f",
};

async function calculateTotalGas({
  setToken,
  inputToken,
  setAmount,
}: {
  setToken: string;
  inputToken: string;
  setAmount: number;
}): Promise<GasCostRow> {
  const inputAddress = TOKEN_ADDRESSES[inputToken];
  const setAddress = TOKEN_ADDRESSES[setToken];
  const setContract = await ethers.getContractAt("ISetToken", setAddress);
  const positions = await setContract.getPositions();
  const positionQuotes = await getPositionQuotes(positions, inputAddress, setAmount);
  const gas = positionQuotes.reduce((sum: number, quote: any) => sum + parseInt(quote.gas), 0);
  return { setToken, inputToken, setAmount, gas };
}

async function main() {
  const scenarios = [
    { setToken: "DPI", inputToken: "DAI", setAmount: 100 },
    { setToken: "DPI", inputToken: "DAI", setAmount: 1000 },
  ];
  const promises = scenarios.map((value) => calculateTotalGas(value));
  const results = await Promise.all(promises);
  console.table(results);
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
