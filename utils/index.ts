import { ethers } from "hardhat";
import { Blockchain } from "./common";
import { Address } from "./types";

const provider = ethers.provider;
export const getBlockchainUtils = () => new Blockchain(provider);

import { SetFixture } from "./fixtures";
import { CompoundFixture } from "./fixtures";
import { UniswapFixture } from "./fixtures";

export const getSetFixture = (ownerAddress: Address) => new SetFixture(provider, ownerAddress);
export const getCompoundFixture = (ownerAddress: Address) => new CompoundFixture(provider, ownerAddress);
export const getUniswapFixture = (ownerAddress: Address) => new UniswapFixture(provider, ownerAddress);

export {
  getAccounts,
  getEthBalance,
  getLastBlockTimestamp,
  getProvider,
  getTransactionTimestamp,
  getWaffleExpect,
  addSnapshotBeforeRestoreAfterEach,
  getRandomAccount,
  getRandomAddress,
  increaseTimeAsync,
  mineBlockAsync,
} from "./test";

export {
  bitcoin,
  divDown,
  ether,
  getStreamingFee,
  getStreamingFeeInflationAmount,
  getPostFeePositionUnits,
  gWei,
  min,
  preciseDiv,
  preciseDivCeil,
  preciseMul,
  preciseMulCeil,
  preciseMulCeilInt,
  preciseDivCeilInt,
  usdc
} from "./common";

export {
  BalanceTree,
  MerkleTree,
  parseBalanceMap,
} from "./merkleUtils";

export {
  calculateNewLeverageRatio,
  calculateCollateralRebalanceUnits,
  calculateMaxBorrowForDelever
} from "./flexibleLeverageUtils";