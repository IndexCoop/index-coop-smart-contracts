import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ExchangeIssuanceV2 } from "@utils/contracts/index";
import { UniswapV2Factory, UniswapV2Router02 } from "@utils/contracts/uniswap";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  cacheBeforeEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { UnitsUtils } from "@utils/common/unitsUtils";
import { SetFixture } from "@utils/fixtures";
import { UniswapFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("ExchangeIssuanceV2", async () => {
  let owner: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let setTokenWithWeth: SetToken;

  cacheBeforeEach(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    const daiUnits = BigNumber.from("23252699054621733");
    const wbtcUnits = UnitsUtils.wbtc(1);
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.wbtc.address],
      [daiUnits, wbtcUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
    );

    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    const wethUnits = ether(0.5);
    setTokenWithWeth = await setV2Setup.createSetToken(
      [setV2Setup.dai.address, setV2Setup.weth.address],
      [daiUnits, wethUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
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
        basicIssuanceModuleAddress,
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
});
