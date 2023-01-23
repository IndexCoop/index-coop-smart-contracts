require("dotenv").config();

import { HardhatUserConfig, task } from "hardhat/config";
import { privateKeys } from "./utils/wallets";
import type { CompilationJob, DependencyGraph } from "hardhat/types";
import {
  TASK_COMPILE_SOLIDITY_COMPILE_JOB,
  TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
  TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
} from "hardhat/builtin-tasks/task-names";

import "@nomiclabs/hardhat-waffle";
import "hardhat-typechain";
import "solidity-coverage";
import "hardhat-deploy";
import "hardhat-contract-sizer";
import "./tasks";

const INTEGRATIONTEST_TIMEOUT = 600000;

const polygonForkingConfig = {
  url: process.env.POLYGON_RPC_URL ?? "",
  blockNumber: 25004110,
};

const optimismForkingConfig = {
  url: process.env.OPTIMISM_RPC_URL ?? "",
  blockNumber: 15275100,
};

const mainnetForkingConfig = {
  url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_TOKEN,
  blockNumber: process.env.LATESTBLOCK ? undefined : 16180859,
};

const forkingConfig =
  process.env.NETWORK === "polygon"
    ? polygonForkingConfig
    : process.env.NETWORK === "optimism"
    ? optimismForkingConfig
    : mainnetForkingConfig;

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
  return privateKeys.map((key) => {
    const TEN_MILLION_ETH = "10000000000000000000000000";
    return {
      privateKey: key,
      balance: TEN_MILLION_ETH,
    };
  });
}

task("index:compile:one", "Compiles a single contract in isolation")
  .addPositionalParam("contractName")
  .setAction(async function(args, env) {
    const sourceName = env.artifacts.readArtifactSync(args.contractName).sourceName;

    const dependencyGraph: DependencyGraph = await env.run(
      TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
      { sourceNames: [sourceName] },
    );

    const resolvedFiles = dependencyGraph.getResolvedFiles().filter((resolvedFile) => {
      return resolvedFile.sourceName === sourceName;
    });

    const compilationJob: CompilationJob = await env.run(
      TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
      {
        dependencyGraph,
        file: resolvedFiles[0],
      },
    );

    await env.run(TASK_COMPILE_SOLIDITY_COMPILE_JOB, {
      compilationJob,
      compilationJobs: [compilationJob],
      compilationJobIndex: 0,
      emitsArtifacts: true,
      quiet: true,
    });

    await env.run("typechain");
  });

task("index:compile:all", "Compiles all contracts in isolation").setAction(async function(
  _args,
  env,
) {
  const allArtifacts = await env.artifacts.getAllFullyQualifiedNames();
  for (const contractName of allArtifacts) {
    const sourceName = env.artifacts.readArtifactSync(contractName).sourceName;

    const dependencyGraph: DependencyGraph = await env.run(
      TASK_COMPILE_SOLIDITY_GET_DEPENDENCY_GRAPH,
      {
        sourceNames: [sourceName],
      },
    );

    const resolvedFiles = dependencyGraph.getResolvedFiles().filter((resolvedFile) => {
      return resolvedFile.sourceName === sourceName;
    });

    const compilationJob: CompilationJob = await env.run(
      TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE,
      {
        dependencyGraph,
        file: resolvedFiles[0],
      },
    );

    await env.run(TASK_COMPILE_SOLIDITY_COMPILE_JOB, {
      compilationJob,
      compilationJobs: [compilationJob],
      compilationJobIndex: 0,
      emitsArtifacts: true,
      quiet: true,
    });
  }
});

export default config;
