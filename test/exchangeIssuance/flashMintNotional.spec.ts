import "module-alias/register";
import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";
import { getTxFee } from "@utils/test";
import { Account, Address } from "@utils/types";
import {
  BasicIssuanceModule,
  DebtIssuanceModule,
  FlashMintNotional,
  NotionalTradeModuleMock,
  StandardTokenMock,
  WrappedfCashMock,
  WrappedfCashFactoryMock,
} from "@utils/contracts/index";
import { UniswapV2Router02 } from "@utils/contracts/uniswap";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether, usdc, setEthBalance } from "@utils/index";
import {
  getAccounts,
  getSetFixture,
  getCompoundFixture,
  getWaffleExpect,
  getUniswapFixture,
  getUniswapV3Fixture,
} from "@utils/index";
import { CompoundFixture, SetFixture, UniswapFixture, UniswapV3Fixture } from "@utils/fixtures";
import { ADDRESS_ZERO, MAX_UINT_256 } from "@utils/constants";
import { CERc20 } from "@utils/contracts/compound";

const expect = getWaffleExpect();

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

const emptySwapData: SwapData = {
  path: [],
  fees: [],
  pool: ADDRESS_ZERO,
  exchange: Exchange.None,
};

describe("FlashMintNotional", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let manager: Account;
  let setV2Setup: SetFixture;

  let quickswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let uniswapV3Setup: UniswapV3Fixture;

  let debtIssuanceModule: DebtIssuanceModule;
  let basicIssuanceModule: BasicIssuanceModule;

  let compoundSetup: CompoundFixture;
  let cTokenInitialMantissa: BigNumber;

  let wethAddress: Address;
  let wbtcAddress: Address;
  let daiAddress: Address;
  let quickswapRouter: UniswapV2Router02;
  let sushiswapRouter: UniswapV2Router02;
  let uniswapV3RouterAddress: Address;
  let uniswapV3QuoterAddress: Address;
  let curveCalculatorAddress: Address;
  let curveAddressProviderAddress: Address;

  before(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    debtIssuanceModule = setV2Setup.debtIssuanceModule;
    basicIssuanceModule = setV2Setup.issuanceModule;

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();
    cTokenInitialMantissa = ether(200000000);

    wethAddress = setV2Setup.weth.address;
    wbtcAddress = setV2Setup.wbtc.address;
    daiAddress = setV2Setup.dai.address;

    quickswapSetup = getUniswapFixture(owner.address);
    await quickswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(owner, wethAddress, wbtcAddress, daiAddress);

    uniswapV3Setup = getUniswapV3Fixture(owner.address);
    await uniswapV3Setup.initialize(
      owner,
      setV2Setup.weth,
      3000,
      setV2Setup.wbtc,
      40000,
      setV2Setup.dai,
    );

    uniswapV3RouterAddress = uniswapV3Setup.swapRouter.address;

    quickswapRouter = quickswapSetup.router;
    sushiswapRouter = sushiswapSetup.router;
    curveCalculatorAddress = ADDRESS_ZERO;
    curveAddressProviderAddress = ADDRESS_ZERO;
    uniswapV3QuoterAddress = ADDRESS_ZERO;
  });

  describe("when general mocks are deployed", async () => {
    let wrappedfCashFactoryMock: WrappedfCashFactoryMock;
    let snapshotId: number;
    before(async () => {
      wrappedfCashFactoryMock = await deployer.mocks.deployWrappedfCashFactoryMock();
    });

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });
    describe("When flashMint is deployed", () => {
      let flashMint: FlashMintNotional;
      let notionalTradeModule: NotionalTradeModuleMock;
      let decodedIdGasLimit: BigNumber;
      beforeEach(async () => {
        decodedIdGasLimit = BigNumber.from(10 ** 5);
        notionalTradeModule = await deployer.mocks.deployNotionalTradeModuleMock();
        flashMint = await deployer.extensions.deployFlashMintNotional(
          setV2Setup.weth.address,
          setV2Setup.controller.address,
          wrappedfCashFactoryMock.address,
          notionalTradeModule.address,
          quickswapRouter.address,
          sushiswapRouter.address,
          uniswapV3RouterAddress,
          uniswapV3QuoterAddress,
          curveAddressProviderAddress,
          curveCalculatorAddress,
          decodedIdGasLimit,
        );
      });

      describe("When sending eth to the ei contract", () => {
        it("should revert", async () => {
          await expect(
            owner.wallet.sendTransaction({ value: ether(1), to: flashMint.address }),
          ).to.be.revertedWith("FlashMint: Direct deposits not allowed");
        });
      });

      describe("#withdrawTokens", () => {
        let subjectTokens: Address[];
        let subjectTo: Address;
        let receiver: Account;
        let ethAmount: BigNumber;
        let erc20Amount: BigNumber;
        let erc20Token: StandardTokenMock;
        let caller: Account;
        beforeEach(async () => {
          erc20Token = setV2Setup.dai;
          erc20Amount = ether(2);
          ethAmount = ether(1);
          subjectTokens = [erc20Token.address, await flashMint.ETH_ADDRESS()];
          receiver = manager;
          subjectTo = receiver.address;
          caller = owner;
        });
        function subject() {
          return flashMint.connect(caller.wallet).withdrawTokens(subjectTokens, subjectTo);
        }
        describe("when FlashMintNotional holds funds", () => {
          beforeEach(async () => {
            await erc20Token.transfer(flashMint.address, erc20Amount);
            await setEthBalance(flashMint.address, ethAmount);
          });

          it("should transfer eth", async () => {
            const receiverBalanceBefore = await receiver.wallet.getBalance();
            await subject();
            const receiverBalanceAfter = await receiver.wallet.getBalance();
            expect(receiverBalanceAfter).to.equal(receiverBalanceBefore.add(ethAmount));
          });

          it("should transfer erc20Token", async () => {
            const receiverBalanceBefore = await erc20Token.balanceOf(subjectTo);
            await subject();
            const receiverBalanceAfter = await erc20Token.balanceOf(subjectTo);
            expect(receiverBalanceAfter).to.equal(receiverBalanceBefore.add(erc20Amount));
          });

          describe("when caller is not the owner", () => {
            beforeEach(async () => {
              caller = manager;
            });
            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
            });
          });
        });
      });

      describe("#updateDecodedIdGasLimit", () => {
        let subjectDecodedIdGasLimit: BigNumber;
        let caller: Account;
        beforeEach(async () => {
          subjectDecodedIdGasLimit = (await flashMint.decodedIdGasLimit()).mul(2);
          caller = owner;
        });
        function subject() {
          return flashMint.connect(caller.wallet).updateDecodedIdGasLimit(subjectDecodedIdGasLimit);
        }
        it("should update state correctly", async () => {
          await subject();
          expect(await flashMint.decodedIdGasLimit()).to.eq(subjectDecodedIdGasLimit);
        });

        describe("when caller is not the owner", () => {
          beforeEach(async () => {
            caller = manager;
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
          });
        });

        describe("when new gas limit is 0", () => {
          beforeEach(async () => {
            subjectDecodedIdGasLimit = BigNumber.from(0);
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("DecodedIdGasLimit cannot be zero");
          });
        });
      });

      ["dai", "weth"].forEach(underlyingTokenName => {
        describe(`When underlying token is ${underlyingTokenName}`, () => {
          let assetToken: CERc20;
          let underlyingToken: StandardTokenMock;

          beforeEach(async () => {
            // @ts-ignore
            underlyingToken = setV2Setup[underlyingTokenName];
            assetToken = await compoundSetup.createAndEnableCToken(
              underlyingToken.address,
              cTokenInitialMantissa,
              compoundSetup.comptroller.address,
              compoundSetup.interestRateModel.address,
              "Compound UnderlyingToken",
              "cUNDERLYINGTOKEN",
              8,
              ether(0.75), // 75% collateral factor
              ether(1),
            );
            await underlyingToken.approve(assetToken.address, ethers.constants.MaxUint256);
            await assetToken.mint(ether(100));
          });

          describe("When wrappedFCashMocks are deployed", () => {
            let wrappedfCashMocks: Array<WrappedfCashMock>;
            let underlyingTokenBalance: BigNumber;
            let currencyId: number;
            let maturities: Array<number>;
            beforeEach(async () => {
              const underlyingAddress =
                underlyingToken.address == setV2Setup.weth.address
                  ? ADDRESS_ZERO
                  : underlyingToken.address;
              currencyId = 1;
              maturities = [30, 90];
              wrappedfCashMocks = [];

              for (const maturityDays of maturities) {
                const wrappedfCashMock = await deployer.mocks.deployWrappedfCashMock(
                  assetToken.address,
                  underlyingAddress,
                  setV2Setup.weth.address,
                );

                const maturity =
                  (await ethers.provider.getBlock("latest")).timestamp + maturityDays * 24 * 3600;

                await wrappedfCashMock.initialize(currencyId, maturity);

                await wrappedfCashFactoryMock.registerWrapper(
                  currencyId,
                  maturity,
                  wrappedfCashMock.address,
                );

                underlyingTokenBalance = ether(100);
                await underlyingToken.transfer(owner.address, underlyingTokenBalance);
                await underlyingToken.approve(wrappedfCashMock.address, underlyingTokenBalance);

                await wrappedfCashMock.mintViaUnderlying(
                  underlyingTokenBalance,
                  underlyingTokenBalance,
                  owner.address,
                  0,
                );
                wrappedfCashMocks.push(wrappedfCashMock);
              }
            });
            [true, false].forEach(useDebtIssuance => {
              describe(`When using ${
                useDebtIssuance ? "debtIssuanceModlue" : "basicIssuanceModule"
              }`, () => {
                let issuanceModule: DebtIssuanceModule | BasicIssuanceModule;
                beforeEach(() => {
                  issuanceModule = useDebtIssuance ? debtIssuanceModule : basicIssuanceModule;
                });
                describe("When setToken is deployed", () => {
                  let fCashPosition: BigNumber;
                  let underlyingPosition: BigNumber;
                  let initialSetBalance: BigNumber;
                  let setToken: SetToken;

                  function isDebtIssuance(
                    issuanceModule: DebtIssuanceModule | BasicIssuanceModule,
                  ): issuanceModule is DebtIssuanceModule {
                    return issuanceModule.getRequiredComponentIssuanceUnits != undefined;
                  }
                  beforeEach(async () => {
                    fCashPosition = ethers.utils.parseUnits("2", 9);
                    underlyingPosition = ethers.utils.parseEther("1");

                    setToken = await setV2Setup.createSetToken(
                      [...wrappedfCashMocks.map(mock => mock.address), underlyingToken.address],
                      [...wrappedfCashMocks.map(() => fCashPosition), underlyingPosition],
                      [issuanceModule.address],
                      manager.address,
                    );

                    expect(await setToken.isPendingModule(issuanceModule.address)).to.be.true;

                    if (isDebtIssuance(issuanceModule)) {
                      // Initialize debIssuance module
                      await issuanceModule.connect(manager.wallet).initialize(
                        setToken.address,
                        ether(0.1),
                        ether(0), // No issue fee
                        ether(0), // No redeem fee
                        owner.address,
                        ADDRESS_ZERO,
                      );
                    } else {
                      await issuanceModule
                        .connect(manager.wallet)
                        .initialize(setToken.address, ADDRESS_ZERO);
                    }

                    initialSetBalance = underlyingTokenBalance.div(10);

                    for (const wrappedfCashMock of wrappedfCashMocks) {
                      await underlyingToken.approve(
                        wrappedfCashMock.address,
                        ethers.constants.MaxUint256,
                      );
                      await wrappedfCashMock.setMintTokenSpent(1);
                      await wrappedfCashMock.mintViaUnderlying(
                        0,
                        underlyingTokenBalance,
                        owner.address,
                        0,
                      );
                      await wrappedfCashMock.setMintTokenSpent(0);
                      await wrappedfCashMock.approve(
                        issuanceModule.address,
                        ethers.constants.MaxUint256,
                      );
                    }
                    await assetToken.approve(issuanceModule.address, ethers.constants.MaxUint256);
                    await issuanceModule.issue(setToken.address, initialSetBalance, owner.address);
                  });

                  describe("#getFilteredComponentsRedemptionAfterMaturityRedemption", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let redeemAmount: BigNumber;
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectSlippage = ether(0.00001);
                      redeemAmount = ethers.utils.parseEther("1.5");
                      for (const wrappedfCashMock of wrappedfCashMocks) {
                        await wrappedfCashMock.setRedeemTokenReturned(redeemAmount);
                      }
                    });
                    function subject() {
                      return flashMint.callStatic.getFilteredComponentsRedemptionAfterMaturityRedemption(
                        subjectSetToken,
                        subjectSetAmount,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                        subjectSlippage,
                      );
                    }
                    it("should return correct components", async () => {
                      const [filteredComponents] = await subject();
                      expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                        ethers.utils.getAddress(underlyingToken.address),
                      );
                      expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                    });
                    it("should return correct units", async () => {
                      const [, filteredUnits] = await subject();
                      const expectedAmount = redeemAmount
                        .mul(ether(1).sub(subjectSlippage))
                        .div(ether(1))
                        .mul(wrappedfCashMocks.length)
                        .add(underlyingPosition);
                      expect(filteredUnits[0]).to.eq(expectedAmount);
                    });
                  });

                  describe("#getFilteredComponentsRedemption", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let redeemAmount: BigNumber;
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectSlippage = ether(0.00001);
                      redeemAmount = ethers.utils.parseEther("1.5");
                      for (const wrappedfCashMock of wrappedfCashMocks) {
                        await wrappedfCashMock.setRedeemTokenReturned(redeemAmount);
                      }
                    });
                    function subject() {
                      return flashMint.getFilteredComponentsRedemption(
                        subjectSetToken,
                        subjectSetAmount,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                        subjectSlippage,
                      );
                    }
                    it("should return correct components", async () => {
                      const [filteredComponents] = await subject();
                      expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                        ethers.utils.getAddress(underlyingToken.address),
                      );
                      expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                    });
                    it("should return correct units", async () => {
                      const [, filteredUnits] = await subject();
                      const expectedAmount = redeemAmount
                        .mul(ether(1).sub(subjectSlippage))
                        .div(ether(1))
                        .mul(wrappedfCashMocks.length)
                        .add(underlyingPosition);
                      expect(filteredUnits[0]).to.eq(expectedAmount);
                    });
                    describe("when compute address fails on wrappefCashFactory", () => {
                      beforeEach(async () => {
                        await wrappedfCashFactoryMock.setRevertComputeAddress(true);
                      });
                      it("should return fcash positions as component", async () => {
                        const [filteredComponents] = await subject();
                        expect(filteredComponents).to.deep.equal([
                          ...wrappedfCashMocks.map(mock => mock.address),
                          underlyingToken.address,
                        ]);
                      });
                    });

                    describe("when .isContract returns false fore fCash component", () => {
                      beforeEach(async () => {
                        for (const wrappedfCashMock of wrappedfCashMocks) {
                          await wrappedfCashMock.kill();
                        }
                      });
                      it("should return fcash positions as component", async () => {
                        const [filteredComponents] = await subject();
                        expect(filteredComponents).to.deep.equal([
                          ...wrappedfCashMocks.map(mock => mock.address),
                          underlyingToken.address,
                        ]);
                      });
                    });
                  });

                  describe("#getFilteredComponentsIssuance", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let mintAmount: BigNumber;
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectSlippage = ether(0.00001);
                      mintAmount = ethers.utils.parseEther("1");
                      for (const wrappedfCashMock of wrappedfCashMocks) {
                        await wrappedfCashMock.setMintTokenSpent(mintAmount);
                      }
                    });
                    function subject() {
                      return flashMint.getFilteredComponentsIssuance(
                        subjectSetToken,
                        subjectSetAmount,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                        subjectSlippage,
                      );
                    }
                    it("should return correct components", async () => {
                      const [filteredComponents] = await subject();
                      expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                        ethers.utils.getAddress(underlyingToken.address),
                      );
                      expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                    });
                    it("should return correct units", async () => {
                      const [, filteredUnits] = await subject();
                      const expectedAmount = mintAmount
                        .mul(ether(1).add(subjectSlippage))
                        .div(ether(1))
                        .mul(wrappedfCashMocks.length)
                        .add(underlyingPosition);
                      expect(filteredUnits[0]).to.eq(expectedAmount);
                    });
                  });

                  describe("#getFilteredComponentsIssuanceAfterMaturityRedemption", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let mintAmount: BigNumber;
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectSlippage = ether(0.00001);
                      mintAmount = ethers.utils.parseEther("1");
                      for (const wrappedfCashMock of wrappedfCashMocks) {
                        await wrappedfCashMock.setMintTokenSpent(mintAmount);
                      }
                    });
                    function subject() {
                      return flashMint.callStatic.getFilteredComponentsIssuanceAfterMaturityRedemption(
                        subjectSetToken,
                        subjectSetAmount,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                        subjectSlippage,
                      );
                    }
                    it("should return correct components", async () => {
                      const [filteredComponents] = await subject();
                      expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                        ethers.utils.getAddress(underlyingToken.address),
                      );
                      expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                    });
                    it("should return correct units", async () => {
                      const [, filteredUnits] = await subject();
                      const expectedAmount = mintAmount
                        .mul(ether(1).add(subjectSlippage))
                        .div(ether(1))
                        .mul(wrappedfCashMocks.length)
                        .add(underlyingPosition);
                      expect(filteredUnits[0]).to.eq(expectedAmount);
                    });
                  });

                  describe("#issueExactSetFromETH", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMaxAmountInputToken: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let subjectRedemMaturedPositions: boolean;
                    let caller: Account;

                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectSlippage = ether(0.0001);
                      subjectRedemMaturedPositions = true;
                      caller = owner;

                      const [
                        filteredComponents,
                        filteredUnits,
                      ] = await flashMint.getFilteredComponentsRedemption(
                        subjectSetToken,
                        subjectSetAmount,
                        subjectIssuanceModule,
                        subjectIsDebtIssuance,
                        subjectSlippage,
                      );
                      subjectComponentQuotes = filteredComponents.map((component: Address) => {
                        return {
                          path: [setV2Setup.weth.address, component],
                          fees: [3000],
                          pool: ADDRESS_ZERO,
                          exchange: Exchange.UniV3,
                        };
                      });
                      if (
                        ethers.utils.getAddress(filteredComponents[0]) !=
                        ethers.utils.getAddress(setV2Setup.weth.address)
                      ) {
                        subjectMaxAmountInputToken = (await caller.wallet.getBalance()).div(10);
                      } else {
                        subjectMaxAmountInputToken = filteredUnits[0].mul(2);
                      }
                      if (underlyingTokenName != "weth") {
                        const tokenRatio = 3000;
                        await uniswapV3Setup.createNewPair(
                          setV2Setup.weth,
                          underlyingToken,
                          3000,
                          tokenRatio,
                        );
                        await underlyingToken.approve(
                          uniswapV3Setup.nftPositionManager.address,
                          MAX_UINT_256,
                        );
                        await setV2Setup.weth.approve(
                          uniswapV3Setup.nftPositionManager.address,
                          MAX_UINT_256,
                        );
                        const underlyingTokenAmount = 10000;
                        await uniswapV3Setup.addLiquidityWide(
                          setV2Setup.weth,
                          underlyingToken,
                          3000,
                          ether(underlyingTokenAmount),
                          ether(underlyingTokenAmount / tokenRatio),
                          owner.address,
                        );
                      }

                      for (const wrappedfCashMock of wrappedfCashMocks) {
                        await wrappedfCashMock.setMintTokenSpent(10000);
                      }

                      expect(subjectMaxAmountInputToken).to.be.gt(0);
                    });

                    function subject() {
                      return flashMint
                        .connect(caller.wallet)
                        .issueExactSetFromETH(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                          { value: subjectMaxAmountInputToken },
                        );
                    }

                    function subjectCallStatic() {
                      return flashMint
                        .connect(caller.wallet)
                        .callStatic.issueExactSetFromETH(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                          { value: subjectMaxAmountInputToken },
                        );
                    }

                    describe("When setting redeemMaturedPositions to false", () => {
                      beforeEach(() => {
                        subjectRedemMaturedPositions = false;
                      });
                      it("should still work", async () => {
                        await subject();
                      });
                    });

                    describe("When swapData and components are of differing length", () => {
                      beforeEach(() => {
                        subjectComponentQuotes = [];
                      });
                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith(
                          "Components / Swapdata mismatch",
                        );
                      });
                    });

                    describe("When using invalid issuanceModule", () => {
                      beforeEach(() => {
                        subjectIssuanceModule = ADDRESS_ZERO;
                      });
                      it("should revert", async () => {
                        await expect(subject()).to.be.revertedWith(
                          "FlashMint: INVALID ISSUANCE MODULE",
                        );
                      });
                    });

                    it("should issue correct amount of set token", async () => {
                      const balanceBefore = await setToken.balanceOf(caller.address);
                      await subject();
                      const issuedAmount = (await setToken.balanceOf(caller.address)).sub(
                        balanceBefore,
                      );
                      expect(issuedAmount).to.eq(subjectSetAmount);
                    });

                    it("should spend correct amount of input token", async () => {
                      const balanceBefore = await caller.wallet.getBalance();
                      const txFee = await getTxFee(await subject());
                      const spentAmount = balanceBefore
                        .sub(await caller.wallet.getBalance())
                        .sub(txFee);
                      expect(spentAmount).to.be.lte(subjectMaxAmountInputToken);
                    });

                    describe("When subjectMaxAmountInputToken is equal to spent amount", async () => {
                      beforeEach(async () => {
                        subjectMaxAmountInputToken = await subjectCallStatic();
                      });
                      it("should spend correct amount of input token", async () => {
                        const balanceBefore = await caller.wallet.getBalance();
                        const txFee = await getTxFee(await subject());
                        const spentAmount = balanceBefore
                          .sub(await caller.wallet.getBalance())
                          .sub(txFee);
                        expect(spentAmount).to.equal(subjectMaxAmountInputToken);
                      });
                    });
                  });
                  describe("#issueExactSetFromToken", () => {
                    let subjectSetToken: Address;
                    let subjectInputToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMaxAmountInputToken: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let subjectRedemMaturedPositions: boolean;
                    let caller: Account;

                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectComponentQuotes = [];
                      subjectSlippage = ethers.utils.parseEther("0.00001");
                      subjectRedemMaturedPositions = true;
                      caller = owner;
                    });

                    function subject() {
                      return flashMint
                        .connect(caller.wallet)
                        .issueExactSetFromToken(
                          subjectSetToken,
                          subjectInputToken,
                          subjectSetAmount,
                          subjectMaxAmountInputToken,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                        );
                    }

                    function subjectCallStatic() {
                      return flashMint
                        .connect(caller.wallet)
                        .callStatic.issueExactSetFromToken(
                          subjectSetToken,
                          subjectInputToken,
                          subjectSetAmount,
                          subjectMaxAmountInputToken,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                        );
                    }

                    ["underlyingToken", "usdc"].forEach((tokenType: string) => {
                      describe(`When issuing from ${tokenType}`, () => {
                        let inputToken: CERc20 | StandardTokenMock;
                        beforeEach(async () => {
                          inputToken =
                            tokenType == "underlyingToken"
                              ? underlyingToken
                              : // @ts-ignore
                                setV2Setup[tokenType];

                          await inputToken.approve(flashMint.address, ethers.constants.MaxUint256);
                          subjectInputToken = inputToken.address;

                          const [
                            filteredComponents,
                          ] = await flashMint.getFilteredComponentsIssuance(
                            subjectSetToken,
                            subjectSetAmount,
                            subjectIssuanceModule,
                            subjectIsDebtIssuance,
                            subjectSlippage,
                          );
                          subjectComponentQuotes = filteredComponents.map((component: Address) => {
                            return {
                              path: [inputToken.address, component],
                              fees: [3000],
                              pool: ADDRESS_ZERO,
                              exchange: Exchange.UniV3,
                            };
                          });

                          if (tokenType == "usdc") {
                            const tokenRatio = underlyingTokenName == "weth" ? 3000 : 1;
                            await uniswapV3Setup.createNewPair(
                              underlyingToken,
                              setV2Setup.usdc,
                              3000,
                              tokenRatio,
                            );
                            await underlyingToken.approve(
                              uniswapV3Setup.nftPositionManager.address,
                              MAX_UINT_256,
                            );
                            await setV2Setup.usdc.approve(
                              uniswapV3Setup.nftPositionManager.address,
                              MAX_UINT_256,
                            );
                            const underlyingTokenAmount =
                              underlyingTokenName == "weth" ? 100 : 10000;
                            await uniswapV3Setup.addLiquidityWide(
                              underlyingToken,
                              setV2Setup.usdc,
                              3000,
                              ether(underlyingTokenAmount),
                              usdc(underlyingTokenAmount * tokenRatio),
                              owner.address,
                            );
                          }

                          subjectMaxAmountInputToken = await inputToken.balanceOf(caller.address);

                          for (const wrappedfCashMock of wrappedfCashMocks) {
                            await wrappedfCashMock.setMintTokenSpent(10000);
                          }

                          expect(subjectMaxAmountInputToken).to.be.gt(0);
                        });

                        describe("When using invalid issuanceModule", () => {
                          beforeEach(() => {
                            subjectIssuanceModule = ADDRESS_ZERO;
                          });
                          it("should revert", async () => {
                            await expect(subject()).to.be.revertedWith(
                              "FlashMint: INVALID ISSUANCE MODULE",
                            );
                          });
                        });

                        if (tokenType == "underlyingToken") {
                          describe("When spending more than the max amount", async () => {
                            beforeEach(async () => {
                              const spentAmount = await subjectCallStatic();
                              await inputToken.transfer(flashMint.address, spentAmount);
                              subjectMaxAmountInputToken = spentAmount.sub(1);
                            });
                            it("should revert", async () => {
                              await expect(subject()).to.be.revertedWith("FlashMint: OVERSPENT");
                            });
                          });
                        }

                        describe("When subjectMaxAmountInputToken is equal to spent amount", async () => {
                          beforeEach(async () => {
                            subjectMaxAmountInputToken = await subjectCallStatic();
                          });
                          it("should spend correct amount of input token", async () => {
                            const balanceBefore = await inputToken.balanceOf(caller.address);
                            await subject();
                            const spentAmount = balanceBefore.sub(
                              await inputToken.balanceOf(caller.address),
                            );
                            expect(spentAmount).to.equal(subjectMaxAmountInputToken);
                          });
                        });

                        it("should issue correct amount of set token", async () => {
                          const balanceBefore = await setToken.balanceOf(caller.address);
                          await subject();
                          const issuedAmount = (await setToken.balanceOf(caller.address)).sub(
                            balanceBefore,
                          );
                          expect(issuedAmount).to.eq(subjectSetAmount);
                        });

                        it("should spend correct amount of input token", async () => {
                          const balanceBefore = await inputToken.balanceOf(caller.address);
                          await subject();
                          const spentAmount = balanceBefore.sub(
                            await inputToken.balanceOf(caller.address),
                          );
                          expect(spentAmount).to.be.lte(subjectMaxAmountInputToken);
                        });
                      });
                    });
                  });
                  describe("#redeemExactSetForETH", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMinAmountETH: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let subjectRedemMaturedPositions: boolean;
                    let setAmountEth: number;
                    let caller: Account;

                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      setAmountEth = 1;
                      subjectSetAmount = ethers.utils.parseEther(setAmountEth.toString());
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectMinAmountETH = BigNumber.from(1000);
                      subjectSlippage = ether(0.0001);
                      subjectRedemMaturedPositions = false;
                      caller = owner;
                    });

                    function subject() {
                      return flashMint
                        .connect(caller.wallet)
                        .redeemExactSetForETH(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectMinAmountETH,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                        );
                    }
                    describe("When caller has enough set token to redeem", () => {
                      let redeemAmountReturned: BigNumber;
                      beforeEach(async () => {
                        await underlyingToken
                          .connect(caller.wallet)
                          .approve(flashMint.address, ethers.constants.MaxUint256);

                        let [filteredComponents] = await flashMint.getFilteredComponentsIssuance(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                        );
                        const swapData = filteredComponents.map(() => emptySwapData);
                        await flashMint
                          .connect(caller.wallet)
                          .issueExactSetFromToken(
                            setToken.address,
                            underlyingToken.address,
                            subjectSetAmount,
                            await underlyingToken.balanceOf(caller.address),
                            swapData,
                            issuanceModule.address,
                            useDebtIssuance,
                            subjectSlippage,
                            true,
                          );
                        await setToken.approve(flashMint.address, ethers.constants.MaxUint256);

                        redeemAmountReturned = BigNumber.from(1000);

                        for (const wrappedfCashMock of wrappedfCashMocks) {
                          await wrappedfCashMock.setRedeemTokenReturned(redeemAmountReturned);
                          await underlyingToken.transfer(
                            wrappedfCashMock.address,
                            redeemAmountReturned,
                          );
                        }

                        [filteredComponents] = await flashMint.getFilteredComponentsIssuance(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                        );
                        subjectComponentQuotes = filteredComponents.map((component: Address) => {
                          return {
                            path: [component, setV2Setup.weth.address],
                            fees: [3000],
                            pool: ADDRESS_ZERO,
                            exchange: Exchange.UniV3,
                          };
                        });
                        if (underlyingTokenName != "weth") {
                          const tokenRatio = 3000;
                          await uniswapV3Setup.createNewPair(
                            setV2Setup.weth,
                            underlyingToken,
                            3000,
                            tokenRatio,
                          );
                          await underlyingToken.approve(
                            uniswapV3Setup.nftPositionManager.address,
                            MAX_UINT_256,
                          );
                          await setV2Setup.weth.approve(
                            uniswapV3Setup.nftPositionManager.address,
                            MAX_UINT_256,
                          );
                          const underlyingTokenAmount = 10000;
                          await uniswapV3Setup.addLiquidityWide(
                            setV2Setup.weth,
                            underlyingToken,
                            3000,
                            ether(underlyingTokenAmount),
                            ether(underlyingTokenAmount / tokenRatio),
                            owner.address,
                          );
                        }

                        for (const wrappedfCashMock of wrappedfCashMocks) {
                          await wrappedfCashMock.setMintTokenSpent(10000);
                        }
                      });

                      describe("When setting redeemMaturedPositions to false", () => {
                        beforeEach(() => {
                          subjectRedemMaturedPositions = false;
                        });
                        it("should still work", async () => {
                          await subject();
                        });
                      });

                      describe("When using invalid issuanceModule", () => {
                        beforeEach(() => {
                          subjectIssuanceModule = ADDRESS_ZERO;
                        });
                        it("should revert", async () => {
                          await expect(subject()).to.be.revertedWith(
                            "FlashMint: INVALID ISSUANCE MODULE",
                          );
                        });
                      });

                      describe("When swapData and components are of differing length", () => {
                        beforeEach(() => {
                          subjectComponentQuotes = [];
                        });
                        it("should revert", async () => {
                          await expect(subject()).to.be.revertedWith(
                            "Components / Swapdata mismatch",
                          );
                        });
                      });

                      it("should redeem correct amount of set token", async () => {
                        const balanceBefore = await setToken.balanceOf(caller.address);
                        await subject();
                        const redeemedAmount = balanceBefore.sub(
                          await setToken.balanceOf(caller.address),
                        );
                        expect(redeemedAmount).to.eq(subjectSetAmount);
                      });

                      it("should return correct amount of ETH", async () => {
                        const balanceBefore = await caller.wallet.getBalance();
                        const txFee = await getTxFee(await subject());
                        const balanceAfter = await caller.wallet.getBalance();
                        const returnedAmount = balanceAfter.sub(balanceBefore).add(txFee);
                        expect(returnedAmount).to.gte(subjectMinAmountETH);
                      });
                    });
                  });
                  describe("#redeemExactSetForToken", () => {
                    let subjectSetToken: Address;
                    let subjectOutputToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMinAmountOutputToken: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let subjectRedemMaturedPositions: boolean;
                    let caller: Account;
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = issuanceModule.address;
                      subjectIsDebtIssuance = useDebtIssuance;
                      subjectMinAmountOutputToken = BigNumber.from(1000);
                      caller = owner;
                      subjectSlippage = ethers.utils.parseEther("0.00001");
                      subjectRedemMaturedPositions = true;
                    });
                    function subject() {
                      return flashMint
                        .connect(caller.wallet)
                        .redeemExactSetForToken(
                          subjectSetToken,
                          subjectOutputToken,
                          subjectSetAmount,
                          subjectMinAmountOutputToken,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                        );
                    }
                    function subjectCallStatic() {
                      return flashMint
                        .connect(caller.wallet)
                        .callStatic.redeemExactSetForToken(
                          subjectSetToken,
                          subjectOutputToken,
                          subjectSetAmount,
                          subjectMinAmountOutputToken,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          subjectRedemMaturedPositions,
                        );
                    }
                    describe("When caller has enough set token to redeem", () => {
                      beforeEach(async () => {
                        await underlyingToken
                          .connect(caller.wallet)
                          .approve(flashMint.address, ethers.constants.MaxUint256);

                        const [filteredComponents] = await flashMint.getFilteredComponentsIssuance(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                        );
                        const swapData = filteredComponents.map(() => emptySwapData);
                        await flashMint
                          .connect(caller.wallet)
                          .issueExactSetFromToken(
                            setToken.address,
                            underlyingToken.address,
                            subjectSetAmount,
                            await underlyingToken.balanceOf(caller.address),
                            swapData,
                            issuanceModule.address,
                            useDebtIssuance,
                            subjectSlippage,
                            true,
                          );
                        await setToken.approve(flashMint.address, ethers.constants.MaxUint256);
                      });
                      ["underlyingToken", "usdc"].forEach(tokenType => {
                        describe(`When redeeming to ${tokenType}`, () => {
                          let redeemAmountReturned: BigNumber;
                          let outputToken: CERc20 | StandardTokenMock;
                          beforeEach(async () => {
                            outputToken =
                              tokenType == "underlyingToken"
                                ? underlyingToken
                                : // @ts-ignore
                                  setV2Setup[tokenType];
                            subjectOutputToken = outputToken.address;
                            redeemAmountReturned = BigNumber.from(1000);
                            subjectMinAmountOutputToken =
                              tokenType == "underlyingToken"
                                ? redeemAmountReturned
                                : BigNumber.from(1000);

                            for (const wrappedfCashMock of wrappedfCashMocks) {
                              await wrappedfCashMock.setRedeemTokenReturned(redeemAmountReturned);
                              await outputToken.transfer(
                                wrappedfCashMock.address,
                                redeemAmountReturned,
                              );
                            }

                            const [
                              filteredComponents,
                            ] = await flashMint.getFilteredComponentsIssuance(
                              subjectSetToken,
                              subjectSetAmount,
                              subjectIssuanceModule,
                              subjectIsDebtIssuance,
                              subjectSlippage,
                            );
                            subjectComponentQuotes = filteredComponents.map(
                              (component: Address) => {
                                return {
                                  path: [component, outputToken.address],
                                  fees: [3000],
                                  pool: ADDRESS_ZERO,
                                  exchange: Exchange.UniV3,
                                };
                              },
                            );

                            if (tokenType == "usdc") {
                              const tokenRatio = underlyingTokenName == "weth" ? 3000 : 1;
                              await uniswapV3Setup.createNewPair(
                                underlyingToken,
                                setV2Setup.usdc,
                                3000,
                                tokenRatio,
                              );
                              await underlyingToken.approve(
                                uniswapV3Setup.nftPositionManager.address,
                                MAX_UINT_256,
                              );
                              await setV2Setup.usdc.approve(
                                uniswapV3Setup.nftPositionManager.address,
                                MAX_UINT_256,
                              );
                              const underlyingTokenAmount =
                                underlyingTokenName == "weth" ? 100 : 10000;
                              await uniswapV3Setup.addLiquidityWide(
                                underlyingToken,
                                setV2Setup.usdc,
                                3000,
                                ether(underlyingTokenAmount),
                                usdc(underlyingTokenAmount * tokenRatio),
                                owner.address,
                              );
                            }
                          });

                          describe("When obtained amount of output token is less then specified minimum", () => {
                            beforeEach(async () => {
                              const returnedAmount = await subjectCallStatic();
                              subjectMinAmountOutputToken = returnedAmount.add(1);
                            });
                            it("should revert", async () => {
                              await expect(subject()).to.be.revertedWith("FlashMint: UNDERBOUGHT");
                            });
                          });

                          describe("When using invalid issuanceModule", () => {
                            beforeEach(() => {
                              subjectIssuanceModule = ADDRESS_ZERO;
                            });
                            it("should revert", async () => {
                              await expect(subject()).to.be.revertedWith(
                                "FlashMint: INVALID ISSUANCE MODULE",
                              );
                            });
                          });
                          it("should redeem correct amount of set token", async () => {
                            const balanceBefore = await setToken.balanceOf(caller.address);
                            await subject();
                            const redeemedAmount = balanceBefore.sub(
                              await setToken.balanceOf(caller.address),
                            );
                            expect(redeemedAmount).to.eq(subjectSetAmount);
                          });
                          it("should return correct amount of output token", async () => {
                            const balanceBefore = await outputToken.balanceOf(caller.address);
                            await subject();
                            const balanceAfter = await outputToken.balanceOf(caller.address);
                            const returnedAmount = balanceAfter.sub(balanceBefore);
                            expect(returnedAmount).to.gte(subjectMinAmountOutputToken);
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
