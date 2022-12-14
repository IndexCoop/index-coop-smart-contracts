import "module-alias/register";
import { ethers, network } from "hardhat";
import { BigNumberish, Signer } from "ethers";

import { Account } from "@utils/types";
import { ether, getAccounts, getWaffleExpect, setEthBalance } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";

import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { StakeWiseReinvestmentExtension } from "../../../typechain/StakeWiseReinvestmentExtension";
import { IAirdropModule } from "../../../typechain/IAirdropModule";
import { BaseManagerV2 } from "../../../typechain/BaseManagerV2";
import { ITradeModule } from "../../../typechain/ITradeModule";
import { ISetToken } from "../../../typechain/ISetToken";
import { impersonateAccount } from "./utils";
import { IERC20 } from "@typechain/IERC20";
import { IDebtIssuanceModule } from "@typechain/IDebtIssuanceModule";

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
    // rETH2 and sETH2 whale.
    let whale: Signer;

    let rETH2: IERC20;
    let sETH2: IERC20;

    let extension: StakeWiseReinvestmentExtension;
    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      [owner] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt("ISetToken", addresses.tokens.wsETH2)) as ISetToken;

      manager = (await ethers.getContractAt(
        "BaseManagerV2",
        await setToken.manager(),
      )) as BaseManagerV2;

      const operatorAddress = await manager.operator();

      await setEthBalance(operatorAddress, ether(100));

      operator = await impersonateAccount(operatorAddress);
      whale = await impersonateAccount("0x7BdDb2C97AF91f97E73F07dEB976fdFC2d2Ee93c");

      airdropModule = await ethers.getContractAt(
        "IAirdropModule",
        addresses.setFork.airdropModule,
      ) as IAirdropModule;

      tradeModule = await ethers.getContractAt(
        "ITradeModule",
        addresses.setFork.tradeModule,
      ) as ITradeModule;

      rETH2 = await ethers.getContractAt(
        "IERC20",
        addresses.tokens.rETH2
      ) as IERC20;

      sETH2 = await ethers.getContractAt(
        "IERC20",
        addresses.tokens.sETH2
      ) as IERC20;

      await deployStakeWiseReinvestmentExtension();

      await extension.connect(operator).updateCallerStatus([await operator.getAddress()], [true]);

      // Modules need to first be added through the manager before the extension can initialize.
      await manager.connect(operator).addModule(airdropModule.address);
      await manager.connect(operator).addModule(tradeModule.address);

      await manager.connect(operator).authorizeInitialization();
      await manager.connect(operator).addExtension(extension.address);

      // Fund owner wallet from whale
      await sETH2.connect(whale).transfer(owner.address, ether(1));

      const debtIssuanceModule = await ethers.getContractAt(
        "IDebtIssuanceModule",
        addresses.setFork.debtIssuanceModuleV2,
      ) as IDebtIssuanceModule;

      await sETH2.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
      await rETH2.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);

      await debtIssuanceModule
        .connect(owner.wallet)
        .issue(setToken.address, ether(1), owner.address);
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
          exchangeName: "UniswapV3ExchangeAdapterV2",
          exchangeCallData:
            "0x20bc832ca081b91433ff6c17f85701b6e92486c50001f4fe2e637202056d30016725477c5da089ab0a043a01",
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
        expect(await extension.settings()).to.deep.eq([
          "UniswapV3ExchangeAdapterV2",
          "0x20bc832ca081b91433ff6c17f85701b6e92486c50001f4fe2e637202056d30016725477c5da089ab0a043a01",
        ]);
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
        minReceiveQuantity = ether(0.8);
        await extension.connect(operator).initialize();
      });

      async function subject() {
        await extension.connect(operator).reinvest(minReceiveQuantity);
      }

      context("when rETH2 balance of setToken is 0", async () => {
        it("should revert", async () => {
          const rETh2Units = await setToken.balanceOf(await extension.R_ETH2());
          expect(rETh2Units.eq(0)).to.be.true;

          await expect(subject()).to.be.revertedWith("rETH2 units must be greater than zero");
        });
      });

      context("when rETH2 balance of setToken is greater than 0", async () => {
        let amount: BigNumberish;

        beforeEach(async () => {
          amount = ether(1);
          await rETH2.connect(whale).transfer(setToken.address, amount);
        });

        it("should absorb and reinvest rETH2 into sETH2", async () => {
          // const bytes = airdropModule.interface.encodeFunctionData("absorb", [setToken.address, rETH2.address]);

          // await manager.connect(operator).interactManager(airdropModule.address, bytes);

          // const bytes1 = tradeModule.interface.encodeFunctionData("trade", [
          //   setToken.address,
          //   "UniswapV3ExchangeAdapterV2",
          //   rETH2.address,
          //   ether(1),
          //   sETH2.address,
          //   ether(0.5),
          //   "0x20bc832ca081b91433ff6c17f85701b6e92486c50001f4fe2e637202056d30016725477c5da089ab0a043a01"
          // ]);

          // await manager.connect(operator).interactManager(tradeModule.address, bytes1);
          const beforeREth2Units = await rETH2.balanceOf(setToken.address);
          const beforeSEth2Units = await setToken.getTotalComponentRealUnits(
            await extension.S_ETH2(),
          );

          expect(beforeREth2Units.gt(0)).to.be.true;
          expect(beforeSEth2Units.gt(0)).to.be.true;

          await subject();
          console.log("1");

          const afterSEth2Units = await setToken.getTotalComponentRealUnits(
            await extension.S_ETH2(),
          );
          console.log("1");
          const afterREth2Units = await setToken.balanceOf(await extension.R_ETH2());

          console.log("1");
          expect(afterREth2Units.eq(0)).to.be.true;
          expect(afterSEth2Units.gt(beforeSEth2Units.add(minReceiveQuantity))).to.be.true;
        });
      });
    });
  });
}
