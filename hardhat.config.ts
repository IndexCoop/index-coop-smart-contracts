require("dotenv").config();

import { HardhatUserConfig, internalTask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_COMPILE } from "hardhat/builtin-tasks/task-names";
import { execSync } from "child_process";
import { privateKeys } from "./utils/wallets";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";

internalTask(TASK_COMPILE_SOLIDITY_COMPILE).setAction(setupNativeSolc);

const forkingConfig = {
  url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_TOKEN,
  blockNumber: 11649166,
};

const mochaConfig = {
  grep: "@forked-network",
  invert: (process.env.FORK) ? false : true,
  timeout: (process.env.FORK) ? 50000 : 20000,
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
    },
    localhost: {
      url: "http://127.0.0.1:8545",
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
    const HUNDRED_THOUSAND_ETH = "100000000000000000000000";
    return {
      privateKey: key,
      balance: HUNDRED_THOUSAND_ETH,
    };
  });
}

// @ts-ignore
async function setupNativeSolc({ input }, { config }, runSuper) {
  let solcVersionOutput = "";
  try {
    solcVersionOutput = execSync(`solc --version`).toString();
  } catch (error) {
    // Probably failed because solc wasn"t installed. We do nothing here.
  }

  console.log("Output", solcVersionOutput);

  if (!solcVersionOutput.includes(config.solidity.version)) {
    console.log(`Using solcjs`);
    return runSuper();
  }

  console.log(`Using native solc`);
  const output = execSync(`solc --standard-json`, {
    input: JSON.stringify(input, undefined, 2),
  });

  return JSON.parse(output.toString(`utf8`));
}

export default config;