import structuredClone from "@ungap/structured-clone";

export const PRODUCTION_ADDRESSES = {
  tokens: {
    stEthAm: "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390",
    stEth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
    dai: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    icEth: "0x7C07F7aBe10CE8e33DC6C5aD68FE033085256A84",
    ETH2xFli: "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
    cEther: "0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    cUSDC: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
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
      router: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
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
  lending: {
    aave: {
      addressProvider: "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5",
      lendingPool: "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9",
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
