import "module-alias/register";
import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_96, MAX_UINT_256, ETH_ADDRESS, ZERO, ONE } from "@utils/constants";
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
  swapCallData: string;
};

describe("ExchangeIssuanceZeroEx", async () => {
  let owner: Account;
  let user: Account;
  let externalPositionModule: Account;
  let setV2Setup: SetFixture;
  let zeroExMock: ZeroExExchangeProxyMock;
  let deployer: DeployHelper;
  let setToken: SetToken;

  let wbtc: StandardTokenMock;
  let dai: StandardTokenMock;
  let usdc: StandardTokenMock;
  let weth: WETH9;

  let daiUnits: BigNumber;
  let wbtcUnits: BigNumber;

  cacheBeforeEach(async () => {
    [owner, user, externalPositionModule] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    dai = setV2Setup.dai;
    wbtc = setV2Setup.wbtc;
    weth = setV2Setup.weth;
    usdc = setV2Setup.usdc;

    zeroExMock = await deployer.mocks.deployZeroExExchangeProxyMock();

    daiUnits = BigNumber.from("23252699054621733");
    wbtcUnits = UnitsUtils.wbtc(1);

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
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
    let setTokenExternal: SetToken;

    cacheBeforeEach(async () => {
      setTokenExternal = await setV2Setup.createSetToken(
        [setV2Setup.dai.address],
        [ether(0.5)],
        [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
      );
      await setV2Setup.issuanceModule.initialize(setTokenExternal.address, ADDRESS_ZERO);

      const controller = setV2Setup.controller;
      await controller.addModule(externalPositionModule.address);
      await setTokenExternal.addModule(externalPositionModule.address);
      await setTokenExternal.connect(externalPositionModule.wallet).initializeModule();

      await setTokenExternal.connect(externalPositionModule.wallet).addExternalPositionModule(
        dai.address,
        externalPositionModule.address
      );

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

      context("when set token has external positions", async () => {
        beforeEach(async () => {
          subjectSetToApprove = setTokenExternal;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED");
        });
      });
    });

    describe("#receive", async () => {
      let subjectCaller: Account;
      let subjectAmount: BigNumber;

      beforeEach(async () => {
        subjectCaller = user;
        subjectAmount = ether(10);
      });

      async function subject(): Promise<String> {
        return subjectCaller.wallet.call({ to: exchangeIssuanceZeroEx.address, value: subjectAmount });
      }

      it("should revert when receiving ether not from the WETH contract", async () => {
        await expect(subject()).to.be.revertedWith("ExchangeIssuance: Direct deposits not allowed");
      });
    });

    describe("#setSwapTarget", async () => {
      let subjectSwapTarget: Address;

      beforeEach(async () => {
        subjectSwapTarget = await getRandomAddress();
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.setSwapTarget(subjectSwapTarget);
      }
      it("should update the swap target correctly", async () => {
        await subject();
        const swapTarget = await exchangeIssuanceZeroEx.swapTarget();
        expect(swapTarget).to.eq(subjectSwapTarget);
      });
    });

    describe("#approveTokens", async () => {
      let subjectTokensToApprove: StandardTokenMock[];

      beforeEach(async () => {
        subjectTokensToApprove = [setV2Setup.dai, setV2Setup.wbtc];
      });


      async function subject() {
        return await exchangeIssuanceZeroEx.approveTokens(subjectTokensToApprove.map(token => token.address));
      }

      it("should update the approvals correctly", async () => {
        const spenders = [zeroExMock.address, basicIssuanceModuleAddress];

        await subject();

        const finalAllowances = await getAllowances(subjectTokensToApprove, exchangeIssuanceZeroEx.address, spenders);

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });
    });

    // Helper function to generate 0xAPI quote for UniswapV2
    const getUniswapV2Quote = (
      sellToken: Address,
      sellAmount: BigNumber,
      buyToken: Address,
      minBuyAmount: BigNumber,
    ): ZeroExSwapQuote => {
      const isSushi = false;
      return {
        sellToken,
        buyToken,
        swapCallData: zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [sellToken, buyToken],
          sellAmount,
          minBuyAmount,
          isSushi,
        ]),
      };
    };

    describe("#issueExactSetFromToken", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectInputToken: StandardTokenMock | WETH9;
      let subjectInputTokenAmount: BigNumber;
      let subjectWethAmount: BigNumber;
      let subjectAmountSetToken: number;
      let subjectAmountSetTokenWei: BigNumber;
      let subjectInputSwapQuote: ZeroExSwapQuote;
      let subjectPositionSwapQuotes: ZeroExSwapQuote[];

      const initializeSubjectVariables = async () => {
        subjectCaller = user;
        subjectSetToken = setToken;
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

        const positions = await subjectSetToken.getPositions();
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
        await exchangeIssuanceZeroEx.approveSetToken(subjectSetToken.address);
        dai.connect(subjectCaller.wallet).approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
        await dai.transfer(subjectCaller.address, subjectInputTokenAmount);
        await weth.transfer(zeroExMock.address, subjectWethAmount);
        await wbtc.transfer(zeroExMock.address, wbtcUnits.mul(subjectAmountSetToken));
        await dai.transfer(zeroExMock.address, daiUnits.mul(subjectAmountSetToken));
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.connect(subjectCaller.wallet).issueExactSetFromToken(
          subjectSetToken.address,
          subjectInputToken.address,
          subjectInputSwapQuote,
          subjectAmountSetTokenWei,
          subjectInputTokenAmount,
          subjectPositionSwapQuotes,
        );
      }

      it("should issue correct amount of set tokens", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
        await subject();
        const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
        expect(finalSetBalance).to.eq(expectedSetBalance);
      });

      it("should use correct amount of input tokens", async () => {
        const initialBalanceOfInput = await subjectInputToken.balanceOf(subjectCaller.address);
        await subject();
        const finalInputBalance = await subjectInputToken.balanceOf(subjectCaller.address);
        const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
        expect(finalInputBalance).to.eq(expectedInputBalance);
      });

      context("when the input swap generates surplus WETH", async () => {
        beforeEach(async () => {
          await weth.transfer(zeroExMock.address, subjectWethAmount);
          await zeroExMock.setBuyMultiplier(weth.address, ether(2));
        });
        it("should return surplus WETH to user", async () => {
          const wethBalanceBefore = await weth.balanceOf(subjectCaller.address);
          await subject();
          const wethBalanceAfter = await weth.balanceOf(subjectCaller.address);
          const expectedWethBalance = wethBalanceBefore.add(subjectWethAmount);
          expect(wethBalanceAfter).to.equal(expectedWethBalance);
        });
      });

      context("when the input token is weth", async () => {
        beforeEach(async () => {
          subjectInputToken = weth;
          subjectInputTokenAmount = subjectWethAmount;
          await weth.connect(user.wallet).approve(exchangeIssuanceZeroEx.address, subjectInputTokenAmount);
          await weth.transfer(user.address, subjectInputTokenAmount);
        });
        it("should issue correct amount of set tokens", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          await subject();
          const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedSetBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });
        it("should use correct amount of input tokens", async () => {
          const initialBalanceOfInput = await subjectInputToken.balanceOf(subjectCaller.address);
          await subject();
          const finalInputBalance = await subjectInputToken.balanceOf(subjectCaller.address);
          const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
          expect(finalInputBalance).to.eq(expectedInputBalance);
        });
      });

      context("when a position quote is missing", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes = [subjectPositionSwapQuotes[0]];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES");
        });
      });

      context("when invalid set token amount is requested", async () => {
        beforeEach(async () => {
          subjectAmountSetTokenWei = ether(0);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET TOKEN AMOUNT");
        });
      });

      context("when a position quote has the wrong buyTokenAddress", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].buyToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: COMPONENT / QUOTE ADDRESS MISMATCH");
        });
      });

      context("when a position quote has a non-WETH sellToken address", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].sellToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SELL TOKEN");
        });
      });

      context("when the input swap yields insufficient WETH", async () => {
        beforeEach(async () => {
          await zeroExMock.setBuyMultiplier(weth.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("revert");
        });
      });

      context("when a component swap spends too much weth", async () => {
        beforeEach(async () => {
          // Simulate left over weth balance left in contract
          await weth.transfer(exchangeIssuanceZeroEx.address, subjectWethAmount);
          await zeroExMock.setSellMultiplier(weth.address, ether(2));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: OVERSPENT WETH");
        });
      });

      context("when a component swap yields insufficient component token", async () => {
        beforeEach(async () => {
          // Simulating left over component balance left in contract
          await wbtc.transfer(exchangeIssuanceZeroEx.address, wbtcUnits);
          await zeroExMock.setBuyMultiplier(wbtc.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: UNDERBOUGHT COMPONENT");
        });
      });

      context("when a swap call fails", async () => {
        beforeEach(async () => {
          // Trigger revertion in mock by trying to return more buy tokens than available in balance
          await zeroExMock.setBuyMultiplier(wbtc.address, ether(100));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });
      });
    });

    describe("#issueExactSetFromETH", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectAmountETHInput: BigNumber;
      let subjectAmountSetToken: number;
      let subjectAmountSetTokenWei: BigNumber;
      let subjectPositionSwapQuotes: ZeroExSwapQuote[];

      const initializeSubjectVariables = async () => {
        subjectCaller = user;
        subjectSetToken = setToken;
        subjectAmountETHInput = ether(1);
        subjectAmountSetToken = 2;
        subjectAmountSetTokenWei = ether(subjectAmountSetToken);

        const positions = await subjectSetToken.getPositions();
        subjectPositionSwapQuotes = positions.map(position =>
          getUniswapV2Quote(
            weth.address,
            subjectAmountETHInput.div(2),
            position.component,
            position.unit.mul(subjectAmountSetToken),
          ),
        );
      };

      beforeEach(async () => {
        initializeSubjectVariables();
        await exchangeIssuanceZeroEx.approveSetToken(subjectSetToken.address);
        await weth.transfer(subjectCaller.address, subjectAmountETHInput);
        await wbtc.transfer(zeroExMock.address, wbtcUnits.mul(subjectAmountSetToken));
        await dai.transfer(zeroExMock.address, daiUnits.mul(subjectAmountSetToken));
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.connect(subjectCaller.wallet).issueExactSetFromETH(
          subjectSetToken.address,
          subjectAmountSetTokenWei,
          subjectPositionSwapQuotes,
          { value: subjectAmountETHInput, gasPrice: 0 }
        );
      }

      it("should issue the correct amount of Set to the caller", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

        await subject();

        const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectedBalance = initialBalanceOfSet.add(subjectAmountSetTokenWei);
        expect(finalBalanceOfSet).to.eq(expectedBalance);
      });

      it("should use the correct amount of ether from the caller", async () => {
        const initialBalanceOfEth = await subjectCaller.wallet.getBalance();

        await subject();

        const finalEthBalance = await subjectCaller.wallet.getBalance();
        const expectedEthBalance = initialBalanceOfEth.sub(subjectAmountETHInput);
        expect(finalEthBalance).to.eq(expectedEthBalance);
      });

      it("emits an ExchangeIssue log", async () => {
        await expect(subject())
          .to.emit(exchangeIssuanceZeroEx, "ExchangeIssue")
          .withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            ETH_ADDRESS,
            subjectAmountETHInput,
            subjectAmountSetTokenWei,
          );
      });

      context("when exact amount of eth needed is supplied", () => {
        it("should not refund any eth", async () => {
          await expect(subject())
            .to.emit(exchangeIssuanceZeroEx, "Refund")
            .withArgs(subjectCaller.address, BigNumber.from(0));
        });
      });

      context("when not all eth is used up in the transaction", async () => {
        const shareSpent = 0.5;

        beforeEach(async () => {
          await zeroExMock.setSellMultiplier(weth.address, ether(shareSpent));
        });
        it("should return excess eth to the caller", async () => {
          const initialBalanceOfEth = await subjectCaller.wallet.getBalance();
          await subject();
          const finalEthBalance = await subjectCaller.wallet.getBalance();
          const expectedEthBalance = initialBalanceOfEth.sub(
            subjectAmountETHInput.div(1 / shareSpent),
          );
          expect(finalEthBalance).to.eq(expectedEthBalance);
        });
      });

      context("when too much eth is used", async () => {
        beforeEach(async () => {
          await weth.transfer(exchangeIssuanceZeroEx.address, subjectAmountETHInput);
          await zeroExMock.setSellMultiplier(wbtc.address, ether(2));
          await zeroExMock.setSellMultiplier(weth.address, ether(2));
          await zeroExMock.setSellMultiplier(dai.address, ether(2));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: OVERSPENT WETH");
        });
      });

      context("when wrong number of component quotes are used", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes = [];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES");
        });
      });

      context("when input ether amount is 0", async () => {
        beforeEach(async () => {
          subjectAmountETHInput = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID ETH AMOUNT");
        });
      });

      context("when amount Set is 0", async () => {
        beforeEach(async () => {
          subjectAmountSetTokenWei = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET TOKEN AMOUNT");
        });
      });

      context("when input ether amount is insufficient", async () => {
        beforeEach(async () => {
          subjectAmountETHInput = ONE;
          zeroExMock.setBuyMultiplier(weth.address, ether(2));
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("revert");
        });
      });
    });

    describe("#redeemExactSetForToken", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectOutputToken: StandardTokenMock | WETH9;
      let subjectOutputTokenAmount: BigNumber;
      let subjectWethAmount: BigNumber;
      let subjectAmountSetToken: number;
      let subjectAmountSetTokenWei: BigNumber;
      let subjectOutputSwapQuote: ZeroExSwapQuote;
      let subjectPositionSwapQuotes: ZeroExSwapQuote[];

      const initializeSubjectVariables = async () => {
        subjectCaller = user;
        subjectSetToken = setToken;
        subjectOutputTokenAmount = ether(1000);
        subjectOutputToken = usdc;
        subjectWethAmount = ether(1);
        subjectAmountSetToken = 1;
        subjectAmountSetTokenWei = ether(subjectAmountSetToken);
        subjectOutputSwapQuote = getUniswapV2Quote(
          weth.address,
          subjectWethAmount,
          usdc.address,
          subjectOutputTokenAmount,
        );

        const positions = await subjectSetToken.getPositions();
        subjectPositionSwapQuotes = positions.map(position =>
          getUniswapV2Quote(
            position.component,
            position.unit.mul(subjectAmountSetToken),
            weth.address,
            subjectWethAmount.div(2),
          ),
        );
      };

      beforeEach(async () => {
        await initializeSubjectVariables();
        await exchangeIssuanceZeroEx.approveSetToken(subjectSetToken.address);
        await setV2Setup.approveAndIssueSetToken(subjectSetToken, subjectAmountSetTokenWei, subjectCaller.address);
        await setToken.connect(subjectCaller.wallet).approve(exchangeIssuanceZeroEx.address, MAX_UINT_256, { gasPrice: 0 });
        await weth.transfer(zeroExMock.address, subjectWethAmount);
        await usdc.transfer(zeroExMock.address, subjectOutputTokenAmount);
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.connect(subjectCaller.wallet).redeemExactSetForToken(
          subjectSetToken.address,
          subjectOutputToken.address,
          subjectOutputSwapQuote,
          subjectAmountSetTokenWei,
          subjectOutputTokenAmount,
          subjectPositionSwapQuotes,
        );
      }

      it("should redeem the correct number of set tokens", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
        await subject();
        const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectedSetBalance = initialBalanceOfSet.sub(subjectAmountSetTokenWei);
        expect(finalSetBalance).to.eq(expectedSetBalance);
      });

      it("should give the correct number of output tokens", async () => {
        const initialUsdcBalance = await usdc.balanceOf(subjectCaller.address);
        await subject();
        const finalUsdcBalance = await usdc.balanceOf(subjectCaller.address);
        const expectedUsdcBalance = initialUsdcBalance.add(subjectOutputTokenAmount);
        expect(finalUsdcBalance).to.eq(expectedUsdcBalance);
      });

      context("when the output token is weth", async () => {
        beforeEach(async () => {
          subjectOutputToken = weth;
          subjectOutputTokenAmount = subjectWethAmount;
        });
        it("should redeem correct amount of set tokens", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          await subject();
          const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedSetBalance = initialBalanceOfSet.sub(subjectAmountSetTokenWei);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });
        it("should receive correct amount of WETH", async () => {
          const initialBalanceOfOutput = await subjectOutputToken.balanceOf(subjectCaller.address);
          await subject();
          const finalOutputBalance = await subjectOutputToken.balanceOf(subjectCaller.address);
          const expectedOutputbalance = initialBalanceOfOutput.add(subjectOutputTokenAmount);
          expect(finalOutputBalance).to.eq(expectedOutputbalance);
        });
      });

      context("when invalid set token amount is requested", async () => {
        beforeEach(async () => {
          subjectAmountSetTokenWei = ether(0);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET TOKEN AMOUNT");
        });
      });

      context("when a position quote is missing", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes = [subjectPositionSwapQuotes[0]];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES");
        });
      });

      context("when a position quote has the wrong sellTokenAddress", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].sellToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: COMPONENT / QUOTE ADDRESS MISMATCH");
        });
      });

      context("when a position quote has a non-WETH buyToken address", async () => {
        beforeEach(async () => {
          subjectPositionSwapQuotes[0].buyToken = await getRandomAddress();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID BUY TOKEN");
        });
      });

      context("when the input swap yields insufficient WETH", async () => {
        beforeEach(async () => {
          await zeroExMock.setBuyMultiplier(weth.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("revert");
        });
      });

      context("when the output swap yields insufficient USDC", async () => {
        beforeEach(async () => {
          await zeroExMock.setBuyMultiplier(usdc.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT",
          );
        });
      });

      context("when the output token and output swap are mismatched", async () => {
        beforeEach(async () => {
          subjectOutputToken = dai;
          subjectOutputSwapQuote = getUniswapV2Quote(
            weth.address,
            subjectWethAmount,
            usdc.address,
            subjectOutputTokenAmount,
          );
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: OUTPUT TOKEN / OUTPUT QUOTE MISMATCH");
        });
      });

      context("when a swap call fails", async () => {
        beforeEach(async () => {
          // Trigger revertion in mock by trying to return more buy weth than available in balance
          await zeroExMock.setBuyMultiplier(weth.address, ether(100));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("revert");
        });
      });
    });
    describe("#redeemExactSetForEth", async () => {
      let subjectWethAmount: BigNumber;
      let subjectAmountSetToken: number;
      let subjectAmountSetTokenWei: BigNumber;
      let subjectPositionSwapQuotes: ZeroExSwapQuote[];

      const initializeSubjectVariables = async () => {
        subjectWethAmount = ether(1);
        subjectAmountSetToken = 1;
        subjectAmountSetTokenWei = ether(subjectAmountSetToken);

        const positions = await setToken.getPositions();
        subjectPositionSwapQuotes = positions.map((position: any) =>
          getUniswapV2Quote(
            position.component,
            position.unit.mul(subjectAmountSetToken),
            weth.address,
            subjectWethAmount.div(2),
          ),
        );
      };

      beforeEach(async () => {
        await initializeSubjectVariables();
        await exchangeIssuanceZeroEx.approveSetToken(setToken.address);
        await setV2Setup.approveAndIssueSetToken(setToken, subjectAmountSetTokenWei, owner.address);
        await setToken.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256, { gasPrice: 0 });
        await weth.transfer(zeroExMock.address, subjectWethAmount);
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuanceZeroEx.redeemExactSetForETH(
          setToken.address,
          subjectAmountSetTokenWei,
          subjectWethAmount,
          subjectPositionSwapQuotes,
        );
      }

      it("should redeem the correct number of set tokens", async () => {
        const initialBalanceOfSet = await setToken.balanceOf(owner.address);
        await subject();
        const finalSetBalance = await setToken.balanceOf(owner.address);
        const expectedSetBalance = initialBalanceOfSet.sub(subjectAmountSetTokenWei);
        expect(finalSetBalance).to.eq(expectedSetBalance);
      });

      it("should disperse the correct amount of eth", async () => {
        const initialEthBalance = await owner.wallet.getBalance();

        const tx = await subject();
        const gasPrice = tx.gasPrice;
        const receipt = await tx.wait();
        const gasUsed = receipt.cumulativeGasUsed;
        const transactionFee = gasPrice.mul(gasUsed);

        const finalEthBalance = await owner.wallet.getBalance();
        const expectedEthBalance = initialEthBalance.add(subjectWethAmount).sub(transactionFee);
        expect(finalEthBalance).to.eq(expectedEthBalance);
      });

      context("when the swaps yield insufficient weth", async () => {
        beforeEach(async () => {
          await zeroExMock.setBuyMultiplier(weth.address, ether(0.5));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ExchangeIssuance: INSUFFICIENT WETH RECEIVED",
          );
        });
      });

      context("when the swaps yields excess weth", async () => {
        const wethMultiplier = 2;
        beforeEach(async () => {
          await zeroExMock.setBuyMultiplier(weth.address, ether(wethMultiplier));
          await weth.transfer(zeroExMock.address, subjectWethAmount.mul(wethMultiplier - 1));
        });

        it("should disperse the correct amount of eth", async () => {
          const initialEthBalance = await owner.wallet.getBalance();

          const tx = await subject();
          const gasPrice = tx.gasPrice;
          const receipt = await tx.wait();
          const gasUsed = receipt.cumulativeGasUsed;
          const transactionFee = gasPrice.mul(gasUsed);

          const finalEthBalance = await owner.wallet.getBalance();
          const expectedEthBalance = initialEthBalance
            .add(subjectWethAmount.mul(wethMultiplier))
            .sub(transactionFee);
          expect(finalEthBalance).to.eq(expectedEthBalance);
        });
      });

      context("when the swap consumes an excessive amount of component token", async () => {
        const wbtcMultiplier = 2;
        beforeEach(async () => {
          await zeroExMock.setSellMultiplier(wbtc.address, ether(wbtcMultiplier));
          await wbtc.transfer(exchangeIssuanceZeroEx.address, wbtcUnits.mul(wbtcMultiplier - 1));
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ExchangeIssuance: OVERSOLD COMPONENT",
          );
        });
      });

    });
  });
});