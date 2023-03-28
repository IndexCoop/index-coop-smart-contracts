import "module-alias/register";
import { ethers, network } from "hardhat";
import { Signer } from "ethers";

import { Account } from "@utils/types";
import { ether, getAccounts, getWaffleExpect, setEthBalance } from "@utils/index";
import DeployHelper from "@utils/deploys";

import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { impersonateAccount } from "./utils";

import { BaseManagerV2 } from "../../../typechain/BaseManagerV2";
import { ISetToken } from "../../../typechain/ISetToken";
import { INotionalTradeModule } from "../../../typechain/INotionalTradeModule";
import { NotionalTradeExtension } from "../../../typechain/NotionalTradeExtension";

const expect = getWaffleExpect();
const addresses = process.env.USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;

if (process.env.INTEGRATIONTEST) {
  describe("NotionalTradeExtension - Integration Test", () => {
    let owner: Account;
    let deployer: DeployHelper;
    let setToken: ISetToken;
    let manager: BaseManagerV2;
    let notionalTradeModule: INotionalTradeModule;
    let operator: Signer;

    let extension: NotionalTradeExtension;
    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      [owner] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      setToken = (await ethers.getContractAt("ISetToken", addresses.tokens.fixedDai)) as ISetToken;

      manager = (await ethers.getContractAt(
        "BaseManagerV2",
        await setToken.manager(),
      )) as BaseManagerV2;

      const operatorAddress = await manager.operator();

      await setEthBalance(operatorAddress, ether(100));

      operator = await impersonateAccount(operatorAddress);

      notionalTradeModule = (await ethers.getContractAt(
        "INotionalTradeModule",
        addresses.setFork.notionalTradeModule,
      )) as INotionalTradeModule;

      await deployExtension();

      await extension.connect(operator).updateCallerStatus([await operator.getAddress()], [true]);

      // Modules need to first be added through the manager before the extension can initialize.
      await manager.connect(operator).addModule(notionalTradeModule.address);

      await manager.connect(operator).authorizeInitialization();
      await manager.connect(operator).addExtension(extension.address);
      // Issue FIXED-DAI to owner.
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    async function deployExtension() {
      extension = await deployer.extensions.deployNotionalTradeExtension(
        manager.address,
        notionalTradeModule.address,
      );
    }

    describe("#constructor", () => {
      it("should set the correct manager address", async () => {
        expect(await extension.manager()).to.eq(manager.address);
      });

      it("should set the correct notionalTradeModule address", async () => {
        expect(await extension.notionalTradeModule()).to.eq(notionalTradeModule.address);
      });
    });

    describe("#initialize", () => {
      let caller: Signer;

      async function subject() {
        return await extension.connect(caller).initialize();
      }

      context("the caller is the operator", async () => {
        beforeEach(() => {
          caller = operator;
        });

        it("should have notional trade modules", async () => {
          await subject();

          const modules = await setToken.getModules();
          expect(modules).to.contain(notionalTradeModule.address);
        });
      });

      context("when the caller is not the operator", async () => {
        beforeEach(() => {
          caller = owner.wallet;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });
  });
}
