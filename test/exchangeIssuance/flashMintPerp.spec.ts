import "module-alias/register";

import { Account, Address } from "@utils/types";
import { ADDRESS_ZERO, ZERO, MAX_UINT_256, MAX_INT_256 } from "@utils/constants";
import { StandardTokenMock, WETH9 } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getUniswapV3Fixture,
  getWaffleExpect,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { FlashMintPerp } from "@typechain/FlashMintPerp";
import { Quoter } from "@typechain/Quoter";
import { SlippageIssuanceModule } from "@typechain/SlippageIssuanceModule";
import {
  encodePath,
  expectCloseTo,
  getUsdcAmountInForExactSet,
  getUsdcAmountOutForExactSet,
} from "@utils/common/exchangeIssuanceUtils";
import { SwapRouter02 } from "@typechain/SwapRouter02";

const expect = getWaffleExpect();

describe("FlashMintPerp", async () => {
  const WETH_PRICE = 1500;
  const WBTC_PRICE = 22000;

  let owner: Account;
  let user: Account;
  let externalPositionModule: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setTokenWithWeth: SetToken;

  let exchangeIssuance: FlashMintPerp;

  cacheBeforeEach(async () => {
    [owner, user, externalPositionModule] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    const usdcUnits = BigNumber.from("23252");
    const wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.usdc.address, setV2Setup.wbtc.address],
      [usdcUnits, wbtcUnits],
      [setV2Setup.slippageIssuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.slippageIssuanceModule.initialize(
      setToken.address,
      ether(1),
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO,
    );

    const wethUnits = ether(0.5);
    setTokenWithWeth = await setV2Setup.createSetToken(
      [setV2Setup.usdc.address, setV2Setup.wbtc.address, setV2Setup.weth.address],
      [usdcUnits, wbtcUnits, wethUnits],
      [setV2Setup.slippageIssuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.slippageIssuanceModule.initialize(
      setTokenWithWeth.address,
      ether(1),
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO,
    );
  });

  describe("#constructor", async () => {
    let uniV3Router: SwapRouter02;
    let uniV3Quoter: Quoter;
    let slippageIssuanceModule: SlippageIssuanceModule;
    let usdc: StandardTokenMock;

    cacheBeforeEach(async () => {
      usdc = setV2Setup.usdc;
      slippageIssuanceModule = setV2Setup.slippageIssuanceModule;

      const uniswapV3Fixture = getUniswapV3Fixture(owner.address);
      await uniswapV3Fixture.initialize(
        owner,
        setV2Setup.weth,
        WETH_PRICE,
        setV2Setup.wbtc,
        WBTC_PRICE,
        setV2Setup.dai,
      );

      uniV3Quoter = uniswapV3Fixture.quoter;
      uniV3Router = uniswapV3Fixture.swapRouter;
    });

    async function subject(): Promise<FlashMintPerp> {
      return await deployer.extensions.deployFlashMintPerp(
        uniV3Router.address,
        uniV3Quoter.address,
        slippageIssuanceModule.address,
        usdc.address,
      );
    }

    it("verify state set properly via constructor", async () => {
      const exchangeIssuanceContract: FlashMintPerp = await subject();

      expect(await exchangeIssuanceContract.uniV3Router()).to.eq(uniV3Router.address);

      expect(await exchangeIssuanceContract.uniV3Quoter()).to.eq(uniV3Quoter.address);

      expect(await exchangeIssuanceContract.slippageIssuanceModule()).to.eq(
        slippageIssuanceModule.address,
      );

      expect(await exchangeIssuanceContract.usdc()).to.eq(usdc.address);
    });

    it("approves USDC to the uniswap v3 router and slippage module", async () => {
      const exchangeIssuance: FlashMintPerp = await subject();

      const uniV2UsdcAllownace = await usdc.allowance(
        exchangeIssuance.address,
        uniV3Router.address,
      );
      expect(uniV2UsdcAllownace).to.eq(MAX_UINT_256);

      const slippageIssuanceModuleUsdcAllowance = await usdc.allowance(
        exchangeIssuance.address,
        slippageIssuanceModule.address,
      );
      expect(slippageIssuanceModuleUsdcAllowance).to.eq(MAX_UINT_256);
    });
  });

  context("when exchange issuance is deployed", async () => {
    let uniV3Router: SwapRouter02;
    let uniV3Quoter: Quoter;
    let slippageIssuanceModule: SlippageIssuanceModule;

    let weth: WETH9;
    let wbtc: StandardTokenMock;
    let usdc: StandardTokenMock;
    let illiquidToken: StandardTokenMock;
    let setTokenIlliquid: SetToken;
    let setTokenExternal: SetToken;

    cacheBeforeEach(async () => {
      weth = setV2Setup.weth;
      wbtc = setV2Setup.wbtc;
      usdc = setV2Setup.usdc;
      illiquidToken = await deployer.setV2.deployTokenMock(
        owner.address,
        ether(1000000),
        18,
        "illiquid token",
        "RUGGED",
      );

      await usdc.transfer(user.address, UnitsUtils.usdc(1000000));
      await weth.transfer(user.address, UnitsUtils.ether(1000));

      const usdcUnits = UnitsUtils.usdc(0.5);
      const illiquidTokenUnits = ether(0.5);
      setTokenIlliquid = await setV2Setup.createSetToken(
        [setV2Setup.usdc.address, illiquidToken.address],
        [usdcUnits, illiquidTokenUnits],
        [setV2Setup.slippageIssuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.slippageIssuanceModule.initialize(
        setTokenIlliquid.address,
        ether(1),
        ZERO,
        ZERO,
        owner.address,
        ADDRESS_ZERO,
      );

      setTokenExternal = await setV2Setup.createSetToken(
        [setV2Setup.usdc.address],
        [usdcUnits],
        [setV2Setup.slippageIssuanceModule.address, setV2Setup.streamingFeeModule.address],
      );
      await setV2Setup.slippageIssuanceModule.initialize(
        setTokenExternal.address,
        ether(1),
        ZERO,
        ZERO,
        owner.address,
        ADDRESS_ZERO,
      );

      const controller = setV2Setup.controller;
      await controller.addModule(externalPositionModule.address);
      await setTokenExternal.addModule(externalPositionModule.address);
      await setTokenExternal.connect(externalPositionModule.wallet).initializeModule();

      await setTokenExternal
        .connect(externalPositionModule.wallet)
        .addExternalPositionModule(usdc.address, externalPositionModule.address);

      const uniswapV3Fixture = getUniswapV3Fixture(owner.address);
      await uniswapV3Fixture.initialize(
        owner,
        setV2Setup.weth,
        WETH_PRICE,
        setV2Setup.wbtc,
        WBTC_PRICE,
        setV2Setup.dai,
      );

      uniV3Quoter = uniswapV3Fixture.quoter;
      uniV3Router = uniswapV3Fixture.swapRouter;
      slippageIssuanceModule = setV2Setup.slippageIssuanceModule;

      await uniswapV3Fixture.createNewPair(weth, usdc, 3000, WETH_PRICE);

      // ETH-WBTC pools
      await wbtc.approve(uniswapV3Fixture.nftPositionManager.address, MAX_UINT_256);
      await weth.approve(uniswapV3Fixture.nftPositionManager.address, MAX_UINT_256);
      await uniswapV3Fixture.addLiquidityWide(
        wbtc,
        weth,
        3000,
        UnitsUtils.wbtc(100000),
        ether(100),
        owner.address,
      );

      // ETH-USDC pools
      await usdc
        .connect(owner.wallet)
        .approve(uniswapV3Fixture.nftPositionManager.address, MAX_INT_256);
      await uniswapV3Fixture.addLiquidityWide(
        weth,
        usdc,
        3000,
        ether(1000),
        ether(1000000),
        owner.address,
      );

      exchangeIssuance = await deployer.extensions.deployFlashMintPerp(
        uniV3Router.address,
        uniV3Quoter.address,
        slippageIssuanceModule.address,
        usdc.address,
      );
    });

    describe("#approve", async () => {
      let subjectToken: StandardTokenMock;
      let subjectSpender: Address;
      let subjectAmount: BigNumber;

      beforeEach(async () => {
        subjectToken = setV2Setup.dai;
        subjectSpender = uniV3Router.address;
        subjectAmount = ether(1000);
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.approve(subjectToken.address, subjectSpender, subjectAmount);
      }

      it("should update the approvals correctly", async () => {
        await subject();

        const finalAllowance = await subjectToken.allowance(
          exchangeIssuance.address,
          subjectSpender,
        );

        expect(finalAllowance).to.eq(subjectAmount);
      });
    });

    describe("#initializeSet", async () => {
      let subjectSetToken: SetToken;
      let subjectSpotToken: StandardTokenMock;
      let subjectSpotToUsdcRoute: string;

      beforeEach(async () => {
        subjectSetToken = setToken;
        subjectSpotToken = wbtc;
        subjectSpotToUsdcRoute = encodePath(
          [wbtc.address, weth.address, usdc.address],
          [3000, 3000],
        );
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.initializeSet(
          subjectSetToken.address,
          subjectSpotToUsdcRoute,
          subjectSpotToken.address,
        );
      }

      it("should revert if caller is not owner", async () => {
        await expect(
          exchangeIssuance
            .connect(user.wallet)
            .initializeSet(
              subjectSetToken.address,
              subjectSpotToUsdcRoute,
              subjectSpotToken.address,
            ),
        ).to.revertedWith("Ownable: caller is not the owner");
      });

      it("should initialize setPoolInfo", async () => {
        expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(false);

        await subject();

        const setPoolInfo = await exchangeIssuance.setPoolInfo(subjectSetToken.address);
        expect(setPoolInfo.spotToUsdcRoute).to.eq(subjectSpotToUsdcRoute);
        expect(setPoolInfo.spotToken).to.eq(subjectSpotToken.address);

        expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(true);
      });

      it("should approve tokens correctly", async () => {
        await subject();

        expect(
          await subjectSpotToken.allowance(exchangeIssuance.address, uniV3Router.address),
        ).to.eq(MAX_UINT_256);
        expect(
          await subjectSpotToken.allowance(
            exchangeIssuance.address,
            slippageIssuanceModule.address,
          ),
        ).to.eq(MAX_UINT_256);
      });
    });

    describe("#removeSet", async () => {
      let subjectSetToken: SetToken;

      beforeEach(async () => {
        subjectSetToken = setToken;

        await exchangeIssuance.initializeSet(
          subjectSetToken.address,
          encodePath([wbtc.address, weth.address, usdc.address], [3000, 3000]),
          wbtc.address,
        );
      });

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance.removeSet(subjectSetToken.address);
      }

      it("should revert if caller is not owner", async () => {
        await expect(
          exchangeIssuance.connect(user.wallet).removeSet(subjectSetToken.address),
        ).to.revertedWith("Ownable: caller is not the owner");
      });

      it("should initialize setPoolInfo", async () => {
        expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(true);

        await subject();

        const setPoolInfo = await exchangeIssuance.setPoolInfo(subjectSetToken.address);
        expect(setPoolInfo.spotToUsdcRoute).to.eq("0x");
        expect(setPoolInfo.spotToken).to.eq(ADDRESS_ZERO);

        expect(await exchangeIssuance.initializedSets(subjectSetToken.address)).to.eq(false);
      });
    });

    describe("#issueFixedSetFromUsdc", async () => {
      let subjectCaller: Account;
      let subjectInputToken: StandardTokenMock;
      let subjectSetToken: SetToken;
      let subjectSetTokenAmount: BigNumber;
      let subjectMaxAmountInput: BigNumber;
      let spotToUsdcRoute: string;

      const initializeSubjectVariables = () => {
        subjectCaller = user;
        subjectInputToken = usdc;
        subjectSetToken = setToken;
        subjectSetTokenAmount = ether(0.1);
        subjectMaxAmountInput = UnitsUtils.usdc(10000);
      };

      cacheBeforeEach(async () => {
        initializeSubjectVariables();

        spotToUsdcRoute = encodePath([wbtc.address, weth.address, usdc.address], [3000, 3000]);
        await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, wbtc.address);
        await usdc.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256);
      });

      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance
          .connect(subjectCaller.wallet)
          .issueFixedSetFromUsdc(
            subjectSetToken.address,
            subjectSetTokenAmount,
            subjectMaxAmountInput,
          );
      }

      it("should revert if set token is not initialized", async () => {
        await exchangeIssuance.removeSet(subjectSetToken.address);

        await expect(subject()).to.revertedWith("Set not initialized");
      });

      it("should issue the correct amount of Set to the caller", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

        await subject();

        const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
        expect(finalSetBalance).to.eq(initialBalanceOfSet.add(subjectSetTokenAmount));
      });

      it("should use the correct amount of input token from the caller", async () => {
        const initialBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
        const expectedInputToken = await getUsdcAmountInForExactSet(
          subjectInputToken,
          subjectSetToken,
          subjectSetTokenAmount,
          slippageIssuanceModule,
          uniV3Quoter,
          spotToUsdcRoute,
        );

        await subject();

        const finalBalanceOfInputToken = await subjectInputToken.balanceOf(subjectCaller.address);
        const expectedTokenBalance = initialBalanceOfInputToken.sub(expectedInputToken);
        expectCloseTo(finalBalanceOfInputToken, expectedTokenBalance, 1); // 1 wei difference
      });
    });

    describe("#redeemFixedSetForUsdc", async () => {
      let subjectCaller: Account;
      let subjectOutputToken: StandardTokenMock;
      let subjectSetToken: SetToken;
      let subjectSetTokenAmount: BigNumber;
      let subjectMinAmountInput: BigNumber;
      let spotToUsdcRoute: string;

      const initializeSubjectVariables = () => {
        subjectCaller = user;
        subjectOutputToken = usdc;
        subjectSetToken = setToken;
        subjectSetTokenAmount = ether(0.1);
        subjectMinAmountInput = UnitsUtils.usdc(100);
      };

      cacheBeforeEach(async () => {
        initializeSubjectVariables();
        spotToUsdcRoute = encodePath([wbtc.address, weth.address, usdc.address], [3000, 3000]);

        await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, wbtc.address);
        await usdc.connect(subjectCaller.wallet).approve(exchangeIssuance.address, MAX_UINT_256);
        await exchangeIssuance
          .connect(subjectCaller.wallet)
          .issueFixedSetFromUsdc(
            subjectSetToken.address,
            subjectSetTokenAmount,
            UnitsUtils.usdc(10000),
          );

        await setToken
          .connect(subjectCaller.wallet)
          .approve(exchangeIssuance.address, MAX_UINT_256);
      });

      beforeEach(initializeSubjectVariables);

      async function subject(): Promise<ContractTransaction> {
        return await exchangeIssuance
          .connect(subjectCaller.wallet)
          .redeemFixedSetForUsdc(
            subjectSetToken.address,
            subjectSetTokenAmount,
            subjectMinAmountInput,
          );
      }

      it("should revert if set token is not initialized", async () => {
        await exchangeIssuance.removeSet(subjectSetToken.address);

        await expect(subject()).to.revertedWith("Set not initialized");
      });

      it("should revert if not enough usdc received after redemption", async () => {
        subjectMinAmountInput = MAX_UINT_256;

        await expect(subject()).to.revertedWith("Not enough USDC");
      });

      it("should redeem the correct amount of set from the caller", async () => {
        const initialBalanceOfSet = await subjectSetToken.balanceOf(subjectCaller.address);

        await subject();

        const finalSetBalance = await subjectSetToken.balanceOf(subjectCaller.address);
        expect(finalSetBalance).to.eq(initialBalanceOfSet.sub(subjectSetTokenAmount));
      });

      it("should return the correct amount of output token to the caller", async () => {
        const initialBalanceOfOutputToken = await subjectOutputToken.balanceOf(
          subjectCaller.address,
        );
        const expectedOutputToken = await getUsdcAmountOutForExactSet(
          subjectOutputToken,
          subjectSetToken,
          subjectSetTokenAmount,
          slippageIssuanceModule,
          uniV3Quoter,
          spotToUsdcRoute,
        );

        await subject();

        const finalBalanceOfOutputToken = await subjectOutputToken.balanceOf(subjectCaller.address);
        const expectedTokenBalance = initialBalanceOfOutputToken.add(expectedOutputToken);
        expectCloseTo(finalBalanceOfOutputToken, expectedTokenBalance, 1); // 1 wei difference
      });
    });

    describe("#getUsdcAmountInForFixedSetOffChain", async () => {
      let subjectInputToken: StandardTokenMock;
      let subjectSetToken: SetToken;
      let subjectSetTokenAmount: BigNumber;
      let spotToUsdcRoute: string;

      beforeEach(async () => {
        subjectInputToken = usdc;
        subjectSetToken = setToken;
        subjectSetTokenAmount = ether(0.1);
        spotToUsdcRoute = encodePath([wbtc.address, weth.address, usdc.address], [3000, 3000]);

        await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, wbtc.address);
      });

      async function subject(): Promise<BigNumber> {
        return await exchangeIssuance.callStatic.getUsdcAmountInForFixedSetOffChain(
          subjectSetToken.address,
          subjectSetTokenAmount,
        );
      }

      it("should revert if set token components count is greater than 2", async () => {
        subjectSetToken = setTokenWithWeth;
        await exchangeIssuance.initializeSet(
          subjectSetToken.address,
          spotToUsdcRoute,
          wbtc.address,
        );

        await expect(subject()).to.revertedWith("invalid set");
      });

      it("should return correct amount of set", async () => {
        expect(await subject()).to.eq(
          await getUsdcAmountInForExactSet(
            subjectInputToken,
            subjectSetToken,
            subjectSetTokenAmount,
            slippageIssuanceModule,
            uniV3Quoter,
            spotToUsdcRoute,
          ),
        );
      });
    });

    describe("#getUsdcAmountOutForFixedSetOffChain", async () => {
      let subjectOutputToken: StandardTokenMock;
      let subjectSetToken: SetToken;
      let subjectSetTokenAmount: BigNumber;
      let spotToUsdcRoute: string;

      beforeEach(async () => {
        subjectOutputToken = usdc;
        subjectSetToken = setToken;
        subjectSetTokenAmount = ether(0.1);
        spotToUsdcRoute = encodePath([wbtc.address, weth.address, usdc.address], [3000, 3000]);

        await exchangeIssuance.initializeSet(setToken.address, spotToUsdcRoute, wbtc.address);
      });

      async function subject(): Promise<BigNumber> {
        return await exchangeIssuance.callStatic.getUsdcAmountOutForFixedSetOffChain(
          subjectSetToken.address,
          subjectSetTokenAmount,
        );
      }

      it("should revert if set token components count is greater than 2", async () => {
        subjectSetToken = setTokenWithWeth;
        await exchangeIssuance.initializeSet(
          subjectSetToken.address,
          spotToUsdcRoute,
          wbtc.address,
        );

        await expect(subject()).to.revertedWith("invalid set");
      });

      it("should return correct amount of usdc", async () => {
        expect(await subject()).to.eq(
          await getUsdcAmountOutForExactSet(
            subjectOutputToken,
            subjectSetToken,
            subjectSetTokenAmount,
            slippageIssuanceModule,
            uniV3Quoter,
            spotToUsdcRoute,
          ),
        );
      });
    });
  });
});
