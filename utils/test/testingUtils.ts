import chai, { expect } from "chai";
import { solidity } from "ethereum-waffle";
chai.use(solidity);

// Use HARDHAT version of providers
import { ethers, network } from "hardhat";
import { BigNumber, ContractTransaction, Signer } from "ethers";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Blockchain } from "../common";
import { forkingConfig } from "../config";
import {
  SetToken,
} from "../../typechain";

const provider = ethers.provider;
// const blockchain = new Blockchain(provider);

// HARDHAT-SPECIFIC Provider
export const getProvider = (): JsonRpcProvider => {
  return ethers.provider;
};

// HARDHAT / WAFFLE
export const getWaffleExpect = (): Chai.ExpectStatic => {
  return chai.expect;
};

// And this is our test sandboxing. It snapshots and restores between each test.
// Note: if a test suite uses fastForward at all, then it MUST also use these snapshots,
// otherwise it will update the block time of the EVM and future tests that expect a
// starting timestamp will fail.
export const addSnapshotBeforeRestoreAfterEach = () => {
  const blockchain = new Blockchain(provider);
  beforeEach(async () => {
    await blockchain.saveSnapshotAsync();
  });

  afterEach(async () => {
    await blockchain.revertAsync();
  });
};

// This is test sandboxing for nested snapshots. Can be used like a `beforeEach` statement.
// The same caveats about time noted in the comment above apply.
const SNAPSHOTS: string[] = [];

export function cacheBeforeEach(initializer: Mocha.AsyncFunc): void {
  let initialized = false;
  const blockchain = new Blockchain(provider);

  beforeEach(async function() {
    if (!initialized) {
      await initializer.call(this);
      SNAPSHOTS.push(await blockchain.saveSnapshotAsync());
      initialized = true;
    } else {
      const snapshotId = SNAPSHOTS.pop()!;
      await blockchain.revertByIdAsync(snapshotId);
      SNAPSHOTS.push(await blockchain.saveSnapshotAsync());
    }
  });

  after(async function() {
    if (initialized) {
      SNAPSHOTS.pop();
    }
  });
}

export async function getTransactionTimestamp(asyncTxn: any): Promise<BigNumber> {
  const txData = await asyncTxn;
  return BigNumber.from((await provider.getBlock(txData.block)).timestamp);
}

export async function getLastBlockTimestamp(): Promise<BigNumber> {
  return BigNumber.from((await provider.getBlock("latest")).timestamp);
}

export async function mineBlockAsync(): Promise<any> {
  await sendJSONRpcRequestAsync("evm_mine", []);
}

export async function increaseTimeAsync(duration: BigNumber): Promise<any> {
  await sendJSONRpcRequestAsync("evm_increaseTime", [duration.toNumber()]);
  await mineBlockAsync();
}

async function sendJSONRpcRequestAsync(method: string, params: any[]): Promise<any> {
  return provider.send(method, params);
}

export async function getTxFee(tx: ContractTransaction) {
  const gasPrice = tx.gasPrice;
  const receipt = await tx.wait();
  const gasUsed = receipt.cumulativeGasUsed;
  const transactionFee = gasPrice.mul(gasUsed);
  return transactionFee;
}

export const expectThrowsAsync = async (method: Promise<any>, errorMessage: string = "") => {
  let error!: Error;
  try {
    await method;
  } catch (err) {
    error = (err as unknown) as Error;
  }
  expect(error).to.be.an("Error");
  if (errorMessage) {
    expect(error.message).to.include(errorMessage);
  }
};

export async function impersonateAccount(address: string): Promise<Signer> {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return await ethers.provider.getSigner(address);
}

export const setBalance = async (account: string, balance: BigNumber): Promise<void> => {
    await provider.send("hardhat_setBalance", [account, balance.toHexString().replace("0x0", "0x")]);
};

export function setBlockNumber(blockNumber: number, reset: boolean = true) {
  before(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: forkingConfig.url,
            blockNumber,
          },
        },
      ],
    });
  });
  after(async () => {
    if (reset) {
      await network.provider.request({
        method: "hardhat_reset",
        params: [
          {
            forking: {
              jsonRpcUrl: forkingConfig.url,
              blockNumber: forkingConfig.blockNumber,
            },
          },
        ],
      });
    }
  });
}

export async function getLastBlockTransaction(): Promise<any> {
  return (await provider.getBlockWithTransactions("latest")).transactions[0];
}

export async function convertPositionToNotional(
  positionAmount: BigNumber,
  setToken: SetToken,
): Promise<BigNumber> {
  return positionAmount.mul(await setToken.totalSupply()).div(BigNumber.from(10).pow(18));
}
