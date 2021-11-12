import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_96, MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getRandomAddress,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import DeployHelper from "@utils/deploys";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import {
  ExchangeIssuanceZeroEx,
  ZeroExExchangeProxyMock,
  StandardTokenMock,
} from "@utils/contracts/index";
import { getAllowances } from "@utils/common/exchangeIssuanceUtils";

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

  describe("#constructor", async () => {
    let wethAddress: Address;
    let controllerAddress: Address;
    let basicIssuanceModuleAddress: Address;

    cacheBeforeEach(async () => {
      wethAddress = setV2Setup.weth.address;
      basicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
      controllerAddress = setV2Setup.controller.address;
    });

    async function subject(): Promise<ExchangeIssuanceZeroEx> {
      return await deployer.extensions.deployExchangeIssuanceZeroEx(
        wethAddress,
        controllerAddress,
        basicIssuanceModuleAddress,
        [zeroExMock.address],
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceZeroEx = await subject();

      const expectedWethAddress = await exchangeIssuanceContract.WETH();
      expect(expectedWethAddress).to.eq(wethAddress);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(controllerAddress);

      const expectedBasicIssuanceModuleAddress = await exchangeIssuanceContract.basicIssuanceModule();
      expect(expectedBasicIssuanceModuleAddress).to.eq(basicIssuanceModuleAddress);

      const isZeroExMockAllowedSwapTarget = await exchangeIssuanceContract.allowedSwapTargets(
        zeroExMock.address,
      );
      expect(isZeroExMockAllowedSwapTarget).to.eq(true);

      const isRandomAddressAllowedSwapTarget = await exchangeIssuanceContract.allowedSwapTargets(
        getRandomAddress(),
      );
      expect(isRandomAddressAllowedSwapTarget).to.eq(false);
    });
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

    describe("#approveSetToken", async () => {
      let subjectSetToApprove: SetToken | StandardTokenMock;

      beforeEach(async () => {
        subjectSetToApprove = setToken;
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.approveSetToken(subjectSetToApprove.address);
      }
      it("should update the approvals correctly", async () => {
        const tokens = [setV2Setup.dai, setV2Setup.dai];
        const spenders = [basicIssuanceModuleAddress];

        await subject();

        const finalAllowances = await getAllowances(
          tokens,
          exchangeIssuanceZeroEx.address,
          spenders,
        );

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });

      context("when the input token is not a set", async () => {
        beforeEach(async () => {
          subjectSetToApprove = setV2Setup.dai;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET");
        });
      });
    });

    describe("#issueExactSetFromToken", async () => {
      let inputToken: StandardTokenMock;
      let inputTokenAmount: BigNumber;
      let wethAmount: BigNumber;
      let amountSetToken: number;
      let amountSetTokenWei: BigNumber;
      let inputSwapQuote: ZeroExSwapQuote;
      let positionSwapQuotes: ZeroExSwapQuote[];

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

      it("should use correct amount of input tokens", async () => {
        const initialBalanceOfInput = await inputToken.balanceOf(owner.address);
        await subject();
        const finalInputBalance = await inputToken.balanceOf(owner.address);
        const expectedInputBalance = initialBalanceOfInput.sub(inputTokenAmount);
        expect(finalInputBalance).to.eq(expectedInputBalance);
      });
    });
  });
});
