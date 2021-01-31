import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { Address } from "@utils/types";
import { ether } from "@utils/common/index";

interface AssetInfo {
  address: Address,
  price: BigNumber
}

export interface Assets {
  [symbol: string]: AssetInfo;
}


export const assets: Assets = {
  YFI: {
    address: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    price: ether(27622.04) ,
  },
  COMP: {
    address: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    price: ether(216.62),
  },
  SNX: {
    address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    price: ether(15.12),
  },
  MKR: {
    address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    price: ether(1321.38),
  },
  REN: {
    address: "0x408e41876cCCDC0F92210600ef50372656052a38",
    price: ether(0.5136),
  },
  KNC: {
    address: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
    price: ether(1.164),
  },
  LRC: {
    address: "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD",
    price: ether(0.3958),
  },
  BAL: {
    address: "0xba100000625a3754423978a60c9317c58a424e3D",
    price: ether(19.14),
  },
  UNI: {
    address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    price: ether(14.94),
  },
  AAVE: {
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    price: ether(284.53),
  },
  MTA: {
    address: "0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2",
    price: ether(2.91),
  },
  WETH: {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    price: ether(1370.82),
  }
};