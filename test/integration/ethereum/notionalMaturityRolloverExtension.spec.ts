import "module-alias/register";
import { BigNumberish, Signer } from "ethers";
import { network } from "hardhat";
import { Address } from "@utils/types";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import { ethers } from "hardhat";

import { getAccounts, getWaffleExpect } from "@utils/index";
import {
  BaseManagerV2,
  NotionalMaturityRolloverExtension,
  INotionalTradeModule,
  INotionalTradeModule__factory,
  SetToken__factory,
  IWrappedfCashComplete__factory,
  IERC20__factory,
  IERC20,
  INotionalProxy,
  INotionalProxy__factory,
} from "../../../typechain";
import { ADDRESS_ZERO } from "@utils/constants";
import { PRODUCTION_ADDRESSES } from "./addresses";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe("NotionalMaturityRolloverExtension", () => {
    let deployer: DeployHelper;
    let operator: Signer;
    let setToken: SetToken;
    let notionalTradeModule: INotionalTradeModule;
    let componentMaturities: number[];
    let componentPositions: any[];
    let notionalProxy: INotionalProxy;

    const addresses = PRODUCTION_ADDRESSES;

    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      const [owner] = await getAccounts();
      setToken = SetToken__factory.connect(addresses.tokens.fixedDai, owner.wallet);
      const operatorAddress = await setToken.manager();
      operator = await impersonateAccount(operatorAddress);
      notionalProxy = INotionalProxy__factory.connect(
        addresses.lending.notional.notionalV2,
        operator,
      );
      notionalTradeModule = INotionalTradeModule__factory.connect(
        addresses.setFork.notionalTradeModule,
        operator,
      );
      const minLendRate = 0;
      const currencyId = 2;
      const maturity = 1679616000;
      const quoteInput = ethers.utils.parseUnits("1", 8);
      const blockTime = (await ethers.provider.getBlock("latest")).timestamp;
      const [
        depositAmountUnderlying,
        depositAmountAsset,
      ] = await notionalProxy.getDepositFromfCashLend(
        currencyId,
        quoteInput,
        maturity,
        minLendRate,
        blockTime,
      );
      console.log("notionalQuoteAtTheBeginning", {
        depositAmountUnderlying: ethers.utils.formatEther(depositAmountUnderlying.toString()),
        depositAmountAsset: ethers.utils.formatUnits(depositAmountAsset, 8),
      });

      componentMaturities = await Promise.all(
        (await setToken.getComponents()).map(c => {
          const wrappedfCash = IWrappedfCashComplete__factory.connect(c, operator);
          return wrappedfCash.getMaturity();
        }),
      );

      componentPositions = await setToken.getPositions();

      setToken.connect(operator);

      deployer = new DeployHelper(operator);
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    describe("When token control is transferred to manager contract", () => {
      let baseManagerV2: BaseManagerV2;

      beforeEach(async () => {
        baseManagerV2 = await deployer.manager.deployBaseManagerV2(
          setToken.address,
          await operator.getAddress(),
          await operator.getAddress(),
        );
        await baseManagerV2.authorizeInitialization();
        // await setToken.connect(operator).setManager(baseManagerV2.address);
      });
      describe("When extension is deployed", () => {
        let rolloverExtension: NotionalMaturityRolloverExtension;
        let validMaturities: BigNumberish[];
        let maturities: BigNumberish[];
        let allocations: BigNumberish[];
        let underlyingToken: Address;
        let assetToken: Address;
        let currencyId: number;
        let assetTokenContract: IERC20;
        beforeEach(async () => {
          underlyingToken = addresses.tokens.dai;
          assetToken = addresses.tokens.cDAI;
          assetTokenContract = IERC20__factory.connect(assetToken, operator);
          const maturitiesMonths = [3, 6];
          maturities = maturitiesMonths.map(m => m * 30 * 24 * 60 * 60);
          validMaturities = maturities;
          allocations = [ether(0.25), ether(0.75)];
          rolloverExtension = await deployer.extensions.deployNotionalMaturityRolloverExtension(
            baseManagerV2.address,
            setToken.address,
            addresses.setFork.notionalTradeModule,
            addresses.lending.notional.notionalV2,
            addresses.lending.notional.wrappedfCashFactory,
            underlyingToken,
            assetToken,
            maturities,
            allocations,
            validMaturities,
          );
          await baseManagerV2.connect(operator).addExtension(rolloverExtension.address);
          currencyId = await rolloverExtension.currencyId();
        });

        describe("#getAbsoluteMaturities", () => {
          function subject() {
            return rolloverExtension.getAbsoluteMaturities();
          }
          it("should work", async () => {
            const absoluteMaturities = (await subject()).map((bn: any) => bn.toNumber());
            console.log(
              "absoluteMaturities",
              absoluteMaturities.map((n: any) => new Date(n * 1000)),
            );
            console.log(
              "componentMaturities",
              componentMaturities.map((n: any) => new Date(n * 1000)),
            );

            expect(absoluteMaturities).to.have.same.members(componentMaturities);
          });
        });

        describe("#rebalanceCalls", () => {
          function subject() {
            return rolloverExtension.rebalanceCalls();
          }
          it("should work", async () => {
            const calls = await subject();
            console.log("calls", calls);
          });
          describe("when positions differ from target", () => {
            const redeemPositionIndex = 1;
            beforeEach(async () => {
              console.log(
                "componentPositions before",
                componentPositions.map((p: any) => {
                  return { component: p.component, unit: p.unit.toString() };
                }),
              );
              const wrappedfCash = IWrappedfCashComplete__factory.connect(
                componentPositions[redeemPositionIndex].component,
                operator,
              );
              const maturity = await wrappedfCash.getMaturity();
              const quoteInput = ethers.utils.parseUnits("1", 8);
              const previewRedeem = await wrappedfCash.previewRedeem(quoteInput);
              console.log("PreviewRedeem before", {
                quoteInput: quoteInput.toString(),
                previewRedeem: previewRedeem.toString(),
              });

              const minLendRate = 0;
              const blockTime = (await ethers.provider.getBlock("latest")).timestamp;
              const [
                depositAmountUnderlying,
                depositAmountAsset,
              ] = await notionalProxy.getDepositFromfCashLend(
                currencyId,
                quoteInput,
                maturity,
                minLendRate,
                blockTime,
              );
              console.log("notionalQuoteBefore", {
                depositAmountUnderlying: depositAmountUnderlying.toString(),
                depositAmountAsset: depositAmountAsset.toString(),
              });

              await notionalTradeModule
                .connect(operator)
                .redeemFixedFCashForToken(
                  setToken.address,
                  currencyId,
                  componentMaturities[redeemPositionIndex],
                  componentPositions[redeemPositionIndex].unit,
                  assetToken,
                  0,
                );
              console.log(
                "componentPositions after",
                (await setToken.getPositions()).map((p: any) => {
                  return { component: p.component, unit: p.unit.toString() };
                }),
              );
              console.log(
                "assetTokenBalance",
                (await assetTokenContract.balanceOf(setToken.address)).toString(),
              );
            });
            it("should work", async () => {
              const totalFCashPosition = await rolloverExtension.getTotalFCashPosition();
              console.log("totalFCashPosition", totalFCashPosition.toString());
              const calls = await subject();
              console.log(
                "Calls",
                calls.map((c: any) => {
                  return {
                    setToken: c.setToken,
                    currencyId: c.currencyId,
                    maturity: new Date(c.maturity * 1000),
                    mintAmount: c.mintAmount.toString(),
                    sendToken: c.sendToken,
                    maxSendAmount: c.maxSendAmount.toString(),
                  };
                }),
              );
              const {
                setToken,
                currencyId,
                maturity,
                mintAmount,
                sendToken,
                maxSendAmount,
              } = calls.find((element: any): boolean => element.setToken != ADDRESS_ZERO) ?? calls[0];
              console.log("Call to execute", {
                setToken,
                currencyId,
                maturity: new Date(maturity * 1000),
                mintAmount: mintAmount.toString(),
                sendToken,
                maxSendAmount: maxSendAmount.toString(),
              });

              await notionalTradeModule.mintFixedFCashForToken(
                setToken,
                currencyId,
                maturity,
                mintAmount.mul(99).div(100),
                sendToken,
                maxSendAmount,
              );
            });
          });
        });

        describe("#rebalance", () => {
          function subject() {
            return rolloverExtension.rebalance();
          }
          it("should work", async () => {
            await subject();
          });
          describe("when first position has matured", () => {
            beforeEach(async () => {
              const componentsBefore = await setToken.getComponents();
              const positionsBefore = await Promise.all(
                componentsBefore.map(c => setToken.getDefaultPositionRealUnit(c)),
              );
              console.log(
                "positionsBefore",
                positionsBefore.map((n: any) => n.toString()),
              );
              console.log("componentsBefore", componentsBefore);
              const componentMaturities = (await Promise.all(
                componentsBefore.map(c => {
                  const wrappedfCash = IWrappedfCashComplete__factory.connect(c, operator);
                  return wrappedfCash.getMaturity();
                }),
              )) as number[];
              const firstMaturity = Math.min(...componentMaturities);
              console.log("firstMaturity", new Date(firstMaturity * 1000));
              await network.provider.send("evm_setNextBlockTimestamp", [firstMaturity + 1]);
              await network.provider.send("evm_mine");
              await notionalTradeModule.redeemMaturedPositions(setToken.address);

              const componentsAfter = await setToken.getComponents();
              const positionsAfter = await Promise.all(
                componentsAfter.map(c => setToken.getDefaultPositionRealUnit(c)),
              );
              console.log("componentsAfter", componentsAfter);
              console.log(
                "positionsAfter",
                positionsAfter.map((n: any) => n.toString()),
              );
            });
            it("should work", async () => {
              await subject();
            });
          });
        });

        describe("#getShortfalls", () => {
          function subject() {
            return rolloverExtension.getShortfalls();
          }
          it("should work", async () => {
            const [shortfallPositions, absoluteMaturities] = await subject();
            console.log(
              "shortfallPositions",
              shortfallPositions.map((n: any) => n.toString()),
            );
            console.log(
              "absoluteMaturities",
              absoluteMaturities.map((n: any) => new Date(n * 1000)),
            );
          });
          describe("when first position has matured", () => {
            beforeEach(async () => {
              const componentsBefore = await setToken.getComponents();
              const positionsBefore = await Promise.all(
                componentsBefore.map(c => setToken.getDefaultPositionRealUnit(c)),
              );
              console.log(
                "positionsBefore",
                positionsBefore.map((n: any) => n.toString()),
              );
              console.log("componentsBefore", componentsBefore);
              const componentMaturities = (await Promise.all(
                componentsBefore.map(c => {
                  const wrappedfCash = IWrappedfCashComplete__factory.connect(c, operator);
                  return wrappedfCash.getMaturity();
                }),
              )) as number[];
              const firstMaturity = Math.min(...componentMaturities);
              console.log("firstMaturity", new Date(firstMaturity * 1000));
              await network.provider.send("evm_setNextBlockTimestamp", [firstMaturity + 1]);
              await network.provider.send("evm_mine");
              await notionalTradeModule.redeemMaturedPositions(setToken.address);

              const componentsAfter = await setToken.getComponents();
              const positionsAfter = await Promise.all(
                componentsAfter.map(c => setToken.getDefaultPositionRealUnit(c)),
              );
              console.log("componentsAfter", componentsAfter);
              console.log(
                "positionsAfter",
                positionsAfter.map((n: any) => n.toString()),
              );
            });
            it("should work", async () => {
              const [shortfallPositions, absoluteMaturities] = await subject();
              console.log(
                "shortfallPositions",
                shortfallPositions.map((n: any) => n.toString()),
              );
              console.log(
                "absoluteMaturities",
                absoluteMaturities.map((n: any) => new Date(n * 1000)),
              );
            });
          });
        });

        describe("#getTotalFCashPosition", () => {
          function subject() {
            return rolloverExtension.getTotalFCashPosition();
          }
          it("should work", async () => {
            const totalFCashPosition = await subject();
            const expectedTotalFCashPosition = ethers.utils.parseUnits("100", 8);
            expect(totalFCashPosition).to.eq(expectedTotalFCashPosition);
          });
        });
      });
    });
  });
}
