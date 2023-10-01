import "module-alias/register";
import { Address, Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { getAccounts, getSetFixture, getWaffleExpect } from "@utils/index";
import { SetToken } from "@utils/contracts/setV2";
import { ethers } from "hardhat";
import { utils, BigNumber } from "ethers";
import { ExchangeIssuanceLeveraged, StandardTokenMock } from "@utils/contracts/index";
import { IUniswapV2Router } from "../../../typechain";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Sushiswap,
  Quickswap,
  UniV3,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceLeveraged - Integration Test", async () => {
    // Polygon mainnet addresses
    const eth2xFliAddress: Address = "0x3ad707da309f3845cd602059901e39c4dcd66473";
    const iEthFliPAddress: Address = "0x4f025829C4B13dF652f38Abd2AB901185fF1e609";

    const wethAmAddress: Address = "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390";
    const usdcAmAddress: Address = "0x1a13f4ca1d028320a707d99520abfefca3998b7f";
    const wethAddress: Address = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
    const usdcAddress: Address = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

    const quickswapRouterAddress: Address = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
    const sushiswapRouterAddress: Address = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
    const uniV3RouterAddress: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const uniV3QuoterAddress: Address = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
    const daiAddress: Address = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";
    const wmaticAddress: Address = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
    const controllerAddress: Address = "0x75FBBDEAfE23a48c0736B2731b956b7a03aDcfB2";
    const debtIssuanceModuleAddress: Address = "0xf2dC2f456b98Af9A6bEEa072AF152a7b0EaA40C9";
    const aaveeAddressProviderAddress: Address = "0xd05e3E715d945B59290df0ae8eF85c1BdB684744";
    const aaveLeverageModuleAddress: Address = "0xB7F72e15239197021480EB720E1495861A1ABdce";
    const curveCalculatorAddress: Address = "0xc1DB00a8E5Ef7bfa476395cdbcc98235477cDE4E";
    const curveAddressProviderAddress: Address = "0x0000000022D53366457F9d5E68Ec105046FC4383";

    const setTokenAddresses: Record<string, Address> = {
      eth2xFli: eth2xFliAddress,
      iEthFli: iEthFliPAddress,
    };
    const collateralATokenAddresses: Record<string, Address> = {
      eth2xFli: wethAmAddress,
      iEthFli: usdcAmAddress,
    };
    let collateralATokenAddress: Address;

    const collateralTokenAddresses: Record<string, Address> = {
      eth2xFli: wethAddress,
      iEthFli: usdcAddress,
    };
    let collateralTokenAddress: Address;

    const debtTokenAddresses: Record<string, Address> = {
      eth2xFli: usdcAddress,
      iEthFli: wethAddress,
    };
    let debtTokenAddress: Address;

    const setTokenExchangeMapping: Record<string, Exchange[]> = {
      eth2xFli: [Exchange.UniV3],
      iEthFli: [Exchange.Sushiswap],
    };

    let owner: Account;
    let setToken: SetToken;
    let collateralToken: StandardTokenMock;
    let dai: StandardTokenMock;
    let deployer: DeployHelper;
    let setV2Setup: SetFixture;
    let sushiRouter: IUniswapV2Router;

    let subjectSetToken: Address;
    let subjectSetAmount: BigNumber;

    let ethToSpend: BigNumber;

    before(async () => {
      [owner] = await getAccounts();
      deployer = new DeployHelper(owner.wallet);
      setV2Setup = getSetFixture(owner.address);
      await setV2Setup.initialize();
    });

    context("When exchange issuance is deployed", () => {
      let exchangeIssuance: ExchangeIssuanceLeveraged;
      before(async () => {
        exchangeIssuance = await deployer.extensions.deployExchangeIssuanceLeveraged(
          wmaticAddress,
          quickswapRouterAddress,
          sushiswapRouterAddress,
          uniV3RouterAddress,
          uniV3QuoterAddress,
          controllerAddress,
          debtIssuanceModuleAddress,
          aaveLeverageModuleAddress,
          aaveeAddressProviderAddress,
          curveCalculatorAddress,
          curveAddressProviderAddress,
        );

        dai = (await ethers.getContractAt("StandardTokenMock", daiAddress)) as StandardTokenMock;

        sushiRouter = (await ethers.getContractAt(
          "IUniswapV2Router",
          sushiswapRouterAddress,
        )) as IUniswapV2Router;

        const ownerBalance = await owner.wallet.getBalance();
        ethToSpend = ownerBalance.div(20);
      });

      it("verify state set properly via constructor", async () => {
        const addresses = await exchangeIssuance.addresses();
        expect(addresses.weth).to.eq(utils.getAddress(wmaticAddress));

        expect(addresses.sushiRouter).to.eq(utils.getAddress(sushiswapRouterAddress));

        const expectedControllerAddress = await exchangeIssuance.setController();
        expect(expectedControllerAddress).to.eq(utils.getAddress(controllerAddress));

        const expectedDebtIssuanceModuleAddress = await exchangeIssuance.debtIssuanceModule();
        expect(expectedDebtIssuanceModuleAddress).to.eq(
          utils.getAddress(debtIssuanceModuleAddress),
        );
      });

      ["eth2xFli", "iEthFli"].forEach(setTokenName => {
        describe(`when the setToken is ${setTokenName}`, async () => {
          before(async () => {
            subjectSetToken = ethers.utils.getAddress(setTokenAddresses[setTokenName]);
            collateralATokenAddress = ethers.utils.getAddress(
              collateralATokenAddresses[setTokenName],
            );
            collateralTokenAddress = ethers.utils.getAddress(
              collateralTokenAddresses[setTokenName],
            );
            debtTokenAddress = ethers.utils.getAddress(debtTokenAddresses[setTokenName]);

            setToken = (await ethers.getContractAt("ISetToken", subjectSetToken)) as SetToken;
            collateralToken = (await ethers.getContractAt(
              "StandardTokenMock",
              collateralTokenAddress,
            )) as StandardTokenMock;

            subjectSetAmount = utils.parseEther("1.2345");

            await exchangeIssuance.approveSetToken(subjectSetToken);
          });

          it("fli token should return correct components", async () => {
            const components = await setToken.getComponents();
            expect(components[0]).to.equal(collateralATokenAddress);
            expect(components[1]).to.equal(debtTokenAddress);
          });

          setTokenExchangeMapping[setTokenName].forEach(exchange => {
            describe(`when the exchange is ${Exchange[exchange]}`, () => {
              context("Payment Token: ERC20", () => {
                let pricePaid: BigNumber;
                let inputToken: StandardTokenMock;
                let subjectInputToken: Address;
                let subjectDebtForCollateralSwapData: SwapData;
                let subjectInputTokenSwapData: SwapData;

                context("#issueExactSetFromERC20", () => {
                  let subjectMaxAmountInput: BigNumber;
                  before(async () => {
                    inputToken = dai;
                    subjectInputToken = inputToken.address;
                    await sushiRouter.swapExactETHForTokens(
                      ZERO,
                      [wmaticAddress, subjectInputToken],
                      owner.address,
                      MAX_UINT_256,
                      { value: ethToSpend },
                    );
                    subjectMaxAmountInput = await inputToken.balanceOf(owner.address);
                    await inputToken.approve(exchangeIssuance.address, subjectMaxAmountInput);

                    subjectDebtForCollateralSwapData = {
                      path: [debtTokenAddress, collateralTokenAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };
                    subjectInputTokenSwapData = {
                      path: [inputToken.address, wmaticAddress, collateralTokenAddress],
                      fees: [3000, 500],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };
                  });
                  async function subject() {
                    return await exchangeIssuance.issueExactSetFromERC20(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectInputToken,
                      subjectMaxAmountInput,
                      subjectDebtForCollateralSwapData,
                      subjectInputTokenSwapData,
                    );
                  }
                  it("should update balance correctly", async () => {
                    const inputBalanceBefore = await inputToken.balanceOf(owner.address);
                    const setBalanceBefore = await setToken.balanceOf(owner.address);
                    await subject();
                    const setBalanceAfter = await setToken.balanceOf(owner.address);
                    const inputBalanceAfter = await inputToken.balanceOf(owner.address);
                    pricePaid = inputBalanceBefore.sub(inputBalanceAfter);
                    expect(setBalanceAfter.sub(setBalanceBefore)).to.eq(subjectSetAmount);
                  });
                });

                context("#redeemExactSetForERC20", () => {
                  let subjectMinAmountOutput: BigNumber;
                  let outputToken: StandardTokenMock;
                  let subjectOutputToken: Address;
                  let subjectCollateralForDebtSwapData: SwapData;
                  let subjectOutputTokenSwapData: SwapData;
                  before(async () => {
                    // Check to avoid running test when issuance failed and there are no tokens to redeem
                    expect(pricePaid.gt(0)).to.be.true;
                    subjectMinAmountOutput = pricePaid.div(100);
                    setToken.approve(exchangeIssuance.address, subjectSetAmount);
                    outputToken = dai;
                    subjectOutputToken = outputToken.address;

                    subjectCollateralForDebtSwapData = {
                      path: [collateralTokenAddress, debtTokenAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };

                    subjectOutputTokenSwapData = {
                      path: [collateralTokenAddress, subjectOutputToken],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };
                  });

                  async function subject() {
                    return await exchangeIssuance.redeemExactSetForERC20(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectOutputToken,
                      subjectMinAmountOutput,
                      subjectCollateralForDebtSwapData,
                      subjectOutputTokenSwapData,
                    );
                  }
                  it("should update balance correctly", async () => {
                    const outputBalanceBefore = await outputToken.balanceOf(owner.address);
                    const setBalanceBefore = await setToken.balanceOf(owner.address);
                    expect(setBalanceBefore.gte(subjectSetAmount)).to.be.true;
                    await subject();
                    const setBalanceAfter = await setToken.balanceOf(owner.address);
                    const outputBalanceAfter = await outputToken.balanceOf(owner.address);
                    expect(setBalanceBefore.sub(setBalanceAfter)).to.eq(subjectSetAmount);
                    expect(outputBalanceAfter.sub(outputBalanceBefore).gte(subjectMinAmountOutput))
                      .to.be.true;
                  });
                });
              });
              context("Payment Token: ETH", () => {
                let pricePaid: BigNumber;
                let subjectDebtForCollateralSwapData: SwapData;
                let subjectInputTokenSwapData: SwapData;

                context("#issueExactSetFromETH", () => {
                  let subjectMaxAmountInput: BigNumber;
                  before(async () => {
                    subjectMaxAmountInput = ethToSpend;

                    subjectDebtForCollateralSwapData = {
                      path: [debtTokenAddress, collateralTokenAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };

                    subjectInputTokenSwapData = {
                      path: [wmaticAddress, collateralTokenAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };
                  });
                  async function subject() {
                    return await exchangeIssuance.issueExactSetFromETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectDebtForCollateralSwapData,
                      subjectInputTokenSwapData,
                      { value: subjectMaxAmountInput },
                    );
                  }
                  it("should update balance correctly", async () => {
                    const maticBalanceBefore = await owner.wallet.getBalance();
                    const setBalanceBefore = await setToken.balanceOf(owner.address);
                    await subject();
                    const setBalanceAfter = await setToken.balanceOf(owner.address);
                    const maticBalanceAfter = await owner.wallet.getBalance();
                    pricePaid = maticBalanceBefore.sub(maticBalanceAfter);
                    expect(setBalanceAfter.sub(setBalanceBefore)).to.eq(subjectSetAmount);
                  });
                });

                context("#redeemExactSetForETH", () => {
                  let subjectMinAmountOutput: BigNumber;
                  let subjectCollateralForDebtSwapData: SwapData;
                  let subjectOutputTokenSwapData: SwapData;

                  before(async () => {
                    // Check to avoid running test when issuance failed and there are no tokens to redeem
                    expect(pricePaid.gt(0)).to.be.true;
                    subjectMinAmountOutput = pricePaid.div(10);
                    setToken.approve(exchangeIssuance.address, subjectSetAmount);

                    subjectCollateralForDebtSwapData = {
                      path: [collateralTokenAddress, debtTokenAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };

                    subjectOutputTokenSwapData = {
                      path: [collateralTokenAddress, wmaticAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };
                  });
                  async function subject() {
                    return await exchangeIssuance.redeemExactSetForETH(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectMinAmountOutput,
                      subjectCollateralForDebtSwapData,
                      subjectOutputTokenSwapData,
                    );
                  }
                  it("should update balance correctly", async () => {
                    const maticBalanceBefore = await owner.wallet.getBalance();
                    const setBalanceBefore = await setToken.balanceOf(owner.address);
                    expect(setBalanceBefore.gte(subjectSetAmount)).to.be.true;
                    await subject();
                    const setBalanceAfter = await setToken.balanceOf(owner.address);
                    const maticBalanceAfter = await owner.wallet.getBalance();
                    expect(setBalanceBefore.sub(setBalanceAfter)).to.eq(subjectSetAmount);
                    expect(maticBalanceAfter.sub(maticBalanceBefore).gte(subjectMinAmountOutput)).to
                      .be.true;
                  });
                });
              });
              context("Payment Token: CollateralToken", () => {
                let pricePaid: BigNumber;

                context("#issueExactSetFromERC20", () => {
                  let subjectMaxAmountInput: BigNumber;
                  let subjectInputToken: Address;
                  let subjectDebtForCollateralSwapData: SwapData;
                  let subjectInputTokenSwapData: SwapData;

                  before(async () => {
                    const collateralToken = dai.attach(collateralTokenAddress);
                    await sushiRouter.swapExactETHForTokens(
                      ZERO,
                      [wmaticAddress, collateralTokenAddress],
                      owner.address,
                      MAX_UINT_256,
                      { value: ethToSpend },
                    );
                    subjectMaxAmountInput = await collateralToken.balanceOf(owner.address);
                    subjectInputToken = collateralTokenAddress;

                    const path =
                      exchange == Exchange.UniV3
                        ? [debtTokenAddress, wmaticAddress, collateralTokenAddress]
                        : [debtTokenAddress, collateralTokenAddress];
                    const fees = exchange == Exchange.UniV3 ? [3000, 3000] : [];
                    subjectDebtForCollateralSwapData = {
                      path,
                      fees,
                      pool: ADDRESS_ZERO,
                      exchange,
                    };

                    subjectInputTokenSwapData = {
                      path: [],
                      fees: [],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };

                    await collateralToken.approve(exchangeIssuance.address, subjectMaxAmountInput);
                  });
                  async function subject() {
                    return await exchangeIssuance.issueExactSetFromERC20(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectInputToken,
                      subjectMaxAmountInput,
                      subjectDebtForCollateralSwapData,
                      subjectInputTokenSwapData,
                    );
                  }
                  it("should update balance correctly", async () => {
                    const collateralTokenBalanceBefore = await collateralToken.balanceOf(
                      owner.address,
                    );
                    const setBalanceBefore = await setToken.balanceOf(owner.address);
                    await subject();
                    const setBalanceAfter = await setToken.balanceOf(owner.address);
                    const collateralTokenBalanceAfter = await collateralToken.balanceOf(
                      owner.address,
                    );
                    pricePaid = collateralTokenBalanceBefore.sub(collateralTokenBalanceAfter);
                    expect(setBalanceAfter.sub(setBalanceBefore)).to.eq(subjectSetAmount);
                  });
                });

                context("#redeemExactSetForERC20", () => {
                  let subjectMinAmountOutput: BigNumber;
                  let subjectOutputToken: Address;
                  let subjectCollateralForDebtSwapData: SwapData;
                  let subjectOutputTokenSwapData: SwapData;
                  before(async () => {
                    // Check to avoid running test when issuance failed and there are no tokens to redeem
                    expect(pricePaid.gt(0)).to.be.true;
                    subjectMinAmountOutput = pricePaid.div(2);
                    subjectOutputToken = collateralToken.address;
                    setToken.approve(exchangeIssuance.address, subjectSetAmount);

                    subjectCollateralForDebtSwapData = {
                      path: [collateralTokenAddress, debtTokenAddress],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };

                    subjectOutputTokenSwapData = {
                      path: [collateralTokenAddress, subjectOutputToken],
                      fees: [3000],
                      pool: ADDRESS_ZERO,
                      exchange,
                    };
                  });
                  async function subject() {
                    return await exchangeIssuance.redeemExactSetForERC20(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectOutputToken,
                      subjectMinAmountOutput,
                      subjectCollateralForDebtSwapData,
                      subjectOutputTokenSwapData,
                    );
                  }
                  it("should update balance correctly", async () => {
                    const collateralTokenBalanceBefore = await collateralToken.balanceOf(
                      owner.address,
                    );
                    const setBalanceBefore = await setToken.balanceOf(owner.address);
                    expect(setBalanceBefore.gte(subjectSetAmount)).to.be.true;
                    await subject();
                    const setBalanceAfter = await setToken.balanceOf(owner.address);
                    const collateralTokenBalanceAfter = await collateralToken.balanceOf(
                      owner.address,
                    );
                    expect(setBalanceBefore.sub(setBalanceAfter)).to.eq(subjectSetAmount);
                    expect(
                      collateralTokenBalanceAfter
                        .sub(collateralTokenBalanceBefore)
                        .gte(subjectMinAmountOutput),
                    ).to.be.true;
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}
