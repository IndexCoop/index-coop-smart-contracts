import "module-alias/register";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import { cacheBeforeEach, ether, getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ZeroExExchangeProxyMock } from "@utils/contracts/index";

const expect = getWaffleExpect();

describe("ExchangeIssuanceV2", async () => {
  let owner: Account;
  let setV2Setup: SetFixture;
  let zeroExMock: ZeroExExchangeProxyMock;
  let deployer: DeployHelper;

  let setToken: SetToken;
  let setTokenWithWeth: SetToken;

  cacheBeforeEach(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    zeroExMock = await deployer.mocks.deployZeroExExchangeProxyMock();

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

  describe("ZeroEx Mock contract", async () => {
    it("Mocked out UniswapV2 trade works", async () => {
      const sellAmount = ether(1000);
      const minBuyAmount = ether(0.001);
      const isSushi = false;

      console.log("Transfering sell token to mock contract");
      const fundMockTx = await setV2Setup.weth.transfer(zeroExMock.address, minBuyAmount);
      await fundMockTx.wait();

      const wethBalanceBefore = await setV2Setup.weth.balanceOf(owner.address);
      const daiBalanceBefore = await setV2Setup.dai.balanceOf(owner.address);

      console.log("Trading");
      await setV2Setup.dai.approve(zeroExMock.address, MAX_UINT_256);
      await zeroExMock.sellToUniswap(
        [setV2Setup.dai.address, setV2Setup.weth.address],
        sellAmount,
        minBuyAmount,
        isSushi,
      );

      const wethBalanceAfter = await setV2Setup.weth.balanceOf(owner.address);
      const daiBalanceAfter = await setV2Setup.dai.balanceOf(owner.address);

      expect(wethBalanceAfter.sub(wethBalanceBefore)).to.equal(minBuyAmount);
      expect(daiBalanceBefore.sub(daiBalanceAfter)).to.equal(sellAmount);
    });
  });
});
