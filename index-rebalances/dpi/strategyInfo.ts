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
    supply: BigNumber.from(34847),
    maxTradeSize: ether(11.3),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  COMP: {
    address: assets.COMP.address,
    supply: BigNumber.from(4324120),
    maxTradeSize: ether(138),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  SNX: {
    address: assets.SNX.address,
    supply: BigNumber.from(146644888),
    maxTradeSize: ether(9600),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MKR: {
    address: assets.MKR.address,
    supply: BigNumber.from(901982),
    maxTradeSize: ether(33.7),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  REN: {
    address: assets.REN.address,
    supply: BigNumber.from(881153018),
    maxTradeSize: ether(39000),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  KNC: {
    address: assets.KNC.address,
    supply: BigNumber.from(204329112),
    maxTradeSize: ether(4500),
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
    maxTradeSize: ether(7000),
    exchange: Exchanges.BALANCER,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  UNI: {
    address: assets.UNI.address,
    supply: BigNumber.from(299540475),
    maxTradeSize: ether(15000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  AAVE: {
    address: assets.AAVE.address,
    supply: BigNumber.from(12409409),
    maxTradeSize: ether(850),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MTA: {
    address: assets.MTA.address,
    supply: BigNumber.from(18150727),
    maxTradeSize: ether(7000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  SUSHI: {
    address: assets.SUSHI.address,
    supply: BigNumber.from(127244443),
    maxTradeSize: ether(64000),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  }
};