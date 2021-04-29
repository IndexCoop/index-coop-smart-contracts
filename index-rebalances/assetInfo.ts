import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "../utils/types";
import { ether } from "../utils/common/index";

interface AssetInfo {
  id: string,
  address: Address,
  price: BigNumber
}

export interface Assets {
  [symbol: string]: AssetInfo;
}

export const ASSETS: Assets = {
  YFI: {
    id: "yfi",
    address: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    price: ether(43970.00) ,
  },
  COMP: {
    id: "compound",
    address: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    price: ether(658.65),
  },
  SNX: {
    id: "snx",
    address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    price: ether(16.00),
  },
  MKR: {
    id: "maker",
    address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    price: ether(3994.98),
  },
  REN: {
    id: "ren",
    address: "0x408e41876cCCDC0F92210600ef50372656052a38",
    price: ether(0.85),
  },
  KNC: {
    id: "kyber-network",
    address: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
    price: ether(2.77),
  },
  LRC: {
    id: "loopring",
    address: "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD",
    price: ether(0.49),
  },
  BAL: {
    id: "balancer",
    address: "0xba100000625a3754423978a60c9317c58a424e3D",
    price: ether(52.85),
  },
  UNI: {
    id: "uniswap",
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    price: ether(35.97),
  },
  AAVE: {
    id: "aave",
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    price: ether(401.15),
  },
  MTA: {
    id: "mta",
    address: "0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2",
    price: ether(2.41),
  },
  WETH: {
    id: "",
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    price: ether(1942.51),
  },
  SUSHI: {
    id: "sushi",
    address: "0x6b3595068778dd592e39a122f4f5a5cf09c90fe2",
    price: ether(11.94)
  },
  CREAM: {
    id: "cream",
    address: "0x2ba592f78db6436527729929aaf6c908497cb200",
    price: ether(105.08)
  },
  FARM: {
    id: "farm",
    address: "0xa0246c9032bc3a600820415ae600c6388619a14d",
    price: ether(220.27)
  },
  MANA: {
    id: "mana",
    address: "0x0f5d2fb29fb7d3cfee444a200298f468908cc942",
    price: ether(1.46) ,
  },
  ENJ: {
    id: "enj",
    address: "0xf629cbd94d3791c9250152bd8dfbdf380e2a3b9c",
    price: ether(2.67),
  },
  WAXE: {
    id: "waxe",
    address: "0x7a2bc711e19ba6aff6ce8246c546e8c4b4944dfd",
    price: ether(182.68),
  },
  AXS: {
    id: "axie",
    address: "0xf5d669627376ebd411e34b98f19c868c8aba5ada",
    price: ether(10.97),
  },
  SAND: {
    id: "sand",
    address: "0x3845badade8e6dff049820680d1f14bd3903a5d0",
    price: ether(0.57),
  },
  RFOX: {
    id: "rfox",
    address: "0xa1d6df714f91debf4e0802a542e13067f31b8262",
    price: ether(0.26),
  },
  AUDIO: {
    id: "audio",
    address: "0x18aaa7115705e8be94bffebde57af9bfc265b998",
    price: ether(2.28),
  },
  DG: {
    id: "dg",
    address: "0xee06a81a695750e71a662b51066f2c74cf4478a0",
    price: ether(310.03),
  },
  NFTX: {
    id: "nftx",
    address: "0x87d73e916d7057945c9bcd8cdd94e42a6f47f776",
    price: ether(154.59),
  },
  WHALE: {
    id: "whale",
    address: "0x9355372396e3f6daf13359b7b607a3374cc638e0",
    price: ether(21.15),
  },
  MEME: {
    id: "meme",
    address: "0xd5525d397898e5502075ea5e830d8914f6f0affe",
    price: ether(1453.62),
  },
  TVK: {
    id: "tvk",
    address: "0xd084b83c305dafd76ae3e1b4e1f1fe2ecccb3988",
    price: ether(0.52),
  },
  RARI: {
    id: "rari",
    address: "0xfca59cd816ab1ead66534d82bc21e7515ce441cf",
    price: ether(20.94)
  },
  REVV: {
    id: "revv",
    address: "0x557b933a7c2c45672b610f8954a3deb39a51a8ca",
    price: ether(0.26)
  },
  MUSE: {
    id: "muse",
    address: "0xb6ca7399b4f9ca56fc27cbff44f4d2e4eef1fc81",
    price: ether(27.98)
  },
};