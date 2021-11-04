import "module-alias/register";

import { Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getZeroExFixture,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture, ZeroExFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ZeroEx } from "utils/contracts/zeroEx";

describe("ExchangeIssuanceV2", async () => {
  let owner: Account;
  let setV2Setup: SetFixture;

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
  });

  describe("#constructor", async () => {
    let zeroEx: ZeroEx;

    cacheBeforeEach(async () => {
      let zeroExSetup: ZeroExFixture;

      zeroExSetup = getZeroExFixture(owner.address);
      await zeroExSetup.initialize(owner.address);

      zeroEx = zeroExSetup.zeroEx;
    });

    it("Zero Ex Fixture working", async () => {
      await zeroEx.deployed();
      const impl = await zeroEx.getFunctionImplementation("0x12345678");
      console.log(impl);
    });
  });
});
