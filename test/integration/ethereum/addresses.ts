import structuredClone from "@ungap/structured-clone";

export const PRODUCTION_ADDRESSES = {
  tokens: {
    stEthAm: "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390",
    stEth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    icEth: "0x7C07F7aBe10CE8e33DC6C5aD68FE033085256A84",
    aSTETH: "0x1982b2F5814301d4e9a8b0201555376e62F82428",
    ETH2xFli: "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
    cEther: "0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    cUSDC: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
    cDAI: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643",
    fixedDai: "0x015558c3aB97c9e5a9c8c437C71Bb498B2e5afB3",
    wsETH2: "0x5dA21D9e63F1EA13D34e48B7223bcc97e3ecD687",
    rETH2: "0x20BC832ca081b91433ff6c17f85701B6e92486c5",
    sETH2: "0xFe2e637202056d30016725477c5da089Ab0A043A",
  },
  whales: {
    stEth: "0xdc24316b9ae028f1497c275eb9192a3ea0f67022",
    dai: "0x075e72a5edf65f0a5f44699c7654c1a76941ddc8",
    weth: "0x2f0b23f53734252bda2277357e97e1517d6b042a",
    USDC: "0x55fe002aeff02f77364de339a1292923a15844b8",
  },
  dexes: {
    curve: {
      calculator: "0xc1DB00a8E5Ef7bfa476395cdbcc98235477cDE4E",
      addressProvider: "0x0000000022D53366457F9d5E68Ec105046FC4383",
      registry: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5",
      ethAddress: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
      pools: {
        stEthEth: "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022",
      },
    },
    sushiswap: {
      router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    },
    uniV2: {
      router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    },
    uniV3: {
      router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    },
  },
  set: {
    controller: "0xa4c8d221d8BB851f83aadd0223a8900A6921A349",
    debtIssuanceModule: "0x39F024d621367C044BacE2bf0Fb15Fb3612eCB92",
    debtIssuanceModuleV2: "0x69a592D2129415a4A1d1b1E309C17051B7F28d57",
    aaveLeverageModule: "0x251Bd1D42Df1f153D86a5BA2305FaADE4D5f51DC",
    compoundLeverageModule: "0x8d5174eD1dd217e240fDEAa52Eb7f4540b04F419",
  },
  setFork: {
    controller: "0xD2463675a099101E36D85278494268261a66603A",
    debtIssuanceModuleV2: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
    notionalTradeModule: "0x600d9950c6ecAef98Cc42fa207E92397A6c43416",
    tradeModule: "0xFaAB3F8f3678f68AA0d307B66e71b636F82C28BF",
    airdropModule: "0x09b9e7c7e2daf40fCb286fE6b863e517d5d5c40F",
  },
  lending: {
    aave: {
      addressProvider: "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5",
      lendingPool: "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9",
    },
    notional: {
      wrappedfCashFactory: "0x5D051DeB5db151C2172dCdCCD42e6A2953E27261",
      notionalV2: "0x1344a36a1b56144c3bc62e7757377d288fde0369",
      nUpgreadableBeacon: "0xFAaF0C5B81E802C231A5249221cfe0B6ae639118",
    },
  },
};

export const STAGING_ADDRESSES = structuredClone(PRODUCTION_ADDRESSES);

STAGING_ADDRESSES.set = {
  controller: "0xF1B12A7b1f0AF744ED21eEC7d3E891C48Fd3c329",
  debtIssuanceModule: "0x39F024d621367C044BacE2bf0Fb15Fb3612eCB92",
  debtIssuanceModuleV2: "0x3C0CC7624B1c408cF2cF11b3961301949f2F7820",
  aaveLeverageModule: "0x5d2B710787078B45CD7582C0423AC2fC180262e8",
  compoundLeverageModule: "0x8d5174eD1dd217e240fDEAa52Eb7f4540b04F419",
};

STAGING_ADDRESSES.tokens.icEth = "0x219C0C5B42A2DF32782d8F6Bf10eddCD7414CbBf";

export default PRODUCTION_ADDRESSES;
