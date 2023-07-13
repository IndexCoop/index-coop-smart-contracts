import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { FlashMintLeveraged } from "@utils/contracts/index";
import {
  IWETH,
  StandardTokenMock,
  IDebtIssuanceModule,
  IERC20__factory,
  AaveV3LeverageStrategyExtension__factory
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { impersonateAccount } from "./utils";
import type { Bytes } from "@ethersproject/bytes";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Sushiswap,
  Quickswap,
  UniV3,
  Curve,
}

enum SwapKind {
  DEXAdapter,
  BalancerV2,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

type DexSwapData = {
  collateralAndDebtSwapData: SwapData;
  paymentTokenSwapData: SwapData;
};

type BigNumberish = BigNumber | Bytes | string | number;

type SwapSteps = {
  poolId: utils.BytesLike;
  assetInIndex: BigNumberish;
  assetOutIndex: BigNumberish;
  amount: BigNumberish;
  userData: utils.BytesLike;
}[];

type SwapAssets = Address[];

type BalancerV2SwapData = {
  collateralAndDebtSwapData: SwapSteps;
  debtSwapAssets: SwapAssets;
  paymentTokenSwapData: SwapSteps;
  paymentSwapAssets: SwapAssets;
};
const swapDataType = [
  { name: "path", type: "address[]" },
  { name: "fees", type: "uint24[]" },
  { name: "pool", type: "address" },
  { name: "exchange", type: "uint8" },
];

const batchSwapStepType = [
  { name: "poolId", type: "bytes32" },
  { name: "assetInIndex", type: "uint256" },
  { name: "assetOutIndex", type: "uint256" },
  { name: "amount", type: "uint256" },
  { name: "userData", type: "bytes" },
];


const dexAdapterSwapType = ethers.utils.ParamType.from({
  name: "DexAdapterSwap",
  type: "tuple",
  components: [
    { name: "collateralAndDebtSwapData", type: "tuple", components: swapDataType },
    { name: "paymentTokenSwapData", type: "tuple", components: swapDataType },
  ],
});

const balancerSwapType = ethers.utils.ParamType.from({
  name: "BalancerSwap",
  type: "tuple",
  components: [
    { name: "collateralAndDebtSwapData", type: "tuple[]", components: batchSwapStepType },
    { name: "debtSwapAssets", type: "address[]" },
    { name: "paymentTokenSwapData", type: "tuple[]", components: batchSwapStepType },
    { name: "paymentSwapAssets", type: "address[]" },
  ],
});


const encodeSwapData = (swapData: BalancerV2SwapData | DexSwapData) => {
  const swapType = "debtSwapAssets" in swapData ? balancerSwapType : dexAdapterSwapType;
  return ethers.utils.defaultAbiCoder.encode([swapType], [swapData]);
};


if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintLeveraged - Integration Test", async () => {
    const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;
    let owner: Account;
    let deployer: DeployHelper;

    let rEth: StandardTokenMock;
    let setToken: StandardTokenMock;
    let weth: IWETH;

