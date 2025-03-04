import { network } from "hardhat";
import axios from "axios";
import { BigNumber, ethers } from "ethers";
import fs from "fs";
import path from "path";

const zeroExApiKey = process.env.ZERO_EX_API_KEY;
const filePath = path.resolve(__dirname, "../data/zeroExV2ResponseCache.json"); // JSON file storage path

async function latestBlock(): Promise<number> {
  const provider = network.provider;
  const height = (await provider.request({
    method: "eth_blockNumber",
    params: [],
  })) as string;
  return parseInt(height, 16);
}

async function getChainId(): Promise<number> {
  const provider = network.provider;
  const chainId = (await provider.request({
    method: "eth_chainId",
    params: [],
  })) as string;
  return parseInt(chainId, 16);
}

function readJsonCache(): any {
  if (fs.existsSync(filePath)) {
    try {
      const fileContent = fs.readFileSync(filePath, "utf8");
      return fileContent ? JSON.parse(fileContent) : {};
    } catch (error) {
      console.error("Error reading cache file:", error);
    }
  }
  return {};
}

function writeJsonCache(jsonData: any) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), "utf8");
    console.log(`Data saved to ${filePath}`);
  } catch (error) {
    console.error("Error writing cache file:", error);
  }
}

function getCachedResponse(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmount: BigNumber,
  blockNumber: number,
  blockRange: number,
  isQuote: boolean
): any | null {
  const cache = readJsonCache();
  const key = isQuote ? "quote" : "price";
  if (
    cache[chainId] &&
    cache[chainId][sellToken] &&
    cache[chainId][sellToken][buyToken] &&
    cache[chainId][sellToken][buyToken][sellAmount.toString()]
  ) {
    const blockEntries = Object.keys(cache[chainId][sellToken][buyToken][sellAmount.toString()])
      .map(Number) // Convert block numbers to integers
      .sort((a, b) => b - a); // Sort in descending order

    for (const cachedBlock of blockEntries) {
      if (Math.abs(cachedBlock - blockNumber) <= blockRange) {
        console.log(`Using cached response from block ${cachedBlock}`);
        return cache[chainId][sellToken][buyToken][sellAmount.toString()][cachedBlock][key];
      }
    }
  }
  return null;
}

async function getZeroExResponse(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmount: BigNumber,
  taker: string,
  isQuote: boolean = false
): Promise<any> {
  const priceParams = new URLSearchParams({
    chainId: chainId.toString(),
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker,
  });

  console.log("Fetching data with params:", priceParams.toString());

  const headers = {
    "0x-api-key": zeroExApiKey, 
    "0x-version": "v2",
  };

  const endpoint = isQuote ? "quote" : "price";
  const url = `https://api.0x.org/swap/allowance-holder/${endpoint}?` + priceParams.toString();

  const response = await axios.get(url, { headers });
  return response.data;
}

function saveToJsonFile(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmount: BigNumber,
  blockNumber: number,
  data: any,
  isQuote: boolean
) {
  let jsonData = readJsonCache();

  if (!jsonData[chainId]) jsonData[chainId] = {};
  if (!jsonData[chainId][sellToken]) jsonData[chainId][sellToken] = {};
  if (!jsonData[chainId][sellToken][buyToken]) jsonData[chainId][sellToken][buyToken] = {};
  if (!jsonData[chainId][sellToken][buyToken][sellAmount.toString()])
    jsonData[chainId][sellToken][buyToken][sellAmount.toString()] = {};

  jsonData[chainId][sellToken][buyToken][sellAmount.toString()][blockNumber] = {
    [isQuote ? "quote" : "price"]: data,
  };

  writeJsonCache(jsonData);
}

/**
 * Fetch ZeroEx data, either from cache or API.
 *
 * @param sellToken - The token to sell.
 * @param buyToken - The token to buy.
 * @param sellAmount - The amount of the sell token.
 * @param blockRange - The max block difference to use cached data.
 * @param flashMintAddress - The taker address.
 * @param isQuote - Whether to fetch a quote or a price.
 * @returns Cached or fresh response from 0x API.
 */
export async function fetchZeroExData(
  sellToken: string,
  buyToken: string,
  sellAmount: BigNumber,
  blockRange: number,
  flashMintAddress: string,
  isQuote: boolean
) {
  const chainId = await getChainId();
  console.log("Chain ID:", chainId);
  const blockNumber = await latestBlock();
  console.log("Block Number:", blockNumber);

  // Check cache for a response within the acceptable range
  const cachedResponse = getCachedResponse(
    chainId, sellToken, buyToken, sellAmount, blockNumber, blockRange, isQuote
  );
  if (cachedResponse) {
    return cachedResponse;
  }

  // Fetch new data from API
  const priceResponse = await getZeroExResponse(
    chainId, sellToken, buyToken, sellAmount, flashMintAddress, isQuote
  );
  console.log("Fetched Data:", priceResponse);

  // Save response to file
  saveToJsonFile(chainId, sellToken, buyToken, sellAmount, blockNumber, priceResponse, isQuote);

  return priceResponse;
}

// Example usage in main
async function main() {
  const sellToken = "0x4200000000000000000000000000000000000006"; // WETH
  const buyToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC
  const sellAmount = ethers.utils.parseUnits("1", 18);
  const blockRange = 1; // Blocks within which cache is valid
  const flashMintAddress = "0xE6c18c4C9FC6909EDa546649EBE33A8159256CBE";
  const isQuote = false;

  const result = await fetchZeroExData(sellToken, buyToken, sellAmount, blockRange, flashMintAddress, isQuote);
  console.log("Final result:", result);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
