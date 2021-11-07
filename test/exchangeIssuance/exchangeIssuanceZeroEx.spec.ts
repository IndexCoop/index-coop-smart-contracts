import "module-alias/register";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getZeroExFixture,
  getUniswapV3Fixture,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture, ZeroExFixture, UniswapV3Fixture } from "@utils/fixtures";
import { BigNumber, Contract } from "ethers";
import { hexUtils } from "@0x/utils";

const POOL_FEE = 3000;

// Used to encode Uniswap trading path to format expected by zeroEx
// Taken from: https://github.com/0xProject/protocol/blob/development/contracts/zero-ex/test/features/uniswapv3_test.ts#L118
function encodePath(tokens_: Array<Contract>): string {
  const elems: string[] = [];
  tokens_.forEach((t, i) => {
    if (i) {
      elems.push(hexUtils.leftPad(POOL_FEE, 3));
    }
    elems.push(hexUtils.leftPad(t.address, 20));
  });
  return hexUtils.concat(...elems);
}

describe("ExchangeIssuanceV2", async () => {
  let owner: Account;
  let setV2Setup: SetFixture;
  let uniswapV3Setup: UniswapV3Fixture;
  let zeroExSetup: ZeroExFixture;

  let setToken: SetToken;
  let setTokenWithWeth: SetToken;

  cacheBeforeEach(async () => {
    [owner] = await getAccounts();

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    const daiUnits = BigNumber.from("23252699054621733");
    const wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    const wethUnits = ether(0.5);
    setTokenWithWeth = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.weth.address],
      [daiUnits, wethUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.issuanceModule.initialize(setTokenWithWeth.address, ADDRESS_ZERO);

    uniswapV3Setup = getUniswapV3Fixture(owner.address);

    await setV2Setup.initialize();
    await uniswapV3Setup.initialize(
      owner,
      setV2Setup.weth,
      2000,
      setV2Setup.wbtc,
      35000,
      setV2Setup.dai,
    );
    zeroExSetup = getZeroExFixture(owner.address);

    await zeroExSetup.initialize(owner.address);
    await zeroExSetup.zeroEx.deployed();
  });

  describe("#constructor", async () => {
    it("Execute UniswapV3 trade via ZeroEx", async () => {
      // Code Hash taken from: https://github.com/Uniswap/v3-sdk/blob/main/src/constants.ts
      // TODO: Check if this is correct or needs to be gnerated dynamically somehow
      const POOL_INIT_CODE_HASH =
        "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
      await zeroExSetup.registerUniswapV3Feature(
        setV2Setup.weth.address,
        uniswapV3Setup.factory.address,
        POOL_INIT_CODE_HASH,
      );

      // Add Liquidity
      await setV2Setup.weth.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
      await setV2Setup.dai.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
      await uniswapV3Setup.addLiquidityWide(
        setV2Setup.weth,
        setV2Setup.dai,
        3000,
        ether(10),
        ether(30_000),
        owner.address,
      );


      // Attach the uniswapV3Feature interface to to the proxy address
      const zeroEx = zeroExSetup.uniswapV3Feature.attach(zeroExSetup.zeroEx.address);



      await setV2Setup.weth.approve(zeroExSetup.zeroEx.address, MAX_UINT_256);
      const encodedPath = encodePath([setV2Setup.weth, setV2Setup.dai]);
      const recipient = "0x0000000000000000000000000000000000000000";
      const sellAmount = ether(0.001);
      const minBuyAmount = ether(1000);


      // TODO: Reverting
      await zeroEx.sellTokenForTokenToUniswapV3(encodedPath, sellAmount, minBuyAmount, recipient);
    });
  });
});
