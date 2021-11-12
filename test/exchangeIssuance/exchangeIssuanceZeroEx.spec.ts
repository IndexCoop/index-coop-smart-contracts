import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import { cacheBeforeEach, ether, getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ExchangeIssuanceZeroEx, ZeroExExchangeProxyMock } from "@utils/contracts/index";

const expect = getWaffleExpect();

type ZeroExSwapQuote = {
  sellToken: Address;
  buyToken: Address;
  spender: Address;
  swapTarget: Address;
  swapCallData: string;
  value: BigNumber;
  sellAmount: BigNumber;
};

describe("ExchangeIssuanceZeroEx", async () => {
  let owner: Account;
  let setV2Setup: SetFixture;
  let zeroExMock: ZeroExExchangeProxyMock;
  let deployer: DeployHelper;

  let setToken: SetToken;
  let daiUnits: BigNumber;
  let wbtcUnits: BigNumber;

  cacheBeforeEach(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    zeroExMock = await deployer.mocks.deployZeroExExchangeProxyMock();

    daiUnits = BigNumber.from("23252699054621733");
    wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
    );
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
  });

  describe("ZeroEx Mock contract", async () => {
    let wethAddress: Address;
    let controllerAddress: Address;
    let basicIssuanceModuleAddress: Address;

    cacheBeforeEach(async () => {
      wethAddress = setV2Setup.weth.address;
      controllerAddress = setV2Setup.controller.address;
      basicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
    });

    async function subject(): Promise<ExchangeIssuanceZeroEx> {
      return await deployer.extensions.deployExchangeIssuanceZeroEx(
        wethAddress,
        controllerAddress,
        basicIssuanceModuleAddress,
        [zeroExMock.address],
      );
    }

    function getUniswapV2Quote(
      sellToken: Address,
      sellAmount: BigNumber,
      buyToken: Address,
      minBuyAmount: BigNumber,
    ): ZeroExSwapQuote {
      const isSushi = false;
      return {
        sellToken,
        buyToken,
        spender: zeroExMock.address,
        swapTarget: zeroExMock.address,
        swapCallData: zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [sellToken, buyToken],
          sellAmount,
          minBuyAmount,
          isSushi,
        ]),
        value: ether(0),
        sellAmount,
      };
    }

    it("Issue Exact Set from Input Token", async () => {
      const inputToken = setV2Setup.dai;

      // Generate call data for swap to weth
      const inputTokenAmount = ether(1000);
      const wethAmount = ether(1);
      const amountSetToken = 1;
      const amountSetTokenWei = ether(amountSetToken);
      const inputSwapQuote = getUniswapV2Quote(
        setV2Setup.dai.address,
        inputTokenAmount,
        setV2Setup.weth.address,
        wethAmount,
      );

      const positions = await setToken.getPositions();
      const positionSwapQuotes: ZeroExSwapQuote[] = positions.map(position =>
        getUniswapV2Quote(
          setV2Setup.weth.address,
          wethAmount.div(2),
          position.component,
          position.unit.mul(amountSetToken),
        ),
      );

      const exchangeIssuanceZeroEx = await subject();
      await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
      // Approve exchange issuance contract to spend the input token
      setV2Setup.dai.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
      // Fund the Exchange mock with tokens to be traded into (weth and components)
      await setV2Setup.weth.transfer(zeroExMock.address, wethAmount);
      await setV2Setup.wbtc.transfer(zeroExMock.address, wbtcUnits.mul(amountSetToken));
      await setV2Setup.dai.transfer(zeroExMock.address, daiUnits.mul(amountSetToken));

      const initialBalanceOfSet = await setToken.balanceOf(owner.address);
      console.log("IssueTokens");
      exchangeIssuanceZeroEx.issueExactSetFromToken(
        setToken.address,
        inputToken.address,
        inputSwapQuote,
        amountSetTokenWei,
        inputTokenAmount,
        positionSwapQuotes,
      );

      const finalSetBalance = await setToken.balanceOf(owner.address);
      const expectedSetBalance = initialBalanceOfSet.add(amountSetTokenWei);
      expect(finalSetBalance).to.eq(expectedSetBalance);
    });

    it("Redeems Exact Set For Token", async () => {
      const outputToken = setV2Setup.dai;

      // Generate call data for swap from weth
      const outputTokenAmount = ether(1000);
      const wethAmount = ether(1);
      const amountSetToken = 1;
      const amountSetTokenWei = ether(amountSetToken);
      const outputSwapQuote = getUniswapV2Quote(
        setV2Setup.weth.address,
        outputTokenAmount,
        setV2Setup.dai.address,
        wethAmount,
      );

      const positions = await setToken.getPositions();
      const positionSwapQuotes: ZeroExSwapQuote[] = positions.map(position =>
        getUniswapV2Quote(
          position.component,
          wethAmount.div(2),
          setV2Setup.weth.address,
          position.unit.mul(amountSetToken),
        ),
      );

      const exchangeIssuanceZeroEx = await subject();
      await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
      // Approve exchange issuance contract to spend the input token
      setV2Setup.dai.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
      // Fund the Exchange mock with tokens to be traded into (weth and components)
      await setV2Setup.weth.transfer(zeroExMock.address, wethAmount);
      await setV2Setup.wbtc.transfer(zeroExMock.address, wbtcUnits.mul(amountSetToken));
      await setV2Setup.dai.transfer(zeroExMock.address, daiUnits.mul(amountSetToken));

      const initialBalanceOfSet = await setToken.balanceOf(owner.address);
      console.log("IssueTokens");
      exchangeIssuanceZeroEx.redeemExactSetForToken(
        setToken.address,
        outputToken.address,
        outputSwapQuote,
        amountSetTokenWei,
        outputTokenAmount,
        positionSwapQuotes,
      );

      const finalSetBalance = await setToken.balanceOf(owner.address);
      const expectedSetBalance = initialBalanceOfSet.sub(amountSetTokenWei);
      expect(finalSetBalance).to.eq(expectedSetBalance);
    });
  });
});
