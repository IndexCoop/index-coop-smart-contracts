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
  WETH9,
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
  let wbtc: StandardTokenMock;
  let dai: StandardTokenMock;
  let weth: WETH9;

  let daiUnits: BigNumber;
  let wbtcUnits: BigNumber;

  cacheBeforeEach(async () => {
    [owner] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    ({ dai, wbtc, weth } = setV2Setup);

    zeroExMock = await deployer.mocks.deployZeroExExchangeProxyMock();

    daiUnits = BigNumber.from("23252699054621733");
    wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [dai.address, wbtc.address],
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
      wethAddress = weth.address;
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
      wethAddress = weth.address;
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
        const tokens = [dai, dai];
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
          subjectSetToApprove = dai;
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
        inputToken = dai;
        wethAmount = ether(1);
        amountSetToken = 1;
        amountSetTokenWei = ether(amountSetToken);
        inputSwapQuote = getUniswapV2Quote(dai.address, inputTokenAmount, weth.address, wethAmount);

        const positions = await setToken.getPositions();
        positionSwapQuotes = positions.map(position =>
          getUniswapV2Quote(
            weth.address,
            wethAmount.div(2),
            position.component,
            position.unit.mul(amountSetToken),
          ),
        );
      };

      beforeEach(async () => {
        initializeSubjectVariables();
        await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
        dai.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
        await weth.transfer(zeroExMock.address, wethAmount);
        await wbtc.transfer(zeroExMock.address, wbtcUnits.mul(amountSetToken));
        await dai.transfer(zeroExMock.address, daiUnits.mul(amountSetToken));
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

      context("when a position quote is missing", async () => {
        beforeEach(async () => {
          positionSwapQuotes = [ positionSwapQuotes[0] ];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("WRONG NUMBER OF COMPONENT QUOTES");
        });
      });

      context("when a position quote has the wrong buyTokenAddress", async () => {
        beforeEach(async () => {
          positionSwapQuotes[0].buyToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("COMPONENT / QUOTE ADDRESS MISMATCH");
        });
      });
    });
  });
});
