import "module-alias/register";
import { BigNumberish, Signer } from "ethers";
import { network } from "hardhat";
import { Address } from "@utils/types";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import { ethers } from "ethers";

import { getAccounts, getWaffleExpect } from "@utils/index";
import {
  BaseManagerV2,
  NotionalMaturityRolloverExtension,
  SetToken__factory,
  IWrappedfCashComplete__factory,
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

    const addresses = PRODUCTION_ADDRESSES;

    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      const [owner] = await getAccounts();
      setToken = SetToken__factory.connect(addresses.tokens.fixedDai, owner.wallet);
      const operatorAddress = await setToken.manager();
      operator = await impersonateAccount(operatorAddress);

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
          ADDRESS_ZERO,
        );
      });
      describe("When extension is deployed", () => {
        let rolloverExtension: NotionalMaturityRolloverExtension;
        let validMaturities: BigNumberish[];
        let maturities: BigNumberish[];
        let allocations: BigNumberish[];
        let underlyingToken: Address;
        let assetToken: Address;
        beforeEach(async () => {
          underlyingToken = addresses.tokens.dai;
          assetToken = addresses.tokens.cDAI;
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
            const expectedMaturities = await Promise.all(
              (await setToken.getComponents()).map(c => {
                const wrappedfCash = IWrappedfCashComplete__factory.connect(c, operator);
                return wrappedfCash.getMaturity();
              }),
            );
            console.log(
              "expectedMaturities",
              expectedMaturities.map((n: any) => new Date(n * 1000)),
            );

            expect(absoluteMaturities).to.have.same.members(expectedMaturities);
          });
        });

        describe("#getShortfalls", () => {
          function subject() {
            return rolloverExtension.getShortfalls();
          }
          it("should work", async () => {
            const shortfalls = await subject();
            console.log("shortfalls", shortfalls.map((n: any) => n.toString()));
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
