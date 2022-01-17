import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, MAX_UINT_256, MAX_UINT_96, MAX_INT_256 } from "@utils/constants";
import { ExchangeIssuanceLeveraged, StandardTokenMock, WETH9 } from "@utils/contracts/index";
import { UniswapV2Factory, UniswapV2Router02 } from "@utils/contracts/uniswap";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAaveV2Fixture,
  getAccounts,
  getLastBlockTimestamp,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { UniswapFixture } from "@utils/fixtures";
import { AaveV2Fixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import {
  getAllowances,
  getIssueSetForExactToken,
} from "@utils/common/exchangeIssuanceUtils";

const expect = getWaffleExpect();

describe("ExchangeIssuanceLeveraged", async () => {
  let owner: Account;
  let user: Account;
  let externalPositionModule: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setTokenWithWeth: SetToken;

  let exchangeIssuance: ExchangeIssuanceLeveraged;

  cacheBeforeEach(async () => {
    [owner, user, externalPositionModule] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    const daiUnits = BigNumber.from("23252699054621733");
    const wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.debtIssuanceModule.initialize(
      setToken.address,
      ether(0.1),
      ether(0),
      ether(0),
      owner.address,
      ADDRESS_ZERO,
    );

    const wethUnits = ether(0.5);
    setTokenWithWeth = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.weth.address],
      [daiUnits, wethUnits],
      [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.debtIssuanceModule.initialize(
      setTokenWithWeth.address,
      ether(0.1),
      ether(0),
      ether(0),
      owner.address,
      ADDRESS_ZERO,
    );
  });

  describe("#constructor", async () => {
    let wethAddress: Address;
    let uniswapFactory: UniswapV2Factory;
    let uniswapRouter: UniswapV2Router02;
    let sushiswapFactory: UniswapV2Factory;
    let sushiswapRouter: UniswapV2Router02;
    let controllerAddress: Address;
    let debtIssuanceModuleAddress: Address;
    let addressProviderAddress: Address;

    cacheBeforeEach(async () => {
      let uniswapSetup: UniswapFixture;
      let sushiswapSetup: UniswapFixture;
      let aaveV2Setup: AaveV2Fixture;
      let wbtcAddress: Address;
      let daiAddress: Address;

      wethAddress = setV2Setup.weth.address;
      wbtcAddress = setV2Setup.wbtc.address;
      daiAddress = setV2Setup.dai.address;

      uniswapSetup = getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

      aaveV2Setup = getAaveV2Fixture(owner.address);
      await aaveV2Setup.initialize(wethAddress, daiAddress);

      sushiswapSetup = getUniswapFixture(owner.address);
      await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

      uniswapFactory = uniswapSetup.factory;
      uniswapRouter = uniswapSetup.router;
      sushiswapFactory = sushiswapSetup.factory;
      sushiswapRouter = sushiswapSetup.router;
      controllerAddress = setV2Setup.controller.address;
      debtIssuanceModuleAddress = setV2Setup.debtIssuanceModule.address;
      addressProviderAddress = aaveV2Setup.lendingPoolAddressesProvider.address;
    });

    async function subject(): Promise<ExchangeIssuanceLeveraged> {
      return await deployer.extensions.deployExchangeIssuanceLeveraged(
        wethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        addressProviderAddress,
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceLeveraged = await subject();

      const expectedWethAddress = await exchangeIssuanceContract.WETH();
      expect(expectedWethAddress).to.eq(wethAddress);

      const expectedUniRouterAddress = await exchangeIssuanceContract.uniRouter();
      expect(expectedUniRouterAddress).to.eq(uniswapRouter.address);

      const expectedUniFactoryAddress = await exchangeIssuanceContract.uniFactory();
      expect(expectedUniFactoryAddress).to.eq(uniswapFactory.address);

      const expectedSushiRouterAddress = await exchangeIssuanceContract.sushiRouter();
      expect(expectedSushiRouterAddress).to.eq(sushiswapRouter.address);

      const expectedSushiFactoryAddress = await exchangeIssuanceContract.sushiFactory();
      expect(expectedSushiFactoryAddress).to.eq(sushiswapFactory.address);

      const expectedControllerAddress = await exchangeIssuanceContract.setController();
      expect(expectedControllerAddress).to.eq(controllerAddress);

      const expectedDebtIssuanceModuleAddress = await exchangeIssuanceContract.debtIssuanceModule();
      expect(expectedDebtIssuanceModuleAddress).to.eq(debtIssuanceModuleAddress);
    });

    it("approves WETH to the uniswap and sushiswap router", async () => {
      const exchangeIssuance: ExchangeIssuanceLeveraged = await subject();

      // validate the allowance of WETH between uniswap, sushiswap, and the deployed exchange issuance contract
      const uniswapWethAllowance = await setV2Setup.weth.allowance(
        exchangeIssuance.address,
        uniswapRouter.address,
      );
      expect(uniswapWethAllowance).to.eq(MAX_UINT_256);

      const sushiswapWethAllownace = await setV2Setup.weth.allowance(
        exchangeIssuance.address,
        sushiswapRouter.address,
      );
      expect(sushiswapWethAllownace).to.eq(MAX_UINT_256);
    });
  });

  context("when exchange issuance is deployed", async () => {
    let subjectWethAddress: Address;
    let uniswapFactory: UniswapV2Factory;
    let uniswapRouter: UniswapV2Router02;
    let sushiswapFactory: UniswapV2Factory;
    let sushiswapRouter: UniswapV2Router02;
    let controllerAddress: Address;
    let debtIssuanceModuleAddress: Address;
    let addressProviderAddress: Address;

    let weth: WETH9;
    let wbtc: StandardTokenMock;
    let dai: StandardTokenMock;
    let usdc: StandardTokenMock;
    let illiquidToken: StandardTokenMock;
    let setTokenIlliquid: SetToken;
    let setTokenExternal: SetToken;
    let aaveV2Setup: AaveV2Fixture;

    cacheBeforeEach(async () => {
      let uniswapSetup: UniswapFixture;
      let sushiswapSetup: UniswapFixture;

      weth = setV2Setup.weth;
      wbtc = setV2Setup.wbtc;
      dai = setV2Setup.dai;
      usdc = setV2Setup.usdc;
      illiquidToken = await deployer.setV2.deployTokenMock(
        owner.address,
        ether(1000000),
        18,
        "illiquid token",
        "RUGGED",
      );

      usdc.transfer(user.address, UnitsUtils.usdc(10000));
      weth.transfer(user.address, UnitsUtils.ether(1000));

      const daiUnits = ether(0.5);
      const illiquidTokenUnits = ether(0.5);
      setTokenIlliquid = await setV2Setup.createSetToken(
        [setV2Setup.dai.address, illiquidToken.address],
        [daiUnits, illiquidTokenUnits],
        [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.debtIssuanceModule.initialize(
        setTokenIlliquid.address,
        ether(0.1),
        ether(0),
        ether(0),
        owner.address,
        ADDRESS_ZERO,
      );

      setTokenExternal = await setV2Setup.createSetToken(
        [setV2Setup.dai.address],
        [ether(0.5)],
        [setV2Setup.debtIssuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.debtIssuanceModule.initialize(
        setTokenExternal.address,
        ether(0.1),
        ether(0),
        ether(0),
        owner.address,
        ADDRESS_ZERO,
      );

      const controller = setV2Setup.controller;
      await controller.addModule(externalPositionModule.address);
      await setTokenExternal.addModule(externalPositionModule.address);
      await setTokenExternal.connect(externalPositionModule.wallet).initializeModule();

      await setTokenExternal
        .connect(externalPositionModule.wallet)
        .addExternalPositionModule(dai.address, externalPositionModule.address);

      uniswapSetup = await getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, weth.address, wbtc.address, dai.address);
      sushiswapSetup = await getUniswapFixture(owner.address);
      await sushiswapSetup.initialize(owner, weth.address, wbtc.address, dai.address);

      aaveV2Setup = getAaveV2Fixture(owner.address);
      await aaveV2Setup.initialize(weth.address, dai.address);

      subjectWethAddress = weth.address;
      uniswapFactory = uniswapSetup.factory;
      uniswapRouter = uniswapSetup.router;
      sushiswapFactory = sushiswapSetup.factory;
      sushiswapRouter = sushiswapSetup.router;
      controllerAddress = setV2Setup.controller.address;
      debtIssuanceModuleAddress = setV2Setup.debtIssuanceModule.address;
      addressProviderAddress = aaveV2Setup.lendingPoolAddressesProvider.address;

      await sushiswapSetup.createNewPair(weth.address, wbtc.address);
      await uniswapSetup.createNewPair(weth.address, dai.address);
      await uniswapSetup.createNewPair(weth.address, usdc.address);

      // ETH-WBTC pools
      await wbtc.approve(uniswapRouter.address, MAX_UINT_256);
      await uniswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          wbtc.address,
          UnitsUtils.wbtc(100000),
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(100), gasLimit: 9000000 },
        );

      // cheaper wbtc compared to uniswap
      await wbtc.approve(sushiswapRouter.address, MAX_UINT_256);
      await sushiswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          wbtc.address,
          UnitsUtils.wbtc(200000),
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(100), gasLimit: 9000000 },
        );

      // ETH-DAI pools
      await dai.approve(uniswapRouter.address, MAX_INT_256);
      await uniswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          dai.address,
          ether(100000),
          MAX_UINT_256,
          MAX_UINT_256,
          owner.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(10), gasLimit: 9000000 },
        );

      // ETH-USDC pools
      await usdc.connect(owner.wallet).approve(uniswapRouter.address, MAX_INT_256);
      await uniswapRouter
        .connect(owner.wallet)
        .addLiquidityETH(
          usdc.address,
          UnitsUtils.usdc(100000),
          MAX_UINT_256,
          MAX_UINT_256,
          user.address,
          (await getLastBlockTimestamp()).add(1),
          { value: ether(100), gasLimit: 9000000 },
        );

      exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
        subjectWethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        debtIssuanceModuleAddress,
        addressProviderAddress,
      );
    });

    describe("#approveToken", async () => {
      let subjectTokenToApprove: StandardTokenMock;

      beforeEach(async () => {
        subjectTokenToApprove = setV2Setup.dai;
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approveToken(subjectTokenToApprove.address);
      }

      it("should update the approvals correctly", async () => {
        const spenders = [
          uniswapRouter.address,
          sushiswapRouter.address,
          debtIssuanceModuleAddress,
        ];
        const tokens = [subjectTokenToApprove];

        await subject();

        const finalAllowances = await getAllowances(tokens, exchangeIssuance.address, spenders);

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });
    });

    describe("#approveTokens", async () => {
      let subjectTokensToApprove: StandardTokenMock[];

      beforeEach(async () => {
        subjectTokensToApprove = [setV2Setup.dai, setV2Setup.wbtc];
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approveTokens(
          subjectTokensToApprove.map(token => token.address),
        );
      }

      it("should update the approvals correctly", async () => {
        const spenders = [
          uniswapRouter.address,
          sushiswapRouter.address,
          debtIssuanceModuleAddress,
        ];

        await subject();

        const finalAllowances = await getAllowances(
          subjectTokensToApprove,
          exchangeIssuance.address,
          spenders,
        );

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });
    });

    describe("#approveSetToken", async () => {
      let subjectSetToApprove: SetToken | StandardTokenMock;

      beforeEach(async () => {
        subjectSetToApprove = setToken;
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approveSetToken(subjectSetToApprove.address);
      }

      it("should update the approvals correctly", async () => {
        const tokens = [dai, wbtc];
        const spenders = [
          uniswapRouter.address,
          sushiswapRouter.address,
          debtIssuanceModuleAddress,
        ];

        await subject();

        const finalAllowances = await getAllowances(tokens, exchangeIssuance.address, spenders);

        for (let i = 0; i < finalAllowances.length; i++) {
          const actualAllowance = finalAllowances[i];
          const expectedAllowance = MAX_UINT_96;
          expect(actualAllowance).to.eq(expectedAllowance);
        }
      });

      context("when the input token is not a set", async () => {
        beforeEach(async () => {
          subjectSetToApprove = usdc;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID SET");
        });
      });

      context("when the set contains an external position", async () => {
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

    describe("#issueSetForExactToken", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectInputToken: StandardTokenMock | WETH9;
      let subjectAmountInput: BigNumber;
      let subjectMinSetReceive: BigNumber;

      const initializeSubjectVariables = () => {
        subjectCaller = user;
        subjectSetToken = setToken;
        subjectInputToken = usdc;
        subjectAmountInput = UnitsUtils.usdc(1000);
        subjectMinSetReceive = ether(0);
      };

      cacheBeforeEach(async () => {
        initializeSubjectVariables();
        await exchangeIssuance.approveSetToken(subjectSetToken.address);
        await subjectInputToken
          .connect(subjectCaller.wallet)
          .approve(exchangeIssuance.address, MAX_UINT_256);
      });

      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance
          .connect(subjectCaller.wallet)
          .issueSetForExactToken(
            subjectSetToken.address,
            subjectInputToken.address,
            subjectAmountInput,
            subjectMinSetReceive,
            { gasLimit: 9000000 },
          );
      }

      it("should issue the correct amount of Set to the caller", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectedOutputOfSet = await getIssueSetForExactToken(
          subjectSetToken,
          subjectInputToken.address,
          subjectAmountInput,
          uniswapRouter,
          uniswapFactory,
          sushiswapRouter,
          sushiswapFactory,
          weth.address,
        );

        await subject();

        const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectedSetBalance = initialBalanceOfSet.add(expectedOutputOfSet);
        expect(finalSetBalance).to.eq(expectedSetBalance);
      });

      it("should use the correct amount of input token from the caller", async () => {
        const initialBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);

        await subject();

        const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
        const expectedTokenBalance = initialBalanceOfInputToken.sub(subjectAmountInput);
        expect(finalBalanceOfInputToken).to.eq(expectedTokenBalance);
      });

      it("emits an ExchangeIssue log", async () => {
        const expectedSetTokenAmount = await getIssueSetForExactToken(
          subjectSetToken,
          subjectInputToken.address,
          subjectAmountInput,
          uniswapRouter,
          uniswapFactory,
          sushiswapRouter,
          sushiswapFactory,
          weth.address,
        );

        await expect(subject())
          .to.emit(exchangeIssuance, "ExchangeIssue")
          .withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            subjectInputToken.address,
            subjectAmountInput,
            expectedSetTokenAmount,
          );
      });

      context("when input erc20 token is weth", async () => {
        cacheBeforeEach(async () => {
          subjectInputToken = weth;
          await subjectInputToken
            .connect(subjectCaller.wallet)
            .approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 0 });
        });

        it("should issue the correct amount of Set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedOutputOfSet = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address,
          );

          await subject();

          const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedSetBalance = initialBalanceOfSet.add(expectedOutputOfSet);
          expect(finalSetBalance).to.eq(expectedSetBalance);
        });

        it("should use the correct amount of input token from the caller", async () => {
          const initialBalanceOfInputToken = await subjectInputToken.balanceOf(
            subjectCaller.address,
          );

          await subject();

          const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
          const expectedTokenBalance = initialBalanceOfInputToken.sub(subjectAmountInput);
          expect(finalBalanceOfInputToken).to.eq(expectedTokenBalance);
        });

        it("emits an ExchangeIssue log", async () => {
          const expectedSetTokenAmount = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address,
          );

          await expect(subject())
            .to.emit(exchangeIssuance, "ExchangeIssue")
            .withArgs(
              subjectCaller.address,
              subjectSetToken.address,
              subjectInputToken.address,
              subjectAmountInput,
              expectedSetTokenAmount,
            );
        });
      });

      context("when set contains weth", async () => {
        cacheBeforeEach(async () => {
          subjectSetToken = setTokenWithWeth;

          await exchangeIssuance.approveSetToken(subjectSetToken.address);
          await subjectInputToken
            .connect(subjectCaller.wallet)
            .approve(exchangeIssuance.address, MAX_UINT_256);
        });

        it("should issue the correct amount of Set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedSetOutput = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address,
          );

          await subject();

          const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfSet.add(expectedSetOutput);
          expect(finalSetBalance).to.eq(expectedBalance);
        });

        it("should use the correct amount of input token from the caller", async () => {
          const initialBalanceOfToken = await subjectInputToken.balanceOf(subjectCaller.address);

          await subject();

          const finalTokenBalance = await subjectInputToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfToken.sub(subjectAmountInput);
          expect(finalTokenBalance).to.eq(expectedBalance);
        });

        it("emits an ExchangeIssue log", async () => {
          const expectedSetTokenAmount = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address,
          );

          await expect(subject())
            .to.emit(exchangeIssuance, "ExchangeIssue")
            .withArgs(
              subjectCaller.address,
              subjectSetToken.address,
              subjectInputToken.address,
              subjectAmountInput,
              expectedSetTokenAmount,
            );
        });
      });

      context("when input amount is 0", async () => {
        beforeEach(async () => {
          subjectAmountInput = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when output set token amount is insufficient", async () => {
        beforeEach(async () => {
          subjectMinSetReceive = ether(100000);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT",
          );
        });
      });

      context("when the set token has an illiquid component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenIlliquid;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });
    describe("#flashloan", async () => {
      let subjectAssets: Address[];
      let subjectAmounts: BigNumber[];
      let availableTokenBalance: BigNumber;
      before(async () => {
        await setV2Setup.dai.approve(aaveV2Setup.lendingPool.address, MAX_UINT_256);
        await aaveV2Setup.lendingPool.deposit(dai.address, ether(1000), owner.address, 0);
      });
      context("when the ei module has not enough token to pay fees", async () => {
        beforeEach(async () => {
          availableTokenBalance = UnitsUtils.ether(10);
          subjectAssets = [dai.address];
          subjectAmounts = [availableTokenBalance.div(2)];
          await dai.transfer(exchangeIssuance.address, availableTokenBalance);
          await dai.transfer(aaveV2Setup.daiReserveTokens.aToken.address, availableTokenBalance);
        });

        async function subject() {
          return await exchangeIssuance.flashloan(subjectAssets, subjectAmounts);
        }

        it("should revert", async () => {
          const lendingPool = await exchangeIssuance.LENDING_POOL();
          console.log("Lending pool addresses", lendingPool, aaveV2Setup.lendingPool.address);
          console.log("Subject variables", subjectAssets, subjectAmounts);
          console.log("Dai a token", aaveV2Setup.daiReserveTokens.aToken.address);
          console.log("Dai a token supply", await aaveV2Setup.daiReserveTokens.aToken.totalSupply());
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });
  });
});
