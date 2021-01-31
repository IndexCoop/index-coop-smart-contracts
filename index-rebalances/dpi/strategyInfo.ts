import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "@utils/types";
import { ZERO } from "@utils/constants";
import { ether } from "@utils/common/index";

interface AssetInfo {
  address: Address,
  supply: BigNumber,
  maxTradeSize: BigNumber,
  exchange: Exchanges,
  coolOffPeriod: BigNumber,
  currentUnit: BigNumber
}

export interface StrategyInfo {
  [symbol: string]: AssetInfo;
}

enum Exchanges {
  NONE,
  UNISWAP,
  SUSHISWAP,
  BALANCER
}

export const strategyInfo: StrategyInfo = {
  YFI: {
    address: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    supply: BigNumber.from(30000),
    maxTradeSize: ether(5.4),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  COMP: {
    address: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    supply: BigNumber.from(4164882),
    maxTradeSize: ether(114),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  SNX: {
    address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    supply: BigNumber.from(142197167),
    maxTradeSize: ether(7400),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MKR: {
    address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    supply: BigNumber.from(902135),
    maxTradeSize: ether(71),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  REN: {
    address: "0x408e41876cCCDC0F92210600ef50372656052a38",
    supply: BigNumber.from(881153019),
    maxTradeSize: ether(72000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  KNC: {
    address: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
    supply: BigNumber.from(201352515),
    maxTradeSize: ether(5000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  LRC: {
    address: "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD",
    supply: BigNumber.from(1246496469),
    maxTradeSize: ether(340000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  BAL: {
    address: "0xba100000625a3754423978a60c9317c58a424e3D",
    supply: BigNumber.from(10799858),
    maxTradeSize: ether(8500),
    exchange: Exchanges.BALANCER,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  UNI: {
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    supply: BigNumber.from(284459084),
    maxTradeSize: ether(44000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  AAVE: {
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    supply: BigNumber.from(12278216),
    maxTradeSize: ether(671),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MTA: {
    address: "0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2",
    supply: BigNumber.from(15545071),
    maxTradeSize: ether(4200),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  }
};