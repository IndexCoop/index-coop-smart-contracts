export const polygonForkingConfig = {
  url: process.env.POLYGON_RPC_URL ?? "",
  blockNumber: 25004110,
};

export const optimismForkingConfig = {
  url: process.env.OPTIMISM_RPC_URL ?? "",
  blockNumber: 15275100,
};

export const mainnetForkingConfig = {
  url: "https://eth-mainnet.alchemyapi.io/v2/" + process.env.ALCHEMY_TOKEN,
  blockNumber: process.env.LATESTBLOCK ? undefined : 17150000,
};

export const forkingConfig =
  process.env.NETWORK === "polygon"
    ? polygonForkingConfig
    : process.env.NETWORK === "optimism"
    ? optimismForkingConfig
    : mainnetForkingConfig;

