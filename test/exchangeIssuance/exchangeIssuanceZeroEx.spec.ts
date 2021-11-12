import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import { cacheBeforeEach, ether, getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import {
  ExchangeIssuanceZeroEx,
  ZeroExExchangeProxyMock,
  StandardTokenMock,
} from "@utils/contracts/index";

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

  // Helper function to generate 0xAPI quote for UniswapV2
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

  context("when exchange issuance is deployed", async () => {
    let wethAddress: Address;
    let controllerAddress: Address;
    let basicIssuanceModuleAddress: Address;
    let exchangeIssuanceZeroEx: ExchangeIssuanceZeroEx;

    cacheBeforeEach(async () => {
      wethAddress = setV2Setup.weth.address;
      controllerAddress = setV2Setup.controller.address;
      basicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
      exchangeIssuanceZeroEx = await deployer.extensions.deployExchangeIssuanceZeroEx(
        wethAddress,
        controllerAddress,
        basicIssuanceModuleAddress,
        [zeroExMock.address],
      );
    });

    describe("#issueExactSetFromToken", async () => {
      let inputToken: StandardTokenMock;
      let inputTokenAmount: BigNumber;
      let wethAmount: BigNumber;
      let amountSetToken: number;
      let amountSetTokenWei: BigNumber;
      let inputSwapQuote: ZeroExSwapQuote;
      let positionSwapQuotes: ZeroExSwapQuote[];

      const initializeSubjectVariables = async () => {
        inputTokenAmount = ether(1000);
        inputToken = setV2Setup.dai;
        wethAmount = ether(1);
        amountSetToken = 1;
        amountSetTokenWei = ether(amountSetToken);
        inputSwapQuote = getUniswapV2Quote(
          setV2Setup.dai.address,
          inputTokenAmount,
          setV2Setup.weth.address,
          wethAmount,
        );

        const positions = await setToken.getPositions();
        positionSwapQuotes = positions.map(position =>
          getUniswapV2Quote(
            setV2Setup.weth.address,
            wethAmount.div(2),
            position.component,
            position.unit.mul(amountSetToken),
          ),
        );
      };

      cacheBeforeEach(async () => {
        initializeSubjectVariables();
        await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
        // Approve exchange issuance contract to spend the input token
        setV2Setup.dai.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
        // Fund the Exchange mock with tokens to be traded into (weth and components)
        await setV2Setup.weth.transfer(zeroExMock.address, wethAmount);
        await setV2Setup.wbtc.transfer(zeroExMock.address, wbtcUnits.mul(amountSetToken));
        await setV2Setup.dai.transfer(zeroExMock.address, daiUnits.mul(amountSetToken));
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.issueExactSetFromToken(
          setToken.address,
          inputToken.address,
          inputSwapQuote,
          amountSetTokenWei,
          inputTokenAmount,
          positionSwapQuotes,
        );
      }

      it("should issue correct amount of set tokens", async () => {
        const initialBalanceOfSet = await setToken.balanceOf(owner.address);

        await subject();

        const finalSetBalance = await setToken.balanceOf(owner.address);
        const expectedSetBalance = initialBalanceOfSet.add(amountSetTokenWei);
        expect(finalSetBalance).to.eq(expectedSetBalance);
      });
    });
  });
});
