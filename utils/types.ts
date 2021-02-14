import {
  ContractTransaction as ContractTransactionType,
  Wallet as WalletType
} from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

export type Account = {
  address: Address;
  wallet: SignerWithAddress;
};

export type Address = string;
export type Bytes = string;

export type ContractTransaction = ContractTransactionType;
export type Wallet = WalletType;

export interface MerkleDistributorInfo {
  merkleRoot: string;
  tokenTotal: string;
  claims: {
    [account: string]: {
      index: number
      amount: string
      proof: string[]
      flags?: {
        [flag: string]: boolean
      }
    }
  };
}

export type DistributionFormat = { address: string; earnings: BigNumber; };

export interface LeverageTokenSettings {
  setToken: Address;
  leverageModule: Address;
  manager: Address;
  comptroller: Address;
  priceOracle: Address;
  targetCollateralCToken: Address;
  targetBorrowCToken: Address;
  collateralAsset: Address;
  borrowAsset: Address;
  targetLeverageRatio: BigNumber;
  minLeverageRatio: BigNumber;
  maxLeverageRatio: BigNumber;
  recenteringSpeed: BigNumber;
  rebalanceInterval: BigNumber;
  unutilizedLeveragePercentage: BigNumber;
  twapMaxTradeSize: BigNumber;
  twapCooldownPeriod: BigNumber;
  slippageTolerance: BigNumber;
  incentivizedTwapMaxTradeSize: BigNumber;
  incentivizedTwapCooldownPeriod: BigNumber;
  incentivizedSlippageTolerance: BigNumber;
  etherReward: BigNumber;
  incentivizedLeverageRatio: BigNumber;
  exchangeName: string;
  exchangeData: Bytes;
}