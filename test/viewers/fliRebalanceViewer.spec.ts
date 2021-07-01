import "module-alias/register";

import { FLIRebalanceViewer } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { getAccounts, getRandomAddress, getWaffleExpect } from "@utils/test";
import { Account, Address, ContractSettings, ExchangeSettings } from "@utils/types";
import { ether, getSetFixture, getUniswapFixture, getUniswapV3Fixture, usdc } from "@utils/index";
import { SetFixture, UniswapFixture, UniswapV3Fixture } from "@utils/fixtures";
import { FLIStrategyExtensionMock } from "../../typechain/FLIStrategyExtensionMock";
import { BigNumber } from "ethers";
import { EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { solidityPack } from "ethers/lib/utils";

const expect = getWaffleExpect();

describe("FLIRebalanceViewer", async () => {

  let owner: Account;
  let deployer: DeployHelper;

  let setV2Setup: SetFixture;
  let uniswapV2Setup: UniswapFixture;
  let uniswapV3Setup: UniswapV3Fixture;

  let fliExtensionMock: FLIStrategyExtensionMock;
  let fliViewer: FLIRebalanceViewer;

  let uniswapV2ExchangeName: string;
  let uniswapV3ExchangeName: string;

  before(async () => {
    [ owner ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    uniswapV2Setup = getUniswapFixture(owner.address);
    uniswapV3Setup = getUniswapV3Fixture(owner.address);

    await setV2Setup.initialize();
    await uniswapV2Setup.initialize(owner, setV2Setup.weth.address, setV2Setup.wbtc.address, setV2Setup.usdc.address, false);
    await uniswapV3Setup.initialize(owner, setV2Setup.weth, 2000, setV2Setup.wbtc, 35000, setV2Setup.dai);

    uniswapV2ExchangeName = "UniswapV2ExchangeAdapter";
    uniswapV3ExchangeName = "UniswapV3ExchangeAdapter";

    fliExtensionMock = await deployer.mocks.deployFLIStrategyExtensionMock();
    fliViewer = await deployer.viewers.deployFLIRebalanceViewer(
      fliExtensionMock.address,
      uniswapV3Setup.quoter.address,
      uniswapV2Setup.router.address,
      uniswapV3ExchangeName,
      uniswapV2ExchangeName
    );

    // Setup FLI extension mock
    const strategy: ContractSettings = {
      setToken: await getRandomAddress(),
      leverageModule: await getRandomAddress(),
      comptroller: await getRandomAddress(),
      collateralPriceOracle: await getRandomAddress(),
      borrowPriceOracle: await getRandomAddress(),
      targetCollateralCToken: await getRandomAddress(),
      targetBorrowCToken: await getRandomAddress(),
      collateralAsset: setV2Setup.weth.address,
      borrowAsset: setV2Setup.usdc.address,
      collateralDecimalAdjustment: BigNumber.from(10),
      borrowDecimalAdjustment: BigNumber.from(22),
    };

    const shouldRebalanceNames = [ uniswapV3ExchangeName, uniswapV2ExchangeName ];
    const shouldRebalanceEnums = [ 1, 1 ];   // ShouldRebalance.REBALANCE

    const chunkRebalanceSizes = [ ether(5), ether(5) ];
    const chunkRebalanceSellAsset = setV2Setup.weth.address;
    const chunkRebalanceBuyAsset = setV2Setup.usdc.address;

    const uniV2ExchangeSettings: ExchangeSettings = {
      twapMaxTradeSize: ether(100),
      incentivizedTwapMaxTradeSize: ether(100),
      exchangeLastTradeTimestamp: BigNumber.from(0),
      leverExchangeData: EMPTY_BYTES,
      deleverExchangeData: EMPTY_BYTES,
    };

    const uniV3LeverData = solidityPack(
      ["address", "uint24", "address"],
      [setV2Setup.usdc.address, BigNumber.from(3000), setV2Setup.weth.address]
    );
    const uniV3DeleverData = solidityPack(
      ["address", "uint24", "address"],
      [setV2Setup.weth.address, BigNumber.from(3000), setV2Setup.usdc.address]
    );
    const uniV3ExchangeSettings: ExchangeSettings = {
      twapMaxTradeSize: ether(100),
      incentivizedTwapMaxTradeSize: ether(100),
      exchangeLastTradeTimestamp: BigNumber.from(0),
      leverExchangeData: uniV3LeverData,
      deleverExchangeData: uniV3DeleverData,
    };

    await fliExtensionMock.setStrategy(strategy);
    await fliExtensionMock.setShouldRebalanceWithBounds(shouldRebalanceNames, shouldRebalanceEnums);
    await fliExtensionMock.setGetChunkRebalanceWithBounds(chunkRebalanceSizes, chunkRebalanceSellAsset, chunkRebalanceBuyAsset);
    await fliExtensionMock.setExchangeSettings(uniswapV2ExchangeName, uniV2ExchangeSettings);
    await fliExtensionMock.setExchangeSettings(uniswapV3ExchangeName, uniV3ExchangeSettings);
  });

  describe("#constructor", async () => {

    let subjectFLIStrategyExtension: Address;
    let subjectUniV3Quoter: Address;
    let subjectUniV2Router: Address;
    let subjectUniV3Name: string;
    let subjectUniV2Name: string;

    beforeEach(async () => {
      subjectFLIStrategyExtension = await getRandomAddress();
      subjectUniV3Quoter = await getRandomAddress();
      subjectUniV2Router =  await getRandomAddress();
      subjectUniV3Name = uniswapV3ExchangeName;
      subjectUniV2Name = uniswapV2ExchangeName;
    });

    async function subject(): Promise<FLIRebalanceViewer> {
      return deployer.viewers.deployFLIRebalanceViewer(
        subjectFLIStrategyExtension,
        subjectUniV3Quoter,
        subjectUniV2Router,
        subjectUniV3Name,
        subjectUniV2Name
      );
    }

    it("should set the correct state variables", async () => {
      const viewer = await subject();

      expect(await viewer.fliStrategyExtension()).to.eq(subjectFLIStrategyExtension);
      expect(await viewer.uniswapV3Quoter()).to.eq(subjectUniV3Quoter);
      expect(await viewer.uniswapV2Router()).to.eq(subjectUniV2Router);
      expect(await viewer.uniswapV3ExchangeName()).to.eq(subjectUniV3Name);
      expect(await viewer.uniswapV2ExchangeName()).to.eq(subjectUniV2Name);
    });
  });

  describe("#shouldRebalanceWithBound", async () => {

    let subjectMinLeverageRatio: BigNumber;
    let subjectMaxLeverageRatio: BigNumber;

    beforeEach(async () => {
      subjectMinLeverageRatio = ether(1.7);
      subjectMaxLeverageRatio = ether(2.3);

      await setV2Setup.weth.approve(uniswapV2Setup.router.address, MAX_UINT_256);
      await setV2Setup.usdc.approve(uniswapV2Setup.router.address, MAX_UINT_256);
      await setV2Setup.weth.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
      await setV2Setup.usdc.approve(uniswapV3Setup.nftPositionManager.address, MAX_UINT_256);
    });

    async function subject(): Promise<[string[], number[]]> {
      return await fliViewer.shouldRebalanceWithBounds(subjectMinLeverageRatio, subjectMaxLeverageRatio);
    }

    context("when Uniswap V3 will produce a better trade", async () => {

      beforeEach(async () => {
        await uniswapV2Setup.router.addLiquidity(
          setV2Setup.weth.address,
          setV2Setup.usdc.address,
          ether(100),
          usdc(200_000),
          0,
          0,
          owner.address,
          MAX_UINT_256
        );

        await uniswapV3Setup.createNewPair(setV2Setup.weth, setV2Setup.usdc, 3000, 2000);
        await uniswapV3Setup.addLiquidityWide(
          setV2Setup.weth,
          setV2Setup.usdc,
          3000,
          ether(1000),
          usdc(2_000_000),
          owner.address
        );
      });

      it("should Uniswap V3 as the preferred exchange", async () => {

        const path = solidityPack(["address", "uint24", "address"], [setV2Setup.weth.address, 3000, setV2Setup.usdc.address]);
        const amountOut = await uniswapV3Setup.quoter.callStatic.quoteExactInput(path, ether(5));
        const calldata = (await uniswapV3Setup.quoter.quoteExactInput(path, ether(5))).data;

        console.log(calldata);
        console.log(uniswapV3Setup.quoter.address);
        console.log(amountOut.toString());

        const [[ exchangeName ], [ rebalanceEnum ]] = await subject();

        expect(exchangeName).to.eq(uniswapV3ExchangeName);
        expect(rebalanceEnum).to.eq(1);
      });
    });
  });
});