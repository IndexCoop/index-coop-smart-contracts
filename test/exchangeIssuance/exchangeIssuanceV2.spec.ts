import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, MAX_UINT_256, MAX_UINT_96, MAX_INT_256, ONE } from "@utils/constants";
import { ExchangeIssuanceV2, StandardTokenMock, WETH9 } from "@utils/contracts/index";
import { UniswapV2Factory, UniswapV2Router02 } from "@utils/contracts/uniswap";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getSetFixture,
  getUniswapFixture,
  getWaffleExpect,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { UniswapFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import {
  getAllowances,
  getIssueExactSetFromToken,
  getIssueSetForExactToken,
  getRedeemExactSetForToken,
  getIssueExactSetFromTokenRefund,
} from "@utils/common/exchangeIssuanceUtils";


const expect = getWaffleExpect();


describe("ExchangeIssuanceV2", async () => {
  let owner: Account;
  let user: Account;
  let externalPositionModule: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setTokenWithWeth: SetToken;

  let exchangeIssuance: ExchangeIssuanceV2;

  cacheBeforeEach(async () => {
    [
      owner,
      user,
      externalPositionModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    const daiUnits = BigNumber.from("23252699054621733");
    const wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    const wethUnits = ether(0.5);
    setTokenWithWeth = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.weth.address],
      [daiUnits, wethUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    await setV2Setup.issuanceModule.initialize(setTokenWithWeth.address, ADDRESS_ZERO);
  });

  describe("#constructor", async () => {
    let wethAddress: Address;
    let uniswapFactory: UniswapV2Factory;
    let uniswapRouter: UniswapV2Router02;
    let sushiswapFactory: UniswapV2Factory;
    let sushiswapRouter: UniswapV2Router02;
    let controllerAddress: Address;
    let basicIssuanceModuleAddress: Address;

    cacheBeforeEach(async () => {
      let uniswapSetup: UniswapFixture;
      let sushiswapSetup: UniswapFixture;
      let wbtcAddress: Address;
      let daiAddress: Address;

      wethAddress = setV2Setup.weth.address;
      wbtcAddress = setV2Setup.wbtc.address;
      daiAddress = setV2Setup.dai.address;

      uniswapSetup = getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

      sushiswapSetup = getUniswapFixture(owner.address);
      await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

      uniswapFactory = uniswapSetup.factory;
      uniswapRouter = uniswapSetup.router;
      sushiswapFactory = sushiswapSetup.factory;
      sushiswapRouter = sushiswapSetup.router;
      controllerAddress = setV2Setup.controller.address;
      basicIssuanceModuleAddress = setV2Setup.issuanceModule.address;
    });

    async function subject(): Promise<ExchangeIssuanceV2> {
      return await deployer.extensions.deployExchangeIssuanceV2(
        wethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        basicIssuanceModuleAddress
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: ExchangeIssuanceV2 = await subject();

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

      const expectedBasicIssuanceModuleAddress = await exchangeIssuanceContract.basicIssuanceModule();
      expect(expectedBasicIssuanceModuleAddress).to.eq(basicIssuanceModuleAddress);
    });

    it("approves WETH to the uniswap and sushiswap router", async () => {
      const exchangeIssuance: ExchangeIssuanceV2 = await subject();

      // validate the allowance of WETH between uniswap, sushiswap, and the deployed exchange issuance contract
      const uniswapWethAllowance = await setV2Setup.weth.allowance(exchangeIssuance.address, uniswapRouter.address);
      expect(uniswapWethAllowance).to.eq(MAX_UINT_256);

      const sushiswapWethAllownace = await setV2Setup.weth.allowance(exchangeIssuance.address, sushiswapRouter.address);
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
    let basicIssuanceModuleAddress: Address;

    let weth: WETH9;
    let wbtc: StandardTokenMock;
    let dai: StandardTokenMock;
    let usdc: StandardTokenMock;
    let illiquidToken: StandardTokenMock;
    let setTokenIlliquid: SetToken;
    let setTokenExternal: SetToken;

    cacheBeforeEach(async () => {
      let uniswapSetup: UniswapFixture;
      let sushiswapSetup: UniswapFixture;

      weth = setV2Setup.weth;
      wbtc = setV2Setup.wbtc;
      dai = setV2Setup.dai;
      usdc = setV2Setup.usdc;
      illiquidToken = await deployer.setV2.deployTokenMock(owner.address, ether(1000000), 18, "illiquid token", "RUGGED");

      usdc.transfer(user.address, UnitsUtils.usdc(10000));
      weth.transfer(user.address, UnitsUtils.ether(1000));

      const daiUnits = ether(0.5);
      const illiquidTokenUnits = ether(0.5);
      setTokenIlliquid = await setV2Setup.createSetToken(
        [setV2Setup.dai.address, illiquidToken.address],
        [daiUnits, illiquidTokenUnits],
        [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
      );
      await setV2Setup.issuanceModule.initialize(setTokenIlliquid.address, ADDRESS_ZERO);

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

      uniswapSetup = await getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, weth.address, wbtc.address, dai.address);
      sushiswapSetup = await getUniswapFixture(owner.address);
      await sushiswapSetup.initialize(owner, weth.address, wbtc.address, dai.address);

      subjectWethAddress = weth.address;
      uniswapFactory = uniswapSetup.factory;
      uniswapRouter = uniswapSetup.router;
      sushiswapFactory = sushiswapSetup.factory;
      sushiswapRouter = sushiswapSetup.router;
      controllerAddress = setV2Setup.controller.address;
      basicIssuanceModuleAddress = setV2Setup.issuanceModule.address;

      await sushiswapSetup.createNewPair(weth.address, wbtc.address);
      await uniswapSetup.createNewPair(weth.address, dai.address);
      await uniswapSetup.createNewPair(weth.address, usdc.address);

      // ETH-WBTC pools
      await wbtc.approve(uniswapRouter.address, MAX_UINT_256);
      await uniswapRouter.connect(owner.wallet).addLiquidityETH(
        wbtc.address,
        UnitsUtils.wbtc(100000),
        MAX_UINT_256,
        MAX_UINT_256,
        owner.address,
        (await getLastBlockTimestamp()).add(1),
        { value: ether(100), gasLimit: 9000000 }
      );

      // cheaper wbtc compared to uniswap
      await wbtc.approve(sushiswapRouter.address, MAX_UINT_256);
      await sushiswapRouter.connect(owner.wallet).addLiquidityETH(
        wbtc.address,
        UnitsUtils.wbtc(200000),
        MAX_UINT_256,
        MAX_UINT_256,
        owner.address,
        (await getLastBlockTimestamp()).add(1),
        { value: ether(100), gasLimit: 9000000 }
      );

      // ETH-DAI pools
      await dai.approve(uniswapRouter.address, MAX_INT_256);
      await uniswapRouter.connect(owner.wallet).addLiquidityETH(
        dai.address,
        ether(100000),
        MAX_UINT_256,
        MAX_UINT_256,
        owner.address,
        (await getLastBlockTimestamp()).add(1),
        { value: ether(10), gasLimit: 9000000 }
      );

      // ETH-USDC pools
      await usdc.connect(owner.wallet).approve(uniswapRouter.address, MAX_INT_256);
      await uniswapRouter.connect(owner.wallet).addLiquidityETH(
        usdc.address,
        UnitsUtils.usdc(100000),
        MAX_UINT_256,
        MAX_UINT_256,
        user.address,
        (await getLastBlockTimestamp()).add(1),
        { value: ether(100), gasLimit: 9000000 }
      );

      exchangeIssuance = await deployer.extensions.deployExchangeIssuanceV2(
        subjectWethAddress,
        uniswapFactory.address,
        uniswapRouter.address,
        sushiswapFactory.address,
        sushiswapRouter.address,
        controllerAddress,
        basicIssuanceModuleAddress
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
        const spenders = [uniswapRouter.address, sushiswapRouter.address, basicIssuanceModuleAddress];
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
        return await exchangeIssuance.approveTokens(subjectTokensToApprove.map(token => token.address));
      }

      it("should update the approvals correctly", async () => {
        const spenders = [uniswapRouter.address, sushiswapRouter.address, basicIssuanceModuleAddress];

        await subject();

        const finalAllowances = await getAllowances(subjectTokensToApprove, exchangeIssuance.address, spenders);

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
        const spenders = [uniswapRouter.address, sushiswapRouter.address, basicIssuanceModuleAddress];

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
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED");
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
        await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256);
      });

      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.connect(subjectCaller.wallet).issueSetForExactToken(
          subjectSetToken.address,
          subjectInputToken.address,
          subjectAmountInput,
          subjectMinSetReceive,
          { gasLimit: 9000000 }
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
          weth.address
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
          weth.address
        );

        await expect(subject()).to.emit(exchangeIssuance, "ExchangeIssue").withArgs(
          subjectCaller.address,
          subjectSetToken.address,
          subjectInputToken.address,
          subjectAmountInput,
          expectedSetTokenAmount
        );
      });

      context("when input erc20 token is weth", async () => {
        cacheBeforeEach(async () => {
          subjectInputToken = weth;
          await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
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
            weth.address
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
            weth.address
          );

          await expect(subject()).to.emit(exchangeIssuance, "ExchangeIssue").withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            subjectInputToken.address,
            subjectAmountInput,
            expectedSetTokenAmount
          );
        });
      });

      context("when set contains weth", async () => {
        cacheBeforeEach(async () => {
          subjectSetToken = setTokenWithWeth;

          await exchangeIssuance.approveSetToken(subjectSetToken.address);
          await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256);
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
            weth.address
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
            weth.address
          );

          await expect(subject()).to.emit(exchangeIssuance, "ExchangeIssue").withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            subjectInputToken.address,
            subjectAmountInput,
            expectedSetTokenAmount
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
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
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

    describe("#issueExactSetFromToken", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectInputToken: StandardTokenMock | WETH9;
      let subjectMaxAmountInput: BigNumber;
      let subjectAmountSetToken: BigNumber;

      const initializeSubjectVariables = () => {
        subjectCaller = user;
        subjectSetToken = setToken;
        subjectInputToken = usdc;
        subjectMaxAmountInput = UnitsUtils.usdc(100);
        subjectAmountSetToken = ether(0.1);
      };

      cacheBeforeEach(async () => {
        initializeSubjectVariables();
        await exchangeIssuance.approveSetToken(subjectSetToken.address, { gasPrice: 9 });
        await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
      });

      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.connect(subjectCaller.wallet).issueExactSetFromToken(
          subjectSetToken.address,
          subjectInputToken.address,
          subjectAmountSetToken,
          subjectMaxAmountInput,
          { gasPrice: 9 }
        );
      }

      it("should issue the correct amount of Set to the caller", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

        await subject();

        const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectBalanceOfSet = initialBalanceOfSet.add(subjectAmountSetToken);
        expect(finalBalanceOfSet).to.eq(expectBalanceOfSet);
      });

      it("should use the correct amount of input token from the caller", async () => {
        const initialBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);

        await subject();

        const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
        const expectedBalanceOfInputToken = initialBalanceOfInputToken.sub(subjectMaxAmountInput);
        expect(finalBalanceOfInputToken).to.eq(expectedBalanceOfInputToken);
      });

      it("should return the correct amount of ether to the caller", async () => {
        const initialBalanceOfEth = await setV2Setup.weth.balanceOf(subjectCaller.address);
        const expectedRefund = await getIssueExactSetFromTokenRefund(
          subjectSetToken,
          subjectInputToken,
          subjectMaxAmountInput,
          subjectAmountSetToken,
          uniswapRouter,
          uniswapFactory,
          sushiswapRouter,
          sushiswapFactory,
          weth.address
        );

        await subject();

        const finalEthBalance = await setV2Setup.weth.balanceOf(subjectCaller.address);
        const expectedEthBalance = initialBalanceOfEth.add(expectedRefund);
        expect(finalEthBalance).to.eq(expectedEthBalance);
      });

      it("emits an ExchangeIssue log", async () => {
        await expect(subject()).to.emit(exchangeIssuance, "ExchangeIssue").withArgs(
          subjectCaller.address,
          subjectSetToken.address,
          subjectInputToken.address,
          subjectMaxAmountInput,
          subjectAmountSetToken
        );
      });

      it("emits a Refund log", async () => {
        const expectedRefund = await getIssueExactSetFromTokenRefund(
          subjectSetToken,
          subjectInputToken,
          subjectMaxAmountInput,
          subjectAmountSetToken,
          uniswapRouter,
          uniswapFactory,
          sushiswapRouter,
          sushiswapFactory,
          weth.address
        );

        await expect(subject()).to.emit(exchangeIssuance, "Refund").withArgs(
          subjectCaller.address,
          expectedRefund
        );
      });

      context("when input erc20 token is weth", async () => {
        const initializeSubjectVariables = () => {
          subjectInputToken = weth;
          subjectMaxAmountInput = UnitsUtils.ether(1000);
          subjectAmountSetToken = UnitsUtils.ether(1);
        };

        cacheBeforeEach(async () => {
          initializeSubjectVariables();
          await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
        });

        beforeEach(initializeSubjectVariables);

        it("should issue the correct amount of Set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

          await subject();

          const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectBalanceOfSet = initialBalanceOfSet.add(subjectAmountSetToken);
          expect(finalBalanceOfSet).to.eq(expectBalanceOfSet);
        });

        it("should use the correct amount of input token from the caller", async () => {
          const initialBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);

          const amountIn = await exchangeIssuance.getAmountInToIssueExactSet(
            subjectSetToken.address,
            subjectInputToken.address,
            subjectAmountSetToken
          );

          await subject();

          const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
          const expectedBalanceOfInputToken = initialBalanceOfInputToken.sub(amountIn);
          expect(finalBalanceOfInputToken).to.eq(expectedBalanceOfInputToken);
        });

        it("should return the correct amount of WETH to the caller", async () => {
          const initialBalanceOfWeth = await setV2Setup.weth.balanceOf(subjectCaller.address);

          const amountIn = await exchangeIssuance.getAmountInToIssueExactSet(
            subjectSetToken.address,
            subjectInputToken.address,
            subjectAmountSetToken
          );

          const expectedRefund = await getIssueExactSetFromTokenRefund(
            subjectSetToken,
            subjectInputToken,
            subjectMaxAmountInput,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await subject();

          const finalEthBalance = await setV2Setup.weth.balanceOf(subjectCaller.address);
          const expectedEthBalance = initialBalanceOfWeth.sub(amountIn);

          expect(finalEthBalance).to.eq(expectedEthBalance);
          expect(finalEthBalance).to.eq(expectedRefund);
        });

        it("emits an ExchangeIssue log", async () => {
          await expect(subject()).to.emit(exchangeIssuance, "ExchangeIssue").withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            subjectInputToken.address,
            subjectMaxAmountInput,
            subjectAmountSetToken
          );
        });

        it("emits a Refund log", async () => {
          const expectedRefund = await getIssueExactSetFromTokenRefund(
            subjectSetToken,
            subjectInputToken,
            subjectMaxAmountInput,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await expect(subject()).to.emit(exchangeIssuance, "Refund").withArgs(
            subjectCaller.address,
            expectedRefund
          );
        });

        context("when exact amount of token needed is supplied", () => {
          beforeEach(async () => {
            subjectMaxAmountInput = await getIssueExactSetFromToken(
              subjectSetToken,
              subjectInputToken,
              subjectAmountSetToken,
              uniswapRouter,
              uniswapFactory,
              sushiswapRouter,
              sushiswapFactory,
              weth.address
            );
          });

          it("should not refund any eth", async () => {
            await expect(subject()).to.emit(exchangeIssuance, "Refund").withArgs(
              subjectCaller.address,
              BigNumber.from(0)
            );
          });
        });
      });

      context("when set contains weth", async () => {
        cacheBeforeEach(async () => {
          subjectSetToken = setTokenWithWeth;
          subjectAmountSetToken = ether(0.00001);

          await exchangeIssuance.approveSetToken(subjectSetToken.address, { gasPrice: 9 });
          await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
        });

        it("should issue the correct amount of Set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

          await subject();

          const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfSet.add(subjectAmountSetToken);
          expect(finalBalanceOfSet).to.eq(expectedBalance);
        });

        it("should use the correct amount of input token from the caller", async () => {
          const initialBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);

          await subject();

          const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfInputToken.sub(subjectMaxAmountInput);
          expect(finalBalanceOfInputToken).to.eq(expectedBalance);
        });

        it("should return the correct amount of WETH to the caller", async () => {
          const initialBalanceOfEth = await setV2Setup.weth.balanceOf(subjectCaller.address);
          const expectedRefund = await getIssueExactSetFromTokenRefund(
            subjectSetToken,
            subjectInputToken,
            subjectMaxAmountInput,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await subject();

          const finalEthBalance = await setV2Setup.weth.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfEth.add(expectedRefund);
          expect(finalEthBalance).to.eq(expectedBalance);
        });

        it("emits an ExchangeIssue log", async () => {
          await expect(subject()).to.emit(exchangeIssuance, "ExchangeIssue").withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            subjectInputToken.address,
            subjectMaxAmountInput,
            subjectAmountSetToken
          );
        });

        it("emits a Refund log", async () => {
          const expectedRefund = await getIssueExactSetFromTokenRefund(
            subjectSetToken,
            subjectInputToken,
            subjectMaxAmountInput,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await expect(subject()).to.emit(exchangeIssuance, "Refund").withArgs(
            subjectCaller.address,
            expectedRefund
          );
        });
      });

      context("when max input amount is 0", async () => {
        beforeEach(async () => {
          subjectMaxAmountInput = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when amount Set is 0", async () => {
        beforeEach(async () => {
          subjectAmountSetToken = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when input token amount is insufficient", async () => {
        beforeEach(async () => {
          subjectMaxAmountInput = ONE;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INSUFFICIENT_INPUT_AMOUNT");
        });
      });

      context("when the set token has an illiquid component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenIlliquid;

          await exchangeIssuance.approveSetToken(subjectSetToken.address, { gasPrice: 9 });
          await subjectInputToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });

      context("when there is not enough liquidity to issue required amount", async () => {
        beforeEach(async () => {
          subjectAmountSetToken = ether(10 ** 10);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });

      context("when there is not enough liquidity to issue required amount (on sushi)", async () => {
        beforeEach(async () => {
          subjectSetToken = await setV2Setup.createSetToken(
            [setV2Setup.wbtc.address],
            [UnitsUtils.wbtc(1)],
            [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
          );
          subjectAmountSetToken = ether(10 ** 10);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });

    describe("#redeemExactSetForToken", async () => {
      let subjectCaller: Account;
      let subjectSetToken: SetToken;
      let subjectAmountSetToken: BigNumber;
      let subjectOutputToken: StandardTokenMock | WETH9;
      let subjectMinTokenReceived: BigNumber;

      const initializeSubjectVariables = () => {
        subjectCaller = user;
        subjectSetToken = setToken;
        subjectAmountSetToken = ether(100);
        subjectOutputToken = usdc;
        subjectMinTokenReceived = ether(0);
      };

      cacheBeforeEach(async () => {
        initializeSubjectVariables();
        // acquire set tokens to redeem
        await setV2Setup.approveAndIssueSetToken(subjectSetToken, subjectAmountSetToken, subjectCaller.address);
        await exchangeIssuance.approveSetToken(subjectSetToken.address);
        await subjectSetToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
      });

      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.connect(subjectCaller.wallet).redeemExactSetForToken(
          subjectSetToken.address,
          subjectOutputToken.address,
          subjectAmountSetToken,
          subjectMinTokenReceived,
          { gasPrice: 9 }
        );
      }

      it("should redeem the correct amount of a set to the caller", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

        await subject();

        const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
        const expectedBalance = initialBalanceOfSet.sub(subjectAmountSetToken);
        expect(finalBalanceOfSet).to.eq(expectedBalance);
      });

      it("should return the correct amount of output token to the caller", async () => {
        const initialBalanceOfToken = await subjectOutputToken.balanceOf(subjectCaller.address);
        const expectedTokensReturned = await getRedeemExactSetForToken(
          subjectSetToken,
          subjectOutputToken,
          subjectAmountSetToken,
          uniswapRouter,
          uniswapFactory,
          sushiswapRouter,
          sushiswapFactory,
          weth.address
        );

        await subject();

        const finalTokenBalance = await subjectOutputToken.balanceOf(subjectCaller.address);
        const expectedBalance = initialBalanceOfToken.add(expectedTokensReturned);
        expect(finalTokenBalance).to.eq(expectedBalance);
      });

      it("emits an ExchangeRedeem log", async () => {
        const expectedTokensReturned = await getRedeemExactSetForToken(
          subjectSetToken,
          subjectOutputToken,
          subjectAmountSetToken,
          uniswapRouter,
          uniswapFactory,
          sushiswapRouter,
          sushiswapFactory,
          weth.address
        );

        await expect(subject()).to.emit(exchangeIssuance, "ExchangeRedeem").withArgs(
          subjectCaller.address,
          subjectSetToken.address,
          subjectOutputToken.address,
          subjectAmountSetToken,
          expectedTokensReturned
        );
      });

      context("when set token has external positions", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenExternal;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED");
        });
      });

      context("when output erc20 token amount is insufficient", async () => {
        beforeEach(async () => {
          subjectMinTokenReceived = ether(100000);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        });
      });

      context("when output erc20 token is weth", async () => {
        beforeEach(async () => {
          subjectOutputToken = weth;
        });

        it("should redeem the correct amount of a set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

          await subject();

          const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfSet.sub(subjectAmountSetToken);
          expect(finalBalanceOfSet).to.eq(expectedBalance);
        });

        it("should return the correct amount of output token to the caller", async () => {
          const initialBalanceOfToken = await subjectOutputToken.balanceOf(subjectCaller.address);
          const expectedTokensReturned = await getRedeemExactSetForToken(
            subjectSetToken,
            subjectOutputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await subject();

          const finalTokenBalance = await subjectOutputToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfToken.add(expectedTokensReturned);
          expect(finalTokenBalance).to.eq(expectedBalance);
        });

        context("when output erc20 token amount is insufficient", async () => {
          beforeEach(async () => {
            subjectMinTokenReceived = ether(100000);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
          });
        });
      });

      context("when set contains weth", async () => {
        const initializeSubjectVariables = () => {
          subjectSetToken = setTokenWithWeth;
          subjectAmountSetToken = ether(1);
        };

        cacheBeforeEach(async () => {
          initializeSubjectVariables();
          await setV2Setup.approveAndIssueSetToken(subjectSetToken, subjectAmountSetToken, subjectCaller.address);
          await exchangeIssuance.approveSetToken(subjectSetToken.address);
          await subjectSetToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
        });

        beforeEach(initializeSubjectVariables);

        it("should redeem the correct amount of a set to the caller", async () => {
          const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

          await subject();

          const finalBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);
          const expectedBalanceOfSet = initialBalanceOfSet.sub(subjectAmountSetToken);
          expect(finalBalanceOfSet).to.eq(expectedBalanceOfSet);
        });

        it("should return the correct amount of output token to the caller", async () => {
          const initialBalanceOfToken = await subjectOutputToken.balanceOf(subjectCaller.address);
          const expectedTokensReturned = await getRedeemExactSetForToken(
            subjectSetToken,
            subjectOutputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await subject();

          const finalTokenBalance = await subjectOutputToken.balanceOf(subjectCaller.address);
          const expectedBalance = initialBalanceOfToken.add(expectedTokensReturned);
          expect(finalTokenBalance).to.eq(expectedBalance);
        });

        it("emits an ExchangeRedeem log", async () => {
          const expectedTokensReturned = await getRedeemExactSetForToken(
            subjectSetToken,
            subjectOutputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );

          await expect(subject()).to.emit(exchangeIssuance, "ExchangeRedeem").withArgs(
            subjectCaller.address,
            subjectSetToken.address,
            subjectOutputToken.address,
            subjectAmountSetToken,
            expectedTokensReturned
          );
        });
      });

      context("when amount Set is 0", async () => {
        beforeEach(async () => {
          subjectAmountSetToken = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when the set token has an illiquid component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenIlliquid;
          await setV2Setup.approveAndIssueSetToken(subjectSetToken, subjectAmountSetToken, subjectCaller.address);
          await exchangeIssuance.approveSetToken(subjectSetToken.address);
          await subjectSetToken.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256, { gasPrice: 9 });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });

    describe("#getEstimatedIssueSetAmount", async () => {
      let subjectSetToken: SetToken;
      let subjectInputToken: StandardTokenMock | WETH9;
      let subjectAmountInput: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken;
        subjectAmountInput = UnitsUtils.usdc(1000);
      });

      async function subject(): Promise<BigNumber> {
        return await exchangeIssuance.getEstimatedIssueSetAmount(
          subjectSetToken.address,
          subjectInputToken.address,
          subjectAmountInput
        );
      }

      context("when input token is weth", async () => {
        beforeEach(async () => {
          subjectInputToken = weth;
        });

        it("should return the correct amount of output set", async () => {
          const expectedSetOutput = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualSetOutput = await subject();

          expect(expectedSetOutput).to.eq(actualSetOutput);
        });
      });

      context("when input token is an erc20", async () => {
        beforeEach(async () => {
          subjectInputToken = usdc;
        });

        it("should return the correct amount of output set", async () => {
          const expectedSetOutput = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualSetOutput = await subject();

          expect(expectedSetOutput).to.eq(actualSetOutput);
        });
      });

      context("when set contains an external component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenExternal;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED");
        });
      });

      context("when amount Set is 0", async () => {
        beforeEach(async () => {
          subjectAmountInput = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when set contains weth", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenWithWeth;
        });

        it("should return the correct amount of output set", async () => {
          const expectedSetOutput = await getIssueSetForExactToken(
            subjectSetToken,
            subjectInputToken.address,
            subjectAmountInput,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualSetOutput = await subject();

          expect(expectedSetOutput).to.eq(actualSetOutput);
        });
      });

      context("when set contains an illiquid component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenIlliquid;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });

    describe("#getAmountInToIssueExactSet", async () => {
      let subjectSetToken: SetToken;
      let subjectInputToken: StandardTokenMock | WETH9;
      let subjectAmountSetToken: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken;
        subjectAmountSetToken = ether(1000);
      });

      async function subject(): Promise<BigNumber> {
        return await exchangeIssuance.getAmountInToIssueExactSet(
          subjectSetToken.address,
          subjectInputToken.address,
          subjectAmountSetToken
        );
      }

      context("when input token is an erc20", async () => {
        beforeEach(async () => {
          subjectInputToken = usdc;
        });

        it("should return the correct amount of input tokens", async () => {
          const expectedInputAmount = await getIssueExactSetFromToken(
            subjectSetToken,
            subjectInputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualInputAmount = await subject();

          expect(expectedInputAmount).to.eq(actualInputAmount);
        });
      });

      context("when input token is weth", async () => {
        beforeEach(async () => {
          subjectInputToken = weth;
        });

        it("should return the correct amount of input tokens", async () => {
          const expectedInputAmount = await getIssueExactSetFromToken(
            subjectSetToken,
            subjectInputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualInputAmount = await subject();

          expect(expectedInputAmount).to.eq(actualInputAmount);
        });
      });

      context("when amount Set is 0", async () => {
        beforeEach(async () => {
          subjectAmountSetToken = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when set contains weth", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenWithWeth;
        });

        it("should return the correct amount of input tokens", async () => {
          const expectedInputAmount = await getIssueExactSetFromToken(
            subjectSetToken,
            subjectInputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualInputAmount = await subject();

          expect(expectedInputAmount).to.eq(actualInputAmount);
        });
      });

      context("when set contains an illiquid component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenIlliquid;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });

      context("when there is not enough liquidity to issue required amount", async () => {
        beforeEach(async () => {
          subjectAmountSetToken = ether(10 ** 10);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });

    describe("#getAmountOutOnRedeemSet", async () => {
      let subjectSetToken: SetToken;
      let subjectOutputToken: StandardTokenMock | WETH9;
      let subjectAmountSetToken: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken;
        subjectAmountSetToken = ether(100);
        subjectOutputToken = usdc;
      });

      async function subject(): Promise<BigNumber> {
        return await exchangeIssuance.getAmountOutOnRedeemSet(
          subjectSetToken.address,
          subjectOutputToken.address,
          subjectAmountSetToken
        );
      }

      context("when output is an erc20", async () => {
        beforeEach(async () => {
          subjectOutputToken = usdc;
        });

        it("should return the correct amount of output tokens", async () => {
          const expectedOutputAmount = await getRedeemExactSetForToken(
            subjectSetToken,
            subjectOutputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualOutputAmount = await subject();

          expect(expectedOutputAmount).to.eq(actualOutputAmount);
        });
      });

      context("when output is weth", async () => {
        beforeEach(async () => {
          subjectOutputToken = weth;
        });

        it("should return the correct amount of output tokens", async () => {
          const expectedOutputAmount = await getRedeemExactSetForToken(
            subjectSetToken,
            subjectOutputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualOutputAmount = await subject();

          expect(expectedOutputAmount).to.eq(actualOutputAmount);
        });
      });

      context("when set contains weth", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenWithWeth;
        });

        it("should return the correct amount of output tokens", async () => {
          const expectedOutputAmount = await getRedeemExactSetForToken(
            subjectSetToken,
            subjectOutputToken,
            subjectAmountSetToken,
            uniswapRouter,
            uniswapFactory,
            sushiswapRouter,
            sushiswapFactory,
            weth.address
          );
          const actualOutputAmount = await subject();

          expect(expectedOutputAmount).to.eq(actualOutputAmount);
        });
      });

      context("when amount Set is 0", async () => {
        beforeEach(async () => {
          subjectAmountSetToken = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: INVALID INPUTS");
        });
      });

      context("when set contains an illiquid component", async () => {
        beforeEach(async () => {
          subjectSetToken = setTokenIlliquid;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        });
      });
    });
  });
});
