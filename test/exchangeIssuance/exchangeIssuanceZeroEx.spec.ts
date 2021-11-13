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
  swapCallData: string;
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
    let subjectWethAddress: Address;
    let subjectControllerAddress: Address;
    let subjectBasicIssuanceModuleAddress: Address;
    let subjectSwapTarget: Address;

    cacheBeforeEach(async () => {
      subjectWethAddress = weth.address;
      subjectBasicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
      subjectControllerAddress = setV2Setup.controller.address;
      subjectSwapTarget = zeroExMock.address;
    });

    async function subject(): Promise<ExchangeIssuanceZeroEx> {
      return await deployer.extensions.deployExchangeIssuanceZeroEx(
        subjectWethAddress,
        subjectControllerAddress,
        subjectBasicIssuanceModuleAddress,
        subjectSwapTarget,
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceZeroEx = await subject();

      const expectedWethAddress = await exchangeIssuanceContract.WETH();
      expect(expectedWethAddress).to.eq(subjectWethAddress);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(subjectControllerAddress);

      const expectedBasicIssuanceModuleAddress = await exchangeIssuanceContract.basicIssuanceModule();
      expect(expectedBasicIssuanceModuleAddress).to.eq(subjectBasicIssuanceModuleAddress);

      const swapTarget = await exchangeIssuanceContract.swapTarget();
      expect(swapTarget).to.eq(subjectSwapTarget);
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
        zeroExMock.address,
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
      let subjectInputToken: StandardTokenMock | WETH9;
      let subjectInputTokenAmount: BigNumber;
      let subjectWethAmount: BigNumber;
      let subjectAmountSetToken: number;
      let subjectAmountSetTokenWei: BigNumber;
      let subjectInputSwapQuote: ZeroExSwapQuote;
      let subjectPositionSwapQuotes: ZeroExSwapQuote[];

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
          swapCallData: zeroExMock.interface.encodeFunctionData("sellToUniswap", [
            [sellToken, buyToken],
            sellAmount,
            minBuyAmount,
            isSushi,
          ]),
          sellAmount,
        };
      }

      const initializeSubjectVariables = async () => {
        subjectInputTokenAmount = ether(1000);
        subjectInputToken = dai;
        subjectWethAmount = ether(1);
        subjectAmountSetToken = 1;
        subjectAmountSetTokenWei = ether(subjectAmountSetToken);
        subjectInputSwapQuote = getUniswapV2Quote(
          dai.address,
          subjectInputTokenAmount,
          weth.address,
          subjectWethAmount,
        );

        const positions = await setToken.getPositions();
        subjectPositionSwapQuotes = positions.map(position =>
          getUniswapV2Quote(
            weth.address,
            subjectWethAmount.div(2),
            position.component,
            position.unit.mul(subjectAmountSetToken),
          ),
        );
      };

      beforeEach(async () => {
        initializeSubjectVariables();
        await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
        dai.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
        await weth.transfer(zeroExMock.address, subjectWethAmount);
        await wbtc.transfer(zeroExMock.address, wbtcUnits.mul(subjectAmountSetToken));
        await dai.transfer(zeroExMock.address, daiUnits.mul(subjectAmountSetToken));
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.issueExactSetFromToken(
          setToken.address,
          subjectInputToken.address,
          subjectInputSwapQuote,
          subjectAmountSetTokenWei,
          subjectInputTokenAmount,
          subjectPositionSwapQuotes,
        );
      }

      it("should issue correct amount of set tokens", async () => {
        const initialBalanceOfSet = await setToken.balanceOf(owner.address);
        await subject();
        const finalSetBalance = await setToken.balanceOf(owner.address);
        const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
        expect(finalSetBalance).to.eq(expectedSetBalance);
      });

      it("should use correct amount of input tokens", async () => {
        const initialBalanceOfInput = await subjectInputToken.balanceOf(owner.address);
        await subject();
        const finalInputBalance = await subjectInputToken.balanceOf(owner.address);
        const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
        expect(finalInputBalance).to.eq(expectedInputBalance);
      });

      context("when the input swap generates surplus WETH", async () => {
        beforeEach(async () => {
          await weth.transfer(zeroExMock.address, subjectWethAmount);
          await zeroExMock.setBuyMultiplier(weth.address, ether(2));
        });
        it("should return surplus WETH to user", async () => {
          const initialBalanceOfSet = await setToken.balanceOf(owner.address);
          const wethBalanceBefore = await weth.balanceOf(owner.address);
          await subject();
          const finalSetBalance = await setToken.balanceOf(owner.address);
          const wethBalanceAfter = await weth.balanceOf(owner.address);
          const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
          const expectedWethBalance = wethBalanceBefore.add(subjectWethAmount);
          expect(wethBalanceAfter).to.equal(expectedWethBalance);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });
      });

      context("when the input token is weth", async () => {
        beforeEach(async () => {
          subjectInputToken = weth;
          subjectInputTokenAmount = subjectWethAmount;
          await weth.approve(exchangeIssuanceZeroEx.address, subjectInputTokenAmount);
        });
        it("should issue correct amount of set tokens", async () => {
          const initialBalanceOfSet = await setToken.balanceOf(owner.address);
          await subject();
          const finalSetBalance = await setToken.balanceOf(owner.address);
          const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });
        it("should use correct amount of input tokens", async () => {
          const initialBalanceOfInput = await subjectInputToken.balanceOf(owner.address);
          await subject();
          const finalInputBalance = await subjectInputToken.balanceOf(owner.address);
          const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
          expect(finalInputBalance).to.eq(expectedInputBalance);
        });
      });

      context("when a position quote is missing", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes = [subjectPositionSwapQuotes[0]];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("WRONG NUMBER OF COMPONENT QUOTES");
        });
      });

      context("when a position quote has the wrong buyTokenAddress", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].buyToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("COMPONENT / QUOTE ADDRESS MISMATCH");
        });
      });

      context("when a position quote has a non-WETH sellToken address", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].sellToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("INVALID SELL TOKEN");
        });
      });

      context("when the sum of the approved WETH exceeds the amount obtained", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].sellAmount = ether(100000);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("OVERAPPROVED WETH");
        });
      });

      context("when the input swap yields insufficient WETH", async () => {
        beforeEach(async () => {
          await zeroExMock.setBuyMultiplier(weth.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("OVERAPPROVED WETH");
        });
      });

      context("when a component swap spends too much weth", async () => {
        beforeEach(async () => {
          // Simulate left over weth balance left in contract
          await weth.transfer(exchangeIssuanceZeroEx.address, subjectWethAmount);
          await zeroExMock.setSellMultiplier(weth.address, ether(2));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("OVERSPENT WETH");
        });
      });

      context("when a component swap yields insufficient component token", async () => {
        beforeEach(async () => {
          // Simulating left over component balance left in contract
          await wbtc.transfer(exchangeIssuanceZeroEx.address, wbtcUnits);
          await zeroExMock.setBuyMultiplier(wbtc.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UNDERBOUGHT COMPONENT");
        });
      });

      context("when a swap call fails", async () => {
        beforeEach(async () => {
          // Trigger revertion in mock by trying to return more buy tokens than available in balance
          await zeroExMock.setBuyMultiplier(wbtc.address, ether(100));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("SWAP CALL FAILED");
        });
      });
    });
  });
});
