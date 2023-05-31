import {
  TASK_COMPILE,
  TASK_COMPILE_SOLIDITY_COMPILE,
  TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT,
} from "hardhat/builtin-tasks/task-names";

import { subtask, task, internalTask } from "hardhat/config";
import { addGasToAbiMethods, fixTypechain, setupNativeSolc } from "../utils/tasks";

// Injects network block limit (minus 1 million) in the abi so
// ethers uses it instead of running gas estimation.
subtask(TASK_COMPILE_SOLIDITY_GET_ARTIFACT_FROM_COMPILATION_OUTPUT).setAction(
  async (_, { network }, runSuper) => {
    const artifact = await runSuper();

    // These changes should be skipped when publishing to npm.
    // They override ethers' gas estimation
    if (!process.env.SKIP_ABI_GAS_MODS) {
      artifact.abi = addGasToAbiMethods(network.config, artifact.abi);
    }

    return artifact;
  },
);

// Use native solc if available locally at config specified version
internalTask(TASK_COMPILE_SOLIDITY_COMPILE).setAction(setupNativeSolc);

task("fix-typechain", "Fixes typechain generated types").setAction(async () => {
  fixTypechain();
});

task(TASK_COMPILE).setAction(async (_, _1, runSuper) => {
  await runSuper();
  fixTypechain();
});

export {};