    // const collateralTokenAddress = addresses.tokens.stEth;
    setBlockNumber(17665622);

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);

      rEth = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.rETH,
      )) as StandardTokenMock;

      setToken = (await ethers.getContractAt(
        "StandardTokenMock",
        addresses.tokens.icReth,
      )) as StandardTokenMock;


      weth = (await ethers.getContractAt("IWETH", addresses.tokens.weth)) as IWETH;
    });

    it("can get lending pool from address provider", async () => {
      const addressProvider = await ethers.getContractAt(
        "IPoolAddressesProvider",
        addresses.lending.aaveV3.addressProvider,
      );
      const lendingPool = await addressProvider.getPool();
      expect(lendingPool).to.eq(addresses.lending.aaveV3.lendingPool);
    });

    context("When exchange issuance is deployed", () => {
      let flashMintLeveraged: FlashMintLeveraged;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveraged(
          addresses.tokens.weth,
          addresses.dexes.uniV2.router,
          addresses.dexes.sushiswap.router,
          addresses.dexes.uniV3.router,
          addresses.dexes.uniV3.quoter,
          addresses.setFork.controller,
          addresses.setFork.debtIssuanceModuleV2,
          addresses.setFork.aaveV3LeverageModule,
          addresses.lending.aaveV3.lendingPool,
          addresses.dexes.curve.addressProvider,
          addresses.dexes.curve.calculator,
          addresses.dexes.balancerv2.vault
        );
      });

      it("weth address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.weth).to.eq(utils.getAddress(addresses.tokens.weth));
      });

      it("sushi router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.sushiRouter).to.eq(
          utils.getAddress(addresses.dexes.sushiswap.router),
        );
      });

      it("uniV2 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.quickRouter).to.eq(
          utils.getAddress(addresses.dexes.uniV2.router),
        );
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.uniV3Router).to.eq(
          utils.getAddress(addresses.dexes.uniV3.router),
        );
      });

      it("controller address is set correctly", async () => {
        expect(await flashMintLeveraged.setController()).to.eq(
          utils.getAddress(addresses.setFork.controller),
        );
      });

      it("debt issuance module address is set correctly", async () => {
        expect(await flashMintLeveraged.debtIssuanceModule()).to.eq(
          utils.getAddress(addresses.setFork.debtIssuanceModuleV2),
        );
      });

      describe("When setToken is approved", () => {
        let collateralAToken: StandardTokenMock;
        let debtToken: StandardTokenMock;
        let collateralATokenAddress: Address;
        let collateralTokenAddress: Address;
        let debtTokenAddress: Address;
        before(async () => {
          const arETHWhale = "0x4D17676309cb16fA991E6AE43181d08203b781F8";
          const rEthWhale = "0x7d6149aD9A573A6E2Ca6eBf7D4897c1B766841B4";
          const operator = "0x6904110f17feD2162a11B5FA66B188d801443Ea4";
          const whaleSigner = await impersonateAccount(arETHWhale);

          const rEthWhaleSigner = await impersonateAccount(rEthWhale);

          const arETH = IERC20__factory.connect(addresses.tokens.aEthrETH, whaleSigner);

          const rETH = IERC20__factory.connect(addresses.tokens.rETH, rEthWhaleSigner);
          await rETH.transfer(owner.address, ether(100));
          await arETH.transfer(owner.address, ether(100));

          await arETH.connect(owner.wallet).approve(addresses.setFork.debtIssuanceModuleV2, ether(10));
          await rETH.connect(owner.wallet).approve(flashMintLeveraged.address, ether(100));
          const debtIssuanceModule = await ethers.getContractAt(
            "IDebtIssuanceModule", addresses.setFork.debtIssuanceModuleV2, owner.wallet) as IDebtIssuanceModule;


          const issueTx = await debtIssuanceModule.issue(setToken.address, ether(10), owner.address);

          await issueTx.wait();

          const operatorSigner = await impersonateAccount(operator);

          const aaveV3LeverageStrategyExtension = AaveV3LeverageStrategyExtension__factory.connect(
            addresses.setFork.aaveV3LeverageStrategyExtension, operatorSigner);
          const engageTx = await aaveV3LeverageStrategyExtension.engage("BalancerV2ExchangeAdapter");
          await engageTx.wait();


          await flashMintLeveraged.approveSetToken(setToken.address);

          const leveragedTokenData = await flashMintLeveraged.getLeveragedTokenData(
            setToken.address,
            ether(1),
            true,
          );

          collateralATokenAddress = leveragedTokenData.collateralAToken;
          collateralTokenAddress = leveragedTokenData.collateralToken;
          debtTokenAddress = leveragedTokenData.debtToken;

          collateralAToken = (await ethers.getContractAt(
            "StandardTokenMock",
            collateralATokenAddress,
          )) as StandardTokenMock;
          debtToken = (await ethers.getContractAt(
            "StandardTokenMock",
            debtTokenAddress,
          )) as StandardTokenMock;


        });

        it("should adjust collateral a token allowance correctly", async () => {
          expect(
            await collateralAToken.allowance(
              flashMintLeveraged.address,
              addresses.setFork.debtIssuanceModuleV2,
            ),
          ).to.equal(MAX_UINT_256);
        });
        it("should adjust debt token allowance correctly", async () => {
          expect(
            await debtToken.allowance(flashMintLeveraged.address, addresses.setFork.debtIssuanceModuleV2),
          ).to.equal(MAX_UINT_256);
        });

        ["collateralToken", "WETH", "ETH"].forEach(inputTokenName => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let subjectSetAmount: BigNumber;
            let amountIn: BigNumber;
            beforeEach(async () => {
              amountIn = ether(2);
              subjectSetAmount = ether(1);
            });

            describe(
              inputTokenName == "ETH" ? "issueExactSetFromETH" : "#issueExactSetFromERC20",
              () => {
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;
                let swapDataDebtToCollateralBalancer: SwapSteps;
                let swapDataInputToCollateralBalancer: SwapSteps;
                let debtToCollateralAssets: SwapAssets;
                let inputToCollateralAssets: SwapAssets;


                let inputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMaxAmountIn: BigNumber;
                let subjectInputToken: Address;

                beforeEach(async () => {
                  swapDataDebtToCollateral = {
                    path: [addresses.tokens.weth, addresses.tokens.rETH],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };


                  swapDataInputToken = {
                    path: [],
                    fees: [],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.None,
                  };

                  swapDataDebtToCollateralBalancer = [{
                    poolId: "0x1e19cf2d73a72ef1332c882f20534b6519be0276000200000000000000000112",
                    assetInIndex: 0,
                    assetOutIndex: 1,
                    amount: 0,
                    userData: "0x",
                  }];

                  debtToCollateralAssets = [
                    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                    "0xae78736cd615f374d3085123a210448e74fc6393",
                  ];

                  swapDataInputToCollateralBalancer = [];
                  inputToCollateralAssets = [];

                  if (inputTokenName == "collateralToken") {
                    inputToken = rEth;
                  } else {
                    swapDataInputToken = swapDataDebtToCollateral;

                    if (inputTokenName == "WETH") {
                      inputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
                  }

                  let inputTokenBalance: BigNumber;
                  if (inputTokenName == "ETH") {
                    subjectMaxAmountIn = amountIn;
                  } else {
                    inputTokenBalance = await inputToken.balanceOf(owner.address);
                    subjectMaxAmountIn = inputTokenBalance;
                    await inputToken.approve(flashMintLeveraged.address, subjectMaxAmountIn);
                    subjectInputToken = inputToken.address;
                  }
                  subjectSetToken = setToken.address;
                });

                async function subject() {
                  if (inputTokenName == "ETH") {
                    return flashMintLeveraged.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      SwapKind.DEXAdapter,
                      encodeSwapData({ collateralAndDebtSwapData: swapDataDebtToCollateral, paymentTokenSwapData: swapDataInputToken }),
                      { value: subjectMaxAmountIn },
                    );
                  }
                  return flashMintLeveraged.issueExactSetFromERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectInputToken,
                    subjectMaxAmountIn,
                    SwapKind.DEXAdapter,
                    encodeSwapData({ collateralAndDebtSwapData: swapDataDebtToCollateral, paymentTokenSwapData: swapDataInputToken }),
                  );
                }

                async function subjectQuote() {
                  return flashMintLeveraged.callStatic.getIssueExactSet(
                    subjectSetToken,
                    subjectSetAmount,
                    SwapKind.DEXAdapter,
                    encodeSwapData({ collateralAndDebtSwapData: swapDataDebtToCollateral, paymentTokenSwapData: swapDataInputToken }),
                  );
                }


                it("should issue the correct amount of tokens", async () => {
                  const setBalancebefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setObtained = setBalanceAfter.sub(setBalancebefore);
                  expect(setObtained).to.eq(subjectSetAmount);
                });

                it("should spend less than specified max amount", async () => {
                  const inputBalanceBefore =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  await subject();
                  const inputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  expect(inputSpent.gt(0)).to.be.true;
                  expect(inputSpent.lte(subjectMaxAmountIn)).to.be.true;
                });

                it("should quote the correct input amount", async () => {
                  const inputBalanceBefore =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  await subject();
                  const inputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);

                  const quotedInputAmount = await subjectQuote();

                  expect(quotedInputAmount).to.gt(preciseMul(inputSpent, ether(0.99)));
                  expect(quotedInputAmount).to.lt(preciseMul(inputSpent, ether(1.01)));
                });

                it("should quote Balancer as better than Uniswap within 25% margin", async () => {
                  const uniSwapQuote = await subjectQuote();
                  const balancerQuote = await flashMintLeveraged.callStatic.getRedeemExactSet(
                    setToken.address,
                    subjectSetAmount,
                    SwapKind.BalancerV2,
                    encodeSwapData({
                      collateralAndDebtSwapData: swapDataDebtToCollateralBalancer,
                      debtSwapAssets: debtToCollateralAssets,
                      paymentTokenSwapData: swapDataInputToCollateralBalancer,
                      paymentSwapAssets: inputToCollateralAssets,
                    })
                  );
                  const uniSwapQuoteAmount = parseFloat(ethers.utils.formatEther(uniSwapQuote));
                  const balancerQuoteAmount = parseFloat(ethers.utils.formatEther(balancerQuote));

                  const difference = Math.abs(uniSwapQuoteAmount - balancerQuoteAmount);
                  const maxDifference = balancerQuoteAmount * 25 / 100;
                  expect(difference).to.lte(maxDifference);
                });

              },
            );

            describe(
              inputTokenName == "ETH" ? "redeemExactSetForETH" : "#redeemExactSetForERC20",
              () => {
                let swapDataCollateralToDebt: SwapData;
                let swapDataOutputToken: SwapData;

                let outputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectMinAmountOut: BigNumber;
                let subjectOutputToken: Address;
                let swapDataCollateralToDebtBalancer: SwapSteps;
                let collateralToDebtAssets: SwapAssets;
                let swapDataOutputTokenBalancer: SwapSteps;
                let outputTokenAssets: SwapAssets;

                async function subject() {
                  if (inputTokenName == "ETH") {
                    return flashMintLeveraged.redeemExactSetForETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectMinAmountOut,
                      SwapKind.DEXAdapter,
                      encodeSwapData({ collateralAndDebtSwapData: swapDataCollateralToDebt, paymentTokenSwapData: swapDataOutputToken }),
                    );
                  }
                  return flashMintLeveraged.redeemExactSetForERC20(
                    subjectSetToken,
                    subjectSetAmount,
                    subjectOutputToken,
                    subjectMinAmountOut,
                    SwapKind.DEXAdapter,
                    encodeSwapData({ collateralAndDebtSwapData: swapDataCollateralToDebt, paymentTokenSwapData: swapDataOutputToken }),
                  );
                }

                async function subjectQuote(): Promise<BigNumber> {
                  return flashMintLeveraged.callStatic.getRedeemExactSet(
                    subjectSetToken,
                    subjectSetAmount,
                    SwapKind.DEXAdapter,
                    encodeSwapData({ collateralAndDebtSwapData: swapDataCollateralToDebt, paymentTokenSwapData: swapDataOutputToken })
                  );
                }

                beforeEach(async () => {
                  swapDataCollateralToDebt = {
                    path: [collateralTokenAddress, addresses.tokens.weth],
                    fees: [500],
                    pool: ADDRESS_ZERO,
                    exchange: Exchange.UniV3,
                  };

                  swapDataCollateralToDebtBalancer = [{
                    poolId: "0x1e19cf2d73a72ef1332c882f20534b6519be0276000200000000000000000112",
                    assetInIndex: 1,
                    assetOutIndex: 0,
                    amount: 0,
                    userData: "0x",
                  }];

                  collateralToDebtAssets = [
                    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
                    "0xae78736cd615f374d3085123a210448e74fc6393",
                  ];

                  swapDataOutputTokenBalancer = [];
                  outputTokenAssets = [];

                  if (inputTokenName == "collateralToken") {
                    outputToken = rEth;
                    swapDataOutputToken = {
                      path: [],
                      fees: [],
                      pool: ADDRESS_ZERO,
                      exchange: Exchange.None,
                    };
                  } else {
                    swapDataOutputToken = swapDataCollateralToDebt;

                    if (inputTokenName == "WETH") {
                      outputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
                  }

                  subjectMinAmountOut = subjectSetAmount.div(2);
                  subjectSetToken = setToken.address;
                  await setToken.approve(flashMintLeveraged.address, subjectSetAmount);

                  if (inputTokenName != "ETH") {
                    subjectOutputToken = outputToken.address;
                  }
                });

                it("should redeem the correct amount of tokens", async () => {
                  const setBalanceBefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setRedeemed = setBalanceBefore.sub(setBalanceAfter);
                  expect(setRedeemed).to.eq(subjectSetAmount);
                });

                it("should return at least the specified minimum of output tokens", async () => {
                  const outputBalanceBefore =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  await subject();
                  const outputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);
                  expect(outputObtained.gte(subjectMinAmountOut)).to.be.true;
                });

                it("should quote the correct output amount", async () => {
                  const outputBalanceBefore =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  await subject();
                  const outputBalanceAfter =
                    inputTokenName == "ETH"
                      ? await owner.wallet.getBalance()
                      : await outputToken.balanceOf(owner.address);
                  const outputObtained = outputBalanceAfter.sub(outputBalanceBefore);

                  const outputAmountQuote = await subjectQuote();
                  expect(outputAmountQuote).to.gt(preciseMul(outputObtained, ether(0.99)));
                  expect(outputAmountQuote).to.lt(preciseMul(outputObtained, ether(1.01)));
                });

                it("should quote Balancer as better than Uniswap within 10% margin", async () => {
                  const uniSwapQuote = await subjectQuote();
                  const balancerQuote = await flashMintLeveraged.callStatic.getRedeemExactSet(
                    setToken.address,
                    subjectSetAmount,
                    SwapKind.BalancerV2,
                    encodeSwapData({
                      collateralAndDebtSwapData: swapDataCollateralToDebtBalancer,
                      debtSwapAssets: collateralToDebtAssets,
                      paymentTokenSwapData: swapDataOutputTokenBalancer,
                      paymentSwapAssets: outputTokenAssets,
                    })
                  );
                  const uniSwapQuoteAmount = parseFloat(ethers.utils.formatEther(uniSwapQuote));
                  const balancerQuoteAmount = parseFloat(ethers.utils.formatEther(balancerQuote));

                  const difference = Math.abs(balancerQuoteAmount - uniSwapQuoteAmount);
                  const maxDifference = balancerQuoteAmount * 10 / 100;
                  expect(difference).to.lte(maxDifference);
                });
              },
            );
          });
        });
      });
    });
  });
}
