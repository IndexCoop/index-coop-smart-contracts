import { ContractTransaction as ContractTransactionType, Wallet as WalletType } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { IERC20 } from "../typechain";

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
      index: number;
      amount: string;
      proof: string[];
      flags?: {
        [flag: string]: boolean;
      };
    };
  };
}

export type DistributionFormat = { address: string; earnings: BigNumber };

export type ForkedTokens = {
  [key: string]: IERC20;
};

export interface ContractSettings {
  setToken: Address;
  leverageModule: Address;
  comptroller: Address;
  collateralPriceOracle: Address;
  borrowPriceOracle: Address;
  targetCollateralCToken: Address;
  targetBorrowCToken: Address;
  collateralAsset: Address;
  borrowAsset: Address;
  collateralDecimalAdjustment: BigNumber;
  borrowDecimalAdjustment: BigNumber;
}

export interface AaveContractSettings {
  setToken: Address;
  leverageModule: Address;
  aaveProtocolDataProvider: Address;
  collateralPriceOracle: Address;
  borrowPriceOracle: Address;
  targetCollateralAToken: Address;
  targetBorrowDebtToken: Address;
  collateralAsset: Address;
  borrowAsset: Address;
  collateralDecimalAdjustment: BigNumber;
  borrowDecimalAdjustment: BigNumber;
}

export interface MethodologySettings {
  targetLeverageRatio: BigNumber;
  minLeverageRatio: BigNumber;
  maxLeverageRatio: BigNumber;
  recenteringSpeed: BigNumber;
  rebalanceInterval: BigNumber;
}

export interface ExecutionSettings {
  unutilizedLeveragePercentage: BigNumber;
  twapCooldownPeriod: BigNumber;
  slippageTolerance: BigNumber;
}

export interface ExchangeSettings {
  twapMaxTradeSize: BigNumber;
  exchangeLastTradeTimestamp: BigNumber;
  incentivizedTwapMaxTradeSize: BigNumber;
  leverExchangeData: Bytes;
  deleverExchangeData: Bytes;
}

export interface IncentiveSettings {
  incentivizedTwapCooldownPeriod: BigNumber;
  incentivizedSlippageTolerance: BigNumber;
  etherReward: BigNumber;
  incentivizedLeverageRatio: BigNumber;
}

export interface AirdropSettings {
  airdrops: Address[];
  feeRecipient: Address;
  airdropFee: BigNumber;
  anyoneAbsorb: boolean;
}

export interface StreamingFeeState {
  feeRecipient: Address;
  streamingFeePercentage: BigNumber;
  maxStreamingFeePercentage: BigNumber;
  lastStreamingFeeTimestamp: BigNumber;
}

export interface TradeInfo {
  exchangeName: string;
  sendToken: Address;
  sendQuantity: BigNumber;
  receiveToken: Address;
  receiveQuantity: BigNumber;
  data: Bytes;
}

export interface BatchTradeResult {
  success: boolean;
  tradeInfo: TradeInfo;
  revertReason?: string | undefined;
}

export interface AirdropSettings {
  airdrops: Address[];
  feeRecipient: Address;
  airdropFee: BigNumber;
  anyoneAbsorb: boolean;
}

export interface TargetWeightWrapParams {
  minTargetWeight: BigNumber;
  maxTargetWeight: BigNumber;
  wrapAdapterName: string;
  wrapData: Bytes;
  unwrapData: Bytes;
}

export interface CustomOracleNAVIssuanceSettings {
  managerIssuanceHook: Address;
  managerRedemptionHook: Address;
  setValuer: Address;
  reserveAssets: Address[];
  feeRecipient: Address;
  managerFees: [BigNumber, BigNumber];
  maxManagerFee: BigNumber;
  premiumPercentage: BigNumber;
  maxPremiumPercentage: BigNumber;
  minSetTokenSupply: BigNumber;
}
