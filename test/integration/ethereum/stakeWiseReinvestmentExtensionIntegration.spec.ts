import "module-alias/register";
import { Account } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { ethers, network } from "hardhat";
import { ether, getAccounts, getWaffleExpect } from "@utils/index";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { StakeWiseReinvestmentExtension } from "../../../typechain/StakeWiseReinvestmentExtension";
import { EMPTY_BYTES } from "@utils/constants";
import { AirdropModule } from "@typechain/AirdropModule";
import { BaseManagerV2 } from "@typechain/BaseManagerV2";
import { BigNumberish } from "ethers";
import { SetToken } from "@typechain/SetToken";
import { TradeModule } from "@typechain/TradeModule";

const expect = getWaffleExpect();
const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;

if (process.env.INTEGRATIONTEST) {
  describe("StakeWiseReinvestmentExtension - Integration Test", () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: SetToken;
    let manager: BaseManagerV2;
    let airdropModule: AirdropModule;
    let tradeModule: TradeModule;

    let extension: StakeWiseReinvestmentExtension;
    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      [
        owner,
      ] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "SetToken",
        addresses.setFork.wsETH2,
      )) as SetToken;

      manager = (await ethers.getContractAt(
        "BaseManagerV2",
        addresses.setFork.wsETH2Manager,
      )) as BaseManagerV2;

      airdropModule = (await ethers.getContractAt(
        "AirdropModule",
        addresses.setFork.airdropModule,
      )) as AirdropModule;

      tradeModule = (await ethers.getContractAt(
        "TradeModule",
        addresses.setFork.tradeModule,
      )) as TradeModule;

      await deployStakeWiseReinvestmentExtension();
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    async function deployStakeWiseReinvestmentExtension() {
      extension = await deployer.extensions.deployStakeWiseReinvestmentExtension(
        manager.address,
        airdropModule.address,
        tradeModule.address,
        {
          exchangeName: "UniswapV3ExchangeAdapter",
          exchangeCallData: EMPTY_BYTES,
        },
      );
    }

    describe("#constructor", () => {
      it("should set the correct manager address", async () => {
        expect(await extension.manager()).to.eq(manager.address);
      });

      it("should set the correct airdropModule address", async () => {
        expect(await extension.airdropModule()).to.eq(airdropModule.address);
      });

      it("should set the correct tradeModule address", async () => {
        expect(await extension.tradeModule()).to.eq(tradeModule.address);
      });

      it("should set the correct executionSettings", async () => {
        expect(await extension.settings()).to.eq({
          exchangeName: "",
          exchangeCallData: EMPTY_BYTES,
        });
      });
    });

    describe("#initialize", () => {
      async function subject() {
        return await extension.initialize();
      }

      it("should have 2 initialized modules", async () => {
        await subject();

        const modules = await setToken.getModules();
        expect(modules.length).to.eq(2);

        expect(modules[0]).to.eq(airdropModule.address);
        expect(modules[1]).to.eq(tradeModule.address);
      });

      it("should set initialize AirdropModule Settings", async () => {
        await subject();

        const settings = await airdropModule.airdropSettings(setToken.address);
        expect(settings[0]).to.equal(setToken.address);
        expect(settings[1]).to.equal(0);
        expect(settings[2]).to.equal(false);
      });
    });

    describe("#updateExecutionSettings", () => {
      let exchangeName: string;
      let exchangeCallData: string;

      beforeEach(async () => {
        exchangeName = "Sushiswap";
        exchangeCallData = EMPTY_BYTES;
      });

      async function subject() {
        await extension.updateExecutionSettings({
          exchangeName,
          exchangeCallData,
        });
      }

      it("should have the updated ExecutionSettings", async () => {
        await subject();

        expect(await extension.settings()).to.eq({
          exchangeName,
          exchangeCallData,
        });
      });
    });

    describe("#reinvest", () => {
      let minReceiveQuantity: BigNumberish;

      beforeEach(async () => {
        minReceiveQuantity = ether(1);
      });
      async function subject() {
        await extension.reinvest(minReceiveQuantity);
      }

      it("should absorb and reinvest rETH2 into sETH2", async () => {
        const beforeREth2Units = await setToken.balanceOf(await extension.R_ETH2());
        const beforeSEth2Units = await setToken.getTotalComponentRealUnits(
          await extension.S_ETH2(),
        );

        expect(beforeREth2Units).to.be.greaterThan(0);
        expect(beforeSEth2Units).to.be.greaterThan(0);

        await subject();

        const afterSEth2Units = await setToken.getTotalComponentRealUnits(await extension.S_ETH2());
        const afterREth2Units = await setToken.balanceOf(await extension.R_ETH2());

        expect(afterREth2Units).to.equal(0);
        expect(afterSEth2Units).to.be.greaterThan(beforeSEth2Units.add(minReceiveQuantity));
      });
    });
  });
}
