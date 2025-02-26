import { network } from "hardhat";
import axios from "axios";
import { BigNumber, ethers } from "ethers";
import fs from "fs";
import path from "path";

const zeroExApiKey = process.env.ZERO_EX_API_KEY;
const flashMintAddress = "0xE6c18c4C9FC6909EDa546649EBE33A8159256CBE";
const weth = "0x4200000000000000000000000000000000000006";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const sellAmount = ethers.utils.parseUnits("1", 18);
const isQuote = false;
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
  let jsonData: any = {};

  // Read existing file if present
  if (fs.existsSync(filePath)) {
    const fileContent = fs.readFileSync(filePath, "utf8");
    jsonData = fileContent ? JSON.parse(fileContent) : {};
  }

  // Ensure the JSON structure
  if (!jsonData[chainId]) jsonData[chainId] = {};
  if (!jsonData[chainId][sellToken]) jsonData[chainId][sellToken] = {};
  if (!jsonData[chainId][sellToken][buyToken]) jsonData[chainId][sellToken][buyToken] = {};
  if (!jsonData[chainId][sellToken][buyToken][sellAmount.toString()])
    jsonData[chainId][sellToken][buyToken][sellAmount.toString()] = {};
  if (!jsonData[chainId][sellToken][buyToken][sellAmount.toString()][blockNumber])
    jsonData[chainId][sellToken][buyToken][sellAmount.toString()][blockNumber] = {};

  // Save data under either "price" or "quote"
  const key = isQuote ? "quote" : "price";
  jsonData[chainId][sellToken][buyToken][sellAmount.toString()][blockNumber][key] = data;

  // Write back to the JSON file
  fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2), "utf8");

  console.log(`Data saved to ${filePath}`);
}

async function main() {
  const chainId = await getChainId();
  const blockNumber = await latestBlock();
  console.log("Chain ID:", chainId);
  console.log("Block Number:", blockNumber);

  const priceResponse = await getZeroExResponse(chainId, weth, usdc, sellAmount, flashMintAddress, isQuote);
  console.log("Fetched Data:", priceResponse);

  // Save response to file
  saveToJsonFile(chainId, weth, usdc, sellAmount, blockNumber, priceResponse, isQuote);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
