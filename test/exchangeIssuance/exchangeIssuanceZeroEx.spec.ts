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
import { getTxFee } from "@utils/test";

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

  let usdcUnits: BigNumber;
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

    usdcUnits = UnitsUtils.usdc(1.234567);
    wbtcUnits = UnitsUtils.wbtc(1.2345678);

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.usdc.address, setV2Setup.wbtc.address],
      [usdcUnits, wbtcUnits],
      [
        setV2Setup.debtIssuanceModule.address,
        setV2Setup.issuanceModule.address,
        setV2Setup.streamingFeeModule.address,
      ],
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(1),
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO,
    );
  });

  describe("#constructor", async () => {
    let subjectWethAddress: Address;
    let subjectControllerAddress: Address;
    let subjectIssuanceModuleAddresses: Address[];
    let subjectIssuanceModuleDebtModuleFlags: boolean[];
    let subjectSwapTarget: Address;

    cacheBeforeEach(async () => {
      subjectWethAddress = weth.address;
      subjectControllerAddress = setV2Setup.controller.address;
      subjectSwapTarget = zeroExMock.address;
      subjectIssuanceModuleAddresses = [
        setV2Setup.issuanceModule.address,
        setV2Setup.debtIssuanceModule.address,
      ];
      subjectIssuanceModuleDebtModuleFlags = [false, true];
    });

    async function subject(): Promise<ExchangeIssuanceZeroEx> {
      return await deployer.extensions.deployExchangeIssuanceZeroEx(
        subjectWethAddress,
        subjectControllerAddress,
        subjectIssuanceModuleAddresses,
        subjectIssuanceModuleDebtModuleFlags,
        subjectSwapTarget,
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceZeroEx = await subject();

      const expectedWethAddress = await exchangeIssuanceContract.WETH();
      expect(expectedWethAddress).to.eq(subjectWethAddress);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(subjectControllerAddress);

      const returnedBasicIssuanceModuleData = await exchangeIssuanceContract.allowedIssuanceModules(
        setV2Setup.issuanceModule.address,
      );
      expect(returnedBasicIssuanceModuleData[0]).to.eq(true);
      expect(returnedBasicIssuanceModuleData[1]).to.eq(false);

      const returnedDebtIssuanceModuleData = await exchangeIssuanceContract.allowedIssuanceModules(
        setV2Setup.debtIssuanceModule.address,
      );
      expect(returnedDebtIssuanceModuleData[0]).to.eq(true);
      expect(returnedDebtIssuanceModuleData[1]).to.eq(true);

      const swapTarget = await exchangeIssuanceContract.swapTarget();
      expect(swapTarget).to.eq(subjectSwapTarget);
    });
  });

  context("when exchange issuance is deployed", async () => {
    let wethAddress: Address;
    let controllerAddress: Address;
    let exchangeIssuanceZeroEx: ExchangeIssuanceZeroEx;
    let setTokenExternal: SetToken;

    cacheBeforeEach(async () => {
      setTokenExternal = await setV2Setup.createSetToken(
        [setV2Setup.dai.address],
        [ether(0.5)],
        [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.issuanceModule.initialize(setTokenExternal.address, ADDRESS_ZERO);

      const controller = setV2Setup.controller;
      await controller.addModule(externalPositionModule.address);
      await setTokenExternal.addModule(externalPositionModule.address);
      await setTokenExternal.connect(externalPositionModule.wallet).initializeModule();

      await setTokenExternal
        .connect(externalPositionModule.wallet)
        .addExternalPositionModule(dai.address, externalPositionModule.address);

      wethAddress = weth.address;
      controllerAddress = setV2Setup.controller.address;

      const issuanceModuleAddresses = [
        setV2Setup.issuanceModule.address,
        setV2Setup.debtIssuanceModule.address,
      ];
      const issuanceModuleDebtModuleFlags = [false, true];

      exchangeIssuanceZeroEx = await deployer.extensions.deployExchangeIssuanceZeroEx(
        wethAddress,
        controllerAddress,
        issuanceModuleAddresses,
        issuanceModuleDebtModuleFlags,
        zeroExMock.address,
      );
    });

    ["basicIssuanceModule", "debtIssuanceModule"].forEach((issuanceModuleName: string) => {
      context(`when issuance module is ${issuanceModuleName}`, () => {
        let issuanceModuleAddress: Address;
        let issuanceModule: any;
        before(() => {
          issuanceModule =
            issuanceModuleName === "basicIssuanceModule"
              ? setV2Setup.issuanceModule
              : setV2Setup.debtIssuanceModule;

          issuanceModuleAddress = issuanceModule.address;
        });

        describe("#approveSetToken", async () => {
          let subjectSetToApprove: SetToken | StandardTokenMock;

          beforeEach(async () => {
            subjectSetToApprove = setToken;
          });

          async function subject(): Promise<ContractTransaction> {
            return await exchangeIssuanceZeroEx.approveSetToken(
              subjectSetToApprove.address,
              issuanceModuleAddress,
            );
          }

          it("should update the approvals correctly", async () => {
            const tokens = [dai, dai];
            const spenders = [issuanceModuleAddress];

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
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED",
              );
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
            return subjectCaller.wallet.call({
              to: exchangeIssuanceZeroEx.address,
              value: subjectAmount,
            });
          }

          it("should revert when receiving ether not from the WETH contract", async () => {
            await expect(subject()).to.be.revertedWith(
              "ExchangeIssuance: Direct deposits not allowed",
            );
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
          let subjectTokensToApprove: (StandardTokenMock | WETH9)[];
          let subjectSpender: Address;

          beforeEach(async () => {
            subjectTokensToApprove = [setV2Setup.weth, setV2Setup.wbtc];
            subjectSpender = issuanceModuleAddress;
          });

          async function subject() {
            return await exchangeIssuanceZeroEx.approveTokens(
              subjectTokensToApprove.map(token => token.address),
              subjectSpender,
            );
          }

          it("should update the approvals correctly", async () => {
            const spenders = [zeroExMock.address, issuanceModuleAddress];

            await subject();

            const finalAllowances = await getAllowances(
              subjectTokensToApprove,
              exchangeIssuanceZeroEx.address,
              spenders,
            );

            for (let i = 0; i < finalAllowances.length; i++) {
              const actualAllowance = finalAllowances[i];
              const expectedAllowance = MAX_UINT_96;
              expect(actualAllowance).to.eq(expectedAllowance);
            }
          });

          context("when the tokens are approved twice", async () => {
            it("should update the approvals correctly", async () => {
              const spenders = [zeroExMock.address, issuanceModuleAddress];

              const tx = await subject();
              await tx.wait();
              await subject();

              const finalAllowances = await getAllowances(
                subjectTokensToApprove,
                exchangeIssuanceZeroEx.address,
                spenders,
              );

              for (let i = 0; i < finalAllowances.length; i++) {
                const actualAllowance = finalAllowances[i];
                const expectedAllowance = MAX_UINT_96;
                expect(actualAllowance).to.eq(expectedAllowance);
              }
            });
          });

          context("when the spender address is not a whitelisted issuance module", async () => {
            beforeEach(() => {
              subjectSpender = user.address;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INVALID ISSUANCE MODULE",
              );
            });
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
          let subjectAmountSetToken: number;
          let subjectAmountSetTokenWei: BigNumber;
          let subjectPositionSwapQuotes: ZeroExSwapQuote[];
          let subjectIssuanceModuleAddress: Address;
          let components: Address[];
          let positions: BigNumber[];

          const initializeSubjectVariables = async () => {
            subjectCaller = user;
            subjectSetToken = setToken;
            subjectInputTokenAmount = ether(1000);
            subjectInputToken = dai;
            subjectAmountSetToken = 1.123456789123456;
            subjectAmountSetTokenWei = UnitsUtils.ether(subjectAmountSetToken);
            subjectIssuanceModuleAddress = issuanceModuleAddress;

            [
              components,
              positions,
            ] = await exchangeIssuanceZeroEx.getRequiredIssuanceComponents(
              issuanceModuleAddress,
              subjectSetToken.address,
              subjectAmountSetTokenWei,
            );
            subjectPositionSwapQuotes = positions.map((position: any, index: number) => {
              return getUniswapV2Quote(
                subjectInputToken.address,
                subjectInputTokenAmount.div(2),
                components[index],
                position,
              );
            });
          };

          beforeEach(async () => {
            initializeSubjectVariables();
            await exchangeIssuanceZeroEx.approveSetToken(
              subjectSetToken.address,
              subjectIssuanceModuleAddress,
            );
            dai.connect(subjectCaller.wallet).approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
            await dai.transfer(subjectCaller.address, subjectInputTokenAmount);

            positions.forEach(async (position: any, index: number) => {
              const component = components[index];
              await usdc.attach(component).transfer(zeroExMock.address, position);
            });
          });

          async function subject(): Promise<ContractTransaction> {
            return await exchangeIssuanceZeroEx
              .connect(subjectCaller.wallet)
              .issueExactSetFromToken(
                subjectSetToken.address,
                subjectInputToken.address,
                subjectAmountSetTokenWei,
                subjectInputTokenAmount,
                subjectPositionSwapQuotes,
                subjectIssuanceModuleAddress,
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

          context("when the input swap does not use all of the input token amount", async () => {
            const sellMultiplier = 0.5;
            beforeEach(async () => {
              await zeroExMock.setSellMultiplier(subjectInputToken.address, ether(sellMultiplier));
            });
            it("should return surplus input token to user", async () => {
              const inputTokenBalanceBefore = await subjectInputToken.balanceOf(
                subjectCaller.address,
              );
              await subject();
              const inputTokenBalanceAfter = await subjectInputToken.balanceOf(
                subjectCaller.address,
              );
              const expectedInputTokenBalance = inputTokenBalanceBefore.sub(
                subjectInputTokenAmount.div(1 / sellMultiplier),
              );
              expect(inputTokenBalanceAfter).to.equal(expectedInputTokenBalance);
            });
          });

          context("when the input token is weth", async () => {
            beforeEach(async () => {
              subjectInputToken = weth;
              subjectInputTokenAmount = UnitsUtils.ether(2);
              subjectPositionSwapQuotes = positions.map((position: any, index: number) => {
                return getUniswapV2Quote(
                  subjectInputToken.address,
                  subjectInputTokenAmount.div(2),
                  components[index],
                  position,
                );
              });
              await weth
                .connect(user.wallet)
                .approve(exchangeIssuanceZeroEx.address, subjectInputTokenAmount);
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
              const initialBalanceOfInput = await subjectInputToken.balanceOf(
                subjectCaller.address,
              );
              await subject();
              const finalInputBalance = await subjectInputToken.balanceOf(subjectCaller.address);
              const expectedInputBalance = initialBalanceOfInput.sub(subjectInputTokenAmount);
              expect(finalInputBalance).to.eq(expectedInputBalance);
            });
          });

          context("when an invalid issuance module address is provided", async () => {
            beforeEach(async () => {
              subjectIssuanceModuleAddress = subjectCaller.address;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INVALID ISSUANCE MODULE",
              );
            });
          });

          context("when a position quote is missing", async () => {
            beforeEach(async () => {
              subjectPositionSwapQuotes = [subjectPositionSwapQuotes[0]];
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES",
              );
            });
          });

          context("when invalid set token amount is requested", async () => {
            beforeEach(async () => {
              subjectAmountSetTokenWei = ether(0);
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INVALID SET TOKEN AMOUNT",
              );
            });
          });

          context("when a position quote has the wrong buyTokenAddress", async () => {
            beforeEach(async () => {
              subjectPositionSwapQuotes[0].buyToken = await getRandomAddress();
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: COMPONENT / QUOTE ADDRESS MISMATCH",
              );
            });
          });

          context("when a component swap spends too much input token", async () => {
            beforeEach(async () => {
              // Simulate left over weth balance left in contract
              await subjectInputToken.transfer(
                exchangeIssuanceZeroEx.address,
                subjectInputTokenAmount,
              );
              await zeroExMock.setSellMultiplier(subjectInputToken.address, ether(2));
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("ExchangeIssuance: OVERSPENT TOKEN");
            });
          });

          context("When the zero ex router call fails with normal revert errror", async () => {
            beforeEach(async () => {
              await zeroExMock.setErrorMapping(subjectInputToken.address, 1);
            });
            it("should forward revert reason correctly", async () => {
              const errorMessage = await zeroExMock.testRevertMessage();
              await expect(subject()).to.be.revertedWith(errorMessage);
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
          let components: Address[];
          let positions: BigNumber[];

          const initializeSubjectVariables = async () => {
            subjectCaller = user;
            subjectSetToken = setToken;
            subjectAmountETHInput = ether(4);
            subjectAmountSetToken = 1.23456789;
            subjectAmountSetTokenWei = UnitsUtils.ether(subjectAmountSetToken);

            [
              components,
              positions,
            ] = await exchangeIssuanceZeroEx.callStatic.getRequiredIssuanceComponents(
              issuanceModuleAddress,
              subjectSetToken.address,
              subjectAmountSetTokenWei,
            );
            subjectPositionSwapQuotes = positions.map((position: any, index: number) => {
              return getUniswapV2Quote(
                weth.address,
                subjectAmountETHInput.div(2),
                components[index],
                position,
              );
            });
          };

          beforeEach(async () => {
            initializeSubjectVariables();
            await exchangeIssuanceZeroEx.approveSetToken(
              subjectSetToken.address,
              issuanceModuleAddress,
            );
            await weth.transfer(subjectCaller.address, subjectAmountETHInput);
            positions.forEach(async (position: any, index: number) => {
              const component = components[index];
              await usdc.attach(component).transfer(zeroExMock.address, position);
            });
          });

          async function subject(): Promise<ContractTransaction> {
            return await exchangeIssuanceZeroEx
              .connect(subjectCaller.wallet)
              .issueExactSetFromETH(
                subjectSetToken.address,
                subjectAmountSetTokenWei,
                subjectPositionSwapQuotes,
                issuanceModuleAddress,
                { value: subjectAmountETHInput },
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

            const tx = await subject();
            const transactionFee = await getTxFee(tx);

            const finalEthBalance = await subjectCaller.wallet.getBalance();
            const expectedEthBalance = initialBalanceOfEth
              .sub(subjectAmountETHInput)
              .sub(transactionFee);
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
              const tx = await subject();
              const transactionFee = await getTxFee(tx);
              const finalEthBalance = await subjectCaller.wallet.getBalance();
              const expectedEthBalance = initialBalanceOfEth
                .sub(subjectAmountETHInput.div(1 / shareSpent))
                .sub(transactionFee);
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
              await expect(subject()).to.be.revertedWith("ExchangeIssuance: OVERSPENT ETH");
            });
          });

          context("when wrong number of component quotes are used", async () => {
            beforeEach(async () => {
              subjectPositionSwapQuotes = [];
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES",
              );
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
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INVALID SET TOKEN AMOUNT",
              );
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
          let subjectAmountSetToken: number;
          let subjectAmountSetTokenWei: BigNumber;
          let subjectPositionSwapQuotes: ZeroExSwapQuote[];
          let subjectIssuanceModuleAddress: Address;
          let components: Address[];
          let positions: BigNumber[];

          const initializeSubjectVariables = async () => {
            subjectCaller = user;
            subjectSetToken = setToken;
            subjectOutputTokenAmount = ether(1000);
            subjectOutputToken = dai;
            subjectAmountSetToken = 1.234567891234;
            subjectAmountSetTokenWei = UnitsUtils.ether(subjectAmountSetToken);
            subjectIssuanceModuleAddress = issuanceModuleAddress;

            [
              components,
              positions,
            ] = await exchangeIssuanceZeroEx.getRequiredRedemptionComponents(
              issuanceModuleAddress,
              subjectSetToken.address,
              subjectAmountSetTokenWei,
            );
            subjectPositionSwapQuotes = positions.map((position: any, index: number) => {
              return getUniswapV2Quote(
                components[index],
                position,
                subjectOutputToken.address,
                subjectOutputTokenAmount.div(2),
              );
            });
          };

          beforeEach(async () => {
            await initializeSubjectVariables();
            await exchangeIssuanceZeroEx.approveSetToken(
              subjectSetToken.address,
              subjectIssuanceModuleAddress,
            );
            await setV2Setup.approveAndIssueSetToken(
              subjectSetToken,
              subjectAmountSetTokenWei,
              subjectCaller.address,
            );
            await setToken
              .connect(subjectCaller.wallet)
              .approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
            await dai.transfer(zeroExMock.address, subjectOutputTokenAmount);
          });

          async function subject(): Promise<ContractTransaction> {
            return await exchangeIssuanceZeroEx
              .connect(subjectCaller.wallet)
              .redeemExactSetForToken(
                subjectSetToken.address,
                subjectOutputToken.address,
                subjectAmountSetTokenWei,
                subjectOutputTokenAmount,
                subjectPositionSwapQuotes,
                subjectIssuanceModuleAddress,
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
            const initialDaiBalance = await dai.balanceOf(subjectCaller.address);
            await subject();
            const finalDaiBalance = await dai.balanceOf(subjectCaller.address);
            const expectedDaiBalance = initialDaiBalance.add(subjectOutputTokenAmount);
            expect(finalDaiBalance).to.eq(expectedDaiBalance);
          });

          context("when invalid set token amount is requested", async () => {
            beforeEach(async () => {
              subjectAmountSetTokenWei = ether(0);
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INVALID SET TOKEN AMOUNT",
              );
            });
          });

          context("when an invalid issuance module address is provided", async () => {
            beforeEach(async () => {
              subjectIssuanceModuleAddress = subjectCaller.address;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INVALID ISSUANCE MODULE",
              );
            });
          });

          context("when a position quote is missing", async () => {
            beforeEach(async () => {
              subjectPositionSwapQuotes = [subjectPositionSwapQuotes[0]];
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES",
              );
            });
          });

          context("when a position quote has the wrong sellTokenAddress", async () => {
            beforeEach(async () => {
              subjectPositionSwapQuotes[0].sellToken = await getRandomAddress();
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: COMPONENT / QUOTE ADDRESS MISMATCH",
              );
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

          context("when the output swap yields insufficient DAI", async () => {
            beforeEach(async () => {
              await zeroExMock.setBuyMultiplier(dai.address, ether(0.5));
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith(
                "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT",
              );
            });
          });

          context("when a swap call fails", async () => {
            beforeEach(async () => {
              // Trigger revertion in mock by trying to return more output token than available in balance
              await zeroExMock.setBuyMultiplier(subjectOutputToken.address, ether(100));
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
          let subjectSetToken: SetToken;
          let components: Address[];
          let positions: BigNumber[];

          const initializeSubjectVariables = async () => {
            subjectWethAmount = ether(1);
            subjectAmountSetToken = 1.234567891234;
            subjectAmountSetTokenWei = UnitsUtils.ether(subjectAmountSetToken);
            subjectSetToken = setToken;

            [
              components,
              positions,
            ] = await exchangeIssuanceZeroEx.callStatic.getRequiredRedemptionComponents(
              issuanceModuleAddress,
              subjectSetToken.address,
              subjectAmountSetTokenWei,
            );

            subjectPositionSwapQuotes = positions.map((position: any, index: number) => {
              return getUniswapV2Quote(
                components[index],
                position,
                weth.address,
                subjectWethAmount.div(2),
              );
            });
          };

          beforeEach(async () => {
            await initializeSubjectVariables();
            await exchangeIssuanceZeroEx.approveSetToken(setToken.address, issuanceModuleAddress);
            await setV2Setup.approveAndIssueSetToken(
              setToken,
              subjectAmountSetTokenWei,
              owner.address,
            );
            await setToken.approve(exchangeIssuanceZeroEx.address, MAX_UINT_256);
            await weth.transfer(zeroExMock.address, subjectWethAmount);
          });

          async function subject(): Promise<ContractTransaction> {
            return await exchangeIssuanceZeroEx.redeemExactSetForETH(
              setToken.address,
              subjectAmountSetTokenWei,
              subjectWethAmount,
              subjectPositionSwapQuotes,
              issuanceModuleAddress,
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

            const transactionFee = await getTxFee(tx);

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
            const multiplier = 2;
            beforeEach(async () => {
              const componentAddress = components[1];
              const position = positions[1];
              await zeroExMock.setSellMultiplier(componentAddress, ether(multiplier));
              await wbtc.transfer(
                exchangeIssuanceZeroEx.address,
                position.mul(multiplier - 1),
              );
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("ExchangeIssuance: OVERSOLD COMPONENT");
            });
          });
        });
      });
    });
  });
});
