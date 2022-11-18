import "module-alias/register";
import { BigNumber, BigNumberish, Signer } from "ethers";
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
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
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
            notionalProxy.address,
            addresses.lending.notional.wrappedfCashFactory,
            underlyingToken,
            assetTokenContract.address,
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

            expect(absoluteMaturities).to.have.same.members(componentMaturities);
          });
        });

        describe("#rebalanceCalls", () => {
          const subjectShare = ethers.utils.parseEther("0.9");
          function subject() {
            return rolloverExtension.rebalanceCalls(subjectShare);
          }
          it("should work", async () => {
            await subject();
          });
          describe("when positions differ from target", () => {
            const redeemPositionIndex = 1;
            beforeEach(async () => {
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
            });
            it("should work", async () => {
              const calls = await subject();
              const { setToken, currencyId, maturity, mintAmount, sendToken, maxSendAmount } =
                calls.find((element: any): boolean => element.setToken != ADDRESS_ZERO) ?? calls[0];
              await notionalTradeModule.mintFixedFCashForToken(
                setToken,
                currencyId,
                maturity,
                mintAmount,
                sendToken,
                maxSendAmount,
              );
            });
          });
        });

        describe("#rebalance", () => {
          const subjectShare = ethers.utils.parseEther("0.9");
          function subject() {
            return rolloverExtension.rebalance(subjectShare);
          }
          describe("when fcash position are correct", () => {
            beforeEach(async () => {
              await setToken.connect(operator).setManager(baseManagerV2.address);
            });
            it("should work", async () => {
              await subject();
            });
          });
          describe("when fcash position was reduced", () => {
            const redeemPositionIndex = 1;
            beforeEach(async () => {
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
              await setToken.connect(operator).setManager(baseManagerV2.address);
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
            expect(shortfallPositions).to.deep.equal([ZERO, ZERO]);
            expect(absoluteMaturities.map((bn: BigNumber) => bn.toNumber())).to.have.same.members(
              componentMaturities,
            );
          });
          describe("when first position has matured", () => {
            beforeEach(async () => {
              const componentsBefore = await setToken.getComponents();
              const componentMaturities = (await Promise.all(
                componentsBefore.map(c => {
                  const wrappedfCash = IWrappedfCashComplete__factory.connect(c, operator);
                  return wrappedfCash.getMaturity();
                }),
              )) as number[];
              const firstMaturity = Math.min(...componentMaturities);
              await network.provider.send("evm_setNextBlockTimestamp", [firstMaturity + 1]);
              await network.provider.send("evm_mine");
              await notionalTradeModule.redeemMaturedPositions(setToken.address);
            });
            it("should work", async () => {
              const [shortfallPositions, absoluteMaturities] = await subject();

              const nonMaturedMaturity = new Date("2023-03-24T00:00:00.000Z").getTime() / 1000;
              const nonMaturedPositionIndex = absoluteMaturities.findIndex(
                (m: BigNumber) => m.toNumber() == nonMaturedMaturity,
              );
              expect(shortfallPositions[nonMaturedPositionIndex]).to.equal(ZERO);

              const newMaturity = new Date("2023-06-22T00:00:00.000Z").getTime() / 1000;
              const newPositionIndex = absoluteMaturities.findIndex(
                (m: BigNumber) => m.toNumber() == newMaturity,
              );
              expect(shortfallPositions[newPositionIndex]).to.be.gt(ZERO);
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
