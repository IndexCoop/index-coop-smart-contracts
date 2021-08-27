require("dotenv").config();

import { HardhatUserConfig } from "hardhat/config";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";
import "./tasks";

const forkingConfig = {
  url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_TOKEN,
  blockNumber: 11649166,
};

const mochaConfig = {
  grep: "@forked-network",
  invert: (process.env.FORK) ? false : true,
  timeout: (process.env.FORK) ? 50000 : 40000,
} as Mocha.MochaOptions;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.6.10",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  namedAccounts: {
    deployer: 0,
  },
  networks: {
    hardhat: {
      forking: (process.env.FORK) ? forkingConfig : undefined,
      accounts: getHardhatPrivateKeys(),
      gas: 12000000,
      blockGasLimit: 12000000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      gas: 12000000,
      blockGasLimit: 12000000,
    },
    kovan: {
      url: "https://kovan.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: [`0x${process.env.KOVAN_DEPLOY_PRIVATE_KEY}`],
    },
    production: {
      url: "https://mainnet.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: [`0x${process.env.PRODUCTION_MAINNET_DEPLOY_PRIVATE_KEY}`],
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
