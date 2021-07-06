import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "@utils/types";
import { ZERO } from "@utils/constants";
import { ether } from "@utils/common/index";
import { assets } from "../assetInfo"

interface AssetInfo {
  address: Address,
  supply: BigNumber,
  maxTradeSize: BigNumber,
  exchange: Exchanges,
  coolOffPeriod: BigNumber,
  currentUnit: BigNumber,
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
    address: assets.YFI.address,
    supply: BigNumber.from(36096),
    maxTradeSize: ether(13.2),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  COMP: {
    address: assets.COMP.address,
    supply: BigNumber.from(4481070),
    maxTradeSize: ether(192),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  SNX: {
    address: assets.SNX.address,
    supply: BigNumber.from(147958712),
    maxTradeSize: ether(10250),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MKR: {
    address: assets.MKR.address,
    supply: BigNumber.from(901683),
    maxTradeSize: ether(40),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  REN: {
    address: assets.REN.address,
    supply: BigNumber.from(881153018),
    maxTradeSize: ether(55000),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  KNC: {
    address: assets.KNC.address,
    supply: BigNumber.from(204620558),
    maxTradeSize: ether(2100),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  LRC: {
    address: assets.LRC.address,
    supply: BigNumber.from(1246496468),
    maxTradeSize: ether(14000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  BAL: {
    address: assets.BAL.address,
    supply: BigNumber.from(10799858),
    maxTradeSize: ether(9900),
    exchange: Exchanges.BALANCER,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  UNI: {
    address: assets.UNI.address,
    supply: BigNumber.from(519857388),
    maxTradeSize: ether(17000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  AAVE: {
    address: assets.AAVE.address,
    supply: BigNumber.from(12444542),
    maxTradeSize: ether(1200),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MTA: {
    address: assets.MTA.address,
    supply: BigNumber.from(21121062),
    maxTradeSize: ether(5000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  SUSHI: {
    address: assets.SUSHI.address,
    supply: BigNumber.from(139445658),
    maxTradeSize: ether(72000),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  CREAM: {
    address: assets.CREAM.address,
    supply: BigNumber.from(653761),
    maxTradeSize: ether(135),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  FARM: {
    address: assets.FARM.address,
    supply: BigNumber.from(496848),
    maxTradeSize: ether(125),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  }
};