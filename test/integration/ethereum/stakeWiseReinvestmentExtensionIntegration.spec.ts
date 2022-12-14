import "module-alias/register";
import { ethers, network } from "hardhat";
import { BigNumberish, Signer } from "ethers";

import { Account } from "@utils/types";
import { ether, getAccounts, getWaffleExpect, setEthBalance } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { EMPTY_BYTES } from "@utils/constants";

import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { StakeWiseReinvestmentExtension } from "../../../typechain/StakeWiseReinvestmentExtension";
import { IAirdropModule } from "../../../typechain/IAirdropModule";
import { BaseManagerV2 } from "../../../typechain/BaseManagerV2";
import { ITradeModule } from "../../../typechain/ITradeModule";
import { ISetToken } from "../../../typechain/ISetToken";
import { impersonateAccount } from "./utils";

const expect = getWaffleExpect();
const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;

if (process.env.INTEGRATIONTEST) {
  describe("StakeWiseReinvestmentExtension - Integration Test", () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: ISetToken;
    let manager: BaseManagerV2;
    let airdropModule: IAirdropModule;
    let tradeModule: ITradeModule;
    let operator: Signer;

    let extension: StakeWiseReinvestmentExtension;
    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      [
        owner,
      ] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt(
        "ISetToken",
        addresses.tokens.wsETH2,
      )) as ISetToken;

      console.log(await setToken.connect(owner.wallet).manager());

      manager = (await ethers.getContractAt(
        "BaseManagerV2",
        await setToken.manager(),
      )) as BaseManagerV2;

      const operatorAddress = await manager.operator();

      await setEthBalance(operatorAddress, ether(100));

      operator = await impersonateAccount(operatorAddress);

      airdropModule = (await ethers.getContractAt(
        "IAirdropModule",
        addresses.setFork.airdropModule,
      )) as IAirdropModule;

      tradeModule = (await ethers.getContractAt(
        "ITradeModule",
        addresses.setFork.tradeModule,
      )) as ITradeModule;

      await deployStakeWiseReinvestmentExtension();

      await extension.connect(operator).updateCallerStatus([await operator.getAddress()], [true]);

      // Modules need to first be added through the manager before the extension can initialize.
      await manager.connect(operator).addModule(airdropModule.address);
      await manager.connect(operator).addModule(tradeModule.address);

      await manager.connect(operator).authorizeInitialization();
      await manager.connect(operator).addExtension(extension.address);
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
        expect(await extension.settings()).to.deep.eq(["UniswapV3ExchangeAdapter", EMPTY_BYTES]);
      });
    });

    describe("#initialize", () => {
      async function subject() {
        return await extension.connect(operator).initialize();
      }

      it("should have airdrop and trade modules", async () => {
        await subject();

        const modules = await setToken.getModules();
        expect(modules).to.contain(airdropModule.address);
        expect(modules).to.contain(tradeModule.address);
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
        await extension.connect(operator).updateExecutionSettings({
          exchangeName,
          exchangeCallData,
        });
      }

      it("should have the updated ExecutionSettings", async () => {
        await subject();

        expect(await extension.settings()).to.deep.eq([exchangeName, exchangeCallData]);
      });
    });

    describe("#reinvest", () => {
      let minReceiveQuantity: BigNumberish;

      beforeEach(async () => {
        minReceiveQuantity = ether(1);
        await extension.connect(operator).initialize();
      });
      async function subject() {
        await extension.connect(operator).reinvest(minReceiveQuantity);
      }

      it("should absorb and reinvest rETH2 into sETH2", async () => {
        const beforeREth2Units = await setToken.balanceOf(await extension.R_ETH2());
        const beforeSEth2Units = await setToken.getTotalComponentRealUnits(
          await extension.S_ETH2(),
        );

        expect(beforeREth2Units.gte(0)).to.be.true;
        expect(beforeSEth2Units.gte(0)).to.be.true;

        await subject();

        const afterSEth2Units = await setToken.getTotalComponentRealUnits(await extension.S_ETH2());
        const afterREth2Units = await setToken.balanceOf(await extension.R_ETH2());

        expect(afterREth2Units.eq(0)).to.be.true;
        expect(afterSEth2Units.gt(beforeSEth2Units.add(minReceiveQuantity))).to.be.true;
      });
    });
  });
}
