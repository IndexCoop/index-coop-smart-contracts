
export const PRODUCTION_ADDRESSES = {
  tokens: {
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    aWETH: "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8",
    ETH2X: "0x26d7D3728C6bb762a5043a1d0CeF660988Bca43C",
    ETH3X: "0xA0A17b2a015c14BE846C5d309D076379cCDfa543",
    iETH1X: "0x749654601a286833aD30357246400D2933b1C89b",
    BTC2X: "0xeb5bE62e6770137beaA0cC712741165C594F59D7",
    BTC3X: "0x3bDd0d5c0C795b2Bf076F5C8F177c58e42beC0E6",
    iBTC1X: "0x80e58AEA88BCCaAE19bCa7f0e420C1387Cc087fC",
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    aUSDC: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
    wbtc: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    aAave: "0xf329e36C7bF6E5E86ce2150875a84Ce77f477375",
    aave: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196",
    aave2x: "0x9ba1d6C651624977435bc6E2c98D4c7407112e15",
    aWBTC: "0x078f358208685046a11C85e8ad32895DED33A249",
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  },
  whales: {
    wbtc: "0x7bcefd1bc97a1af01c5ede3a3199aa11a77b6b45",
    aWBTC: "0x8Af700bA841f30e0a3Fcb0EE4C4A9D223E1eFA05",
    weth: "0xc3e5607cd4ca0d5fe51e09b60ed97a0ae6f874dd",
    aWETH: "0xb7fb2b774eb5e2dad9c060fb367acbdc7fa7099b",
    USDC: "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D",
    aUSDC: "0xa0894a415c4f246ce95bae718849579c099cc1d2",
  },
  dexes: {
    uniV3: {
      router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // SwapRouter02
      quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", // QuoterV2
    },
    sushiswap: {
      router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    },
    curve: {
      addressProvider: "0x0000000022D53366457F9d5E68Ec105046FC4383",
    },
    balancerv2: {
      vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    },
  },
  setFork: {
    controller: "0xCd79A0B9aeca0eCE7eA59d14338ea330cb1cb2d7",
    debtIssuanceModuleV2: "0x120d2f26B7ffd35a8917415A5766Fa63B2af94aa",
    debtIssuanceModuleV3: "0x4AC26c26116Fa976352b70700af58Bc2442489d8",
    aaveV3LeverageModule: "0x6D1b74e18064172D028C5EE7Af5D0ccC26f2A4Ae",
    extensions: {
      ETH2X: {
        aaveV3LeverageStrategyExtension: "0x6Ab1a997df5637810F5CEb0CC25a28ADDCD75A82",
      },
      ETH3X: {
        aaveV3LeverageStrategyExtension: "0x991fAA73e64435EAC3697AE9DEE4E6e7B85fda59",
      },
      iETH1X: {
        aaveV3LeverageStrategyExtension: "0x5d5f7b965833470A65817558C167420E6c09286e",
      },
      BTC2X: {
        aaveV3LeverageStrategyExtension: "0x3E6aDeC44f5271508E6A119bd4a3fecfdB87A012",
      },
      BTC3X: {
        aaveV3LeverageStrategyExtension: "0xeB3826bFc2fA9baf56EA3EA9771EcBfe5B0CD606",
      },
      iBTC1X: {
        aaveV3LeverageStrategyExtension: "0x86a71F1f8f3b140B7B2c867857d3624edDfeF5dD",
      },
    },
  },
  lending: {
    aaveV3: {
      addressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      lendingPool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },
};

export default PRODUCTION_ADDRESSES;
