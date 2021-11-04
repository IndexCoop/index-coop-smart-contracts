import "module-alias/register";

import { Account } from "@utils/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getZeroExFixture,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture, ZeroExFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ZeroEx } from "utils/contracts/zeroEx";

const expect = getWaffleExpect();

describe("ExchangeIssuanceV2", async () => {
  let owner: Account;
  let setV2Setup: SetFixture;
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
  });

  describe("#constructor", async () => {
    let zeroEx: ZeroEx;

    cacheBeforeEach(async () => {
      zeroExSetup = getZeroExFixture(owner.address);
      await zeroExSetup.initialize(owner.address);
      zeroEx = zeroExSetup.zeroEx;
      zeroEx.deployed();
    });

    it("Implementations for ownable and registry correct", async () => {
      const ownable = zeroExSetup.ownableFeature;
      const registry = zeroExSetup.registryFeature;
      const ownableSelectors = [ownable.interface.getSighash("transferOwnership")];
      const registrySelectors = [registry.interface.getSighash("rollback"), registry.interface.getSighash("extend")];
      const selectors = [...ownableSelectors, ...registrySelectors];
      const impls = await Promise.all(selectors.map(s => zeroEx.getFunctionImplementation(s)));
      for (let i = 0; i < impls.length; ++i) {
        const selector = selectors[i];
        const impl = impls[i];
        const expectedImpl = ownableSelectors.includes(selector)
          ? ownable.address
          : registry.address;
        expect(impl).to.eq(expectedImpl);
      }
    });

  });
});
