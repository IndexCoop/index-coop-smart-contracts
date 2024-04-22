require("dotenv").config();

import { HardhatUserConfig } from "hardhat/config";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";
import "hardhat-contract-sizer";
import "./tasks";
import { forkingConfig } from "./utils/config";


const INTEGRATIONTEST_TIMEOUT = 600000;


const mochaConfig = {
  timeout: process.env.INTEGRATIONTEST ? INTEGRATIONTEST_TIMEOUT : 50000,
} as Mocha.MochaOptions;

const gasOption =
  process.env.NETWORK === "polygon"
    ? {
        blockGasLimit: 20000000,
      }
    : process.env.NETWORK === "optimism"
    ? {
        blockGasLimit: 20000000,
      }
    : {
        gas: 12000000,
        blockGasLimit: 30000000,
      };

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.6.10",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.17",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
  },
  networks: {
    hardhat: {
      forking: process.env.FORK ? forkingConfig : undefined,
      accounts: getHardhatPrivateKeys(),
      // @ts-ignore
      timeout: INTEGRATIONTEST_TIMEOUT,
      initialBaseFeePerGas: 0,
      ...gasOption,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      // @ts-ignore
      timeout: INTEGRATIONTEST_TIMEOUT,
      ...gasOption,
    },
    kovan: {
      url: "https://kovan.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: process.env.KOVAN_DEPLOY_PRIVATE_KEY
        ? [`0x${process.env.KOVAN_DEPLOY_PRIVATE_KEY}`]
        : undefined,
    },
    production: {
      url: "https://mainnet.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: process.env.PRODUCTION_MAINNET_DEPLOY_PRIVATE_KEY
        ? [`0x${process.env.PRODUCTION_MAINNET_DEPLOY_PRIVATE_KEY}`]
        : undefined,
    },
  },
  mocha: mochaConfig,
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
};

function getHardhatPrivateKeys() {
  return privateKeys.map(key => {
    const TEN_MILLION_ETH = "10000000000000000000000000";
    return {
      privateKey: key,
      balance: TEN_MILLION_ETH,
    };
  });
}

export default config;
