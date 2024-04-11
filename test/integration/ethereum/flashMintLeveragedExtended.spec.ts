import "module-alias/register";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect, preciseMul } from "@utils/index";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ethers } from "hardhat";
import { BigNumber, utils } from "ethers";
import { FlashMintLeveragedExtended } from "../../../typechain";
import {
  IWETH,
  StandardTokenMock,
  IDebtIssuanceModule,
  IERC20__factory,
  AaveV3LeverageStrategyExtension__factory,
} from "../../../typechain";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { ether } from "@utils/index";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Sushiswap,
  Quickswap,
  UniV3,
  Curve,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

if (process.env.INTEGRATIONTEST) {
  describe.only("FlashMintLeveragedExtended - Integration Test", async () => {
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
      let flashMintLeveraged: FlashMintLeveragedExtended;
      before(async () => {
        flashMintLeveraged = await deployer.extensions.deployFlashMintLeveragedExtended(
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
          addresses.dexes.balancerv2.vault,
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
        expect(returnedAddresses.quickRouter).to.eq(utils.getAddress(addresses.dexes.uniV2.router));
      });

      it("uniV3 router address is set correctly", async () => {
        const returnedAddresses = await flashMintLeveraged.addresses();
        expect(returnedAddresses.uniV3Router).to.eq(utils.getAddress(addresses.dexes.uniV3.router));
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

          await arETH
            .connect(owner.wallet)
            .approve(addresses.setFork.debtIssuanceModuleV2, ether(10));
          await rETH.connect(owner.wallet).approve(flashMintLeveraged.address, ether(100));
          const debtIssuanceModule = (await ethers.getContractAt(
            "IDebtIssuanceModule",
            addresses.setFork.debtIssuanceModuleV2,
            owner.wallet,
          )) as IDebtIssuanceModule;

          const issueTx = await debtIssuanceModule.issue(
            setToken.address,
            ether(10),
            owner.address,
          );

          await issueTx.wait();

          const operatorSigner = await impersonateAccount(operator);

          const aaveV3LeverageStrategyExtension = AaveV3LeverageStrategyExtension__factory.connect(
            addresses.setFork.aaveV3LeverageStrategyExtension,
            operatorSigner,
          );
          const engageTx = await aaveV3LeverageStrategyExtension.engage(
            "BalancerV2ExchangeAdapter",
          );
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
            await debtToken.allowance(
              flashMintLeveraged.address,
              addresses.setFork.debtIssuanceModuleV2,
            ),
          ).to.equal(MAX_UINT_256);
        });

        ["collateralToken", "WETH", "ETH"].forEach((inputTokenName) => {
          describe(`When input/output token is ${inputTokenName}`, () => {
            let subjectMinSetAmount: BigNumber;
            let amountIn: BigNumber;
            beforeEach(async () => {
              amountIn = ether(2);
            });

            describe(
              inputTokenName === "ETH" ? "issueSetFromExactETH" : "#issueSetFromExactERC20",
              () => {
                let swapDataDebtToCollateral: SwapData;
                let swapDataInputToken: SwapData;

                let inputToken: StandardTokenMock | IWETH;

                let subjectSetToken: Address;
                let subjectAmountIn: BigNumber;
                let subjectInputToken: Address;
                let subjectPriceEstimateInflater: BigNumber;
                let subjectMaxDust: BigNumber;

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

                  subjectPriceEstimateInflater = ether(0.75);

                  if (inputTokenName === "collateralToken") {
                    inputToken = rEth;
                  } else {
                    swapDataInputToken = swapDataDebtToCollateral;

                    if (inputTokenName === "WETH") {
                      inputToken = weth;
                      await weth.deposit({ value: amountIn });
                    }
                  }

                  let inputTokenBalance: BigNumber;
                  if (inputTokenName === "ETH") {
                    subjectAmountIn = amountIn;
                  } else {
                    inputTokenBalance = await inputToken.balanceOf(owner.address);
                    subjectAmountIn = inputTokenBalance.div(50);
                    await inputToken.approve(flashMintLeveraged.address, MAX_UINT_256);
                    subjectInputToken = inputToken.address;
                  }
                  subjectMaxDust = subjectAmountIn.div(1000);
                  subjectMinSetAmount = subjectAmountIn.mul(2).div(3);
                  subjectSetToken = setToken.address;
                });

                async function subject() {
                  if (inputTokenName === "ETH") {
                    return flashMintLeveraged.issueSetFromExactETH(
                      subjectSetToken,
                      subjectMinSetAmount,
                      swapDataDebtToCollateral,
                      swapDataInputToken,
                      subjectPriceEstimateInflater,
                      subjectMaxDust,
                      { value: subjectAmountIn },
                    );
                  }
                  return flashMintLeveraged.issueSetFromExactERC20(
                    subjectSetToken,
                    subjectMinSetAmount,
                    subjectInputToken,
                    subjectAmountIn,
                    swapDataDebtToCollateral,
                    swapDataInputToken,
                    subjectPriceEstimateInflater,
                    subjectMaxDust,
                  );
                }

                it("should issue the correct amount of tokens", async () => {
                  const inputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  console.log("inputBalanceBefore", inputBalanceBefore.toString());
                  const setBalancebefore = await setToken.balanceOf(owner.address);
                  await subject();
                  const setBalanceAfter = await setToken.balanceOf(owner.address);
                  const setObtained = setBalanceAfter.sub(setBalancebefore);
                  expect(setObtained).to.gte(subjectMinSetAmount);
                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  console.log("inputBalanceAfter", inputBalanceAfter.toString());
                });

                it("should spend less than specified max amount", async () => {
                  const inputBalanceBefore =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  console.log("inputBalanceBefore", inputBalanceBefore.toString());

                  const tx = await subject();
                  const receipt = await tx.wait();

                  const inputBalanceAfter =
                    inputTokenName === "ETH"
                      ? await owner.wallet.getBalance()
                      : await inputToken.balanceOf(owner.address);
                  console.log("inputBalanceAfter", inputBalanceAfter.toString());
                  const inputSpent = inputBalanceBefore.sub(inputBalanceAfter);
                  expect(inputSpent).to.gt(BigNumber.from(0));
                  expect(inputSpent).to.lte(subjectAmountIn);
                });
              },
            );
          });
        });
      });
    });
  });
}
