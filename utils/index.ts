import { ethers } from "hardhat";
import { Blockchain } from "./common";
import { Address } from "./types";

const provider = ethers.provider;
export const getBlockchainUtils = () => new Blockchain(provider);

import {
  AaveV2Fixture,
  CompoundFixture,
  SetFixture,
  UniswapFixture,
  UniswapV3Fixture
} from "./fixtures";

export const getSetFixture = (ownerAddress: Address) => new SetFixture(provider, ownerAddress);
export const getAaveV2Fixture = (ownerAddress: Address) => new AaveV2Fixture(provider, ownerAddress);
export const getCompoundFixture = (ownerAddress: Address) => new CompoundFixture(provider, ownerAddress);
export const getUniswapFixture = (ownerAddress: Address) => new UniswapFixture(provider, ownerAddress);
export const getUniswapV3Fixture = (ownerAddress: Address) => new UniswapV3Fixture(provider, ownerAddress);

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
  cacheBeforeEach,
} from "./test";

export {
  bigNumberToData,
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
  sqrt,
  usdc,
  wbtc,
} from "./common";

export {
  BalanceTree,
  MerkleTree,
  parseBalanceMap,
} from "./merkleUtils";

export {
  calculateNewLeverageRatio,
  calculateCollateralRebalanceUnits,
  calculateMaxBorrowForDelever,
  calculateMaxRedeemForDeleverToZero
} from "./flexibleLeverageUtils";

export {
  setUniswapPoolToPrice
} from "./externalProtocolUtils";