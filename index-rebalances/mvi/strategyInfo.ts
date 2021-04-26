import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { ZERO } from "@utils/constants";
import { ether } from "@utils/common/index";
import { assets } from "../assetInfo";
import { Exchanges, StrategyInfo } from "../types";

export const strategyInfo: StrategyInfo = {
  MANA: {
    address: assets.MANA.address,
    allocation: BigNumber.from(36096),
    maxTradeSize: ether(13.2),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  ENJ: {
    address: assets.ENJ.address,
    allocation: BigNumber.from(4481070),
    maxTradeSize: ether(192),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  WAXE: {
    address: assets.WAXE.address,
    allocation: BigNumber.from(147958712),
    maxTradeSize: ether(10250),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  AXS: {
    address: assets.AXS.address,
    allocation: BigNumber.from(901683),
    maxTradeSize: ether(40),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  SAND: {
    address: assets.SAND.address,
    allocation: BigNumber.from(881153018),
    maxTradeSize: ether(55000),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  RFOX: {
    address: assets.RFOX.address,
    allocation: BigNumber.from(204620558),
    maxTradeSize: ether(2100),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  AUDIO: {
    address: assets.AUDIO.address,
    allocation: BigNumber.from(1246496468),
    maxTradeSize: ether(14000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  DG: {
    address: assets.DG.address,
    allocation: BigNumber.from(10799858),
    maxTradeSize: ether(9900),
    exchange: Exchanges.BALANCER,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  NFTX: {
    address: assets.NFTX.address,
    allocation: BigNumber.from(519857388),
    maxTradeSize: ether(17000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(900),
    currentUnit: ZERO,
  },
  WHALE: {
    address: assets.WHALE.address,
    allocation: BigNumber.from(12444542),
    maxTradeSize: ether(1200),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MEME: {
    address: assets.MEME.address,
    allocation: BigNumber.from(21121062),
    maxTradeSize: ether(5000),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  TVK: {
    address: assets.TVK.address,
    allocation: BigNumber.from(139445658),
    maxTradeSize: ether(72000),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  RARI: {
    address: assets.RARI.address,
    allocation: BigNumber.from(653761),
    maxTradeSize: ether(135),
    exchange: Exchanges.SUSHISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  REVV: {
    address: assets.REVV.address,
    allocation: BigNumber.from(496848),
    maxTradeSize: ether(125),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  },
  MUSE: {
    address: assets.MUSE.address,
    allocation: BigNumber.from(496848),
    maxTradeSize: ether(125),
    exchange: Exchanges.UNISWAP,
    coolOffPeriod: BigNumber.from(600),
    currentUnit: ZERO,
  }
};