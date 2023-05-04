import "module-alias/register";
import { ethers, network } from "hardhat";
import { BigNumberish, Signer } from "ethers";

import { Account } from "@utils/types";
import { ether, getAccounts, getWaffleExpect, setEthBalance } from "@utils/index";
import DeployHelper from "@utils/deploys";
import { EMPTY_BYTES, MAX_UINT_256, ZERO } from "@utils/constants";
import { setBlockNumber } from "@utils/test/testingUtils";

import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { StakeWiseReinvestmentExtension } from "../../../typechain/StakeWiseReinvestmentExtension";
import { IAirdropModule } from "../../../typechain/IAirdropModule";
import { BaseManagerV2 } from "../../../typechain/BaseManagerV2";
import { ITradeModule } from "../../../typechain/ITradeModule";
import { ISetToken } from "../../../typechain/ISetToken";
import { impersonateAccount } from "./utils";
import { IERC20 } from "../../../typechain/IERC20";
import { IDebtIssuanceModule } from "../../../typechain/IDebtIssuanceModule";

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


    setBlockNumber(16180859);

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

      airdropModule = (await ethers.getContractAt(
        "IAirdropModule",
        addresses.setFork.airdropModule,
      )) as IAirdropModule;

      tradeModule = (await ethers.getContractAt(
        "ITradeModule",
        addresses.setFork.tradeModule,
      )) as ITradeModule;

      rETH2 = (await ethers.getContractAt("IERC20", addresses.tokens.rETH2)) as IERC20;

      sETH2 = (await ethers.getContractAt("IERC20", addresses.tokens.sETH2)) as IERC20;

      await deployStakeWiseReinvestmentExtension();

      await extension.connect(operator).updateCallerStatus([await operator.getAddress()], [true]);

      // Modules need to first be added through the manager before the extension can initialize.
      // TODO (Richard): these lines can be removed once modeuls get added to the manager and blockNumber is advanced
      await manager.connect(operator).addModule(airdropModule.address);
      await manager.connect(operator).addModule(tradeModule.address);

      await manager.connect(operator).authorizeInitialization();
      await manager.connect(operator).addExtension(extension.address);

      // Fund owner wallet from whale
      await sETH2.connect(whale).transfer(owner.address, ether(1));

      const debtIssuanceModule = (await ethers.getContractAt(
        "IDebtIssuanceModule",
        addresses.setFork.debtIssuanceModuleV2,
      )) as IDebtIssuanceModule;

      await sETH2.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
      await rETH2.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);

      // Issue 1 wsETH2 for owner
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
            // From generateDataParams on UniswapV3ExchangeAdapterV2
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
      let caller: Signer;

      async function subject() {
        return await extension.connect(caller).initialize();
      }

      context("the caller is the operator", async () => {
        beforeEach(() => {
          caller = operator;
        });

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
          expect(settings[1]).to.equal(ZERO);
          expect(settings[2]).to.equal(false);
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

      context("when the caller is not an allowed caller", async () => {
        async function subject() {
          await extension.connect(owner.wallet).updateExecutionSettings({
            exchangeName,
            exchangeCallData,
          });
        }

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Address not permitted to call");
        });
      });
    });

    describe("#reinvest", () => {
      let minReceiveQuantity: BigNumberish;

      beforeEach(async () => {
        minReceiveQuantity = ether(10);
        await extension.connect(operator).initialize();
      });

      async function subject() {
        await extension.connect(operator).reinvest(minReceiveQuantity);
      }

      context("when rETH2 balance of setToken is 0", async () => {
        it("should revert", async () => {
          const rETh2Units = await setToken.balanceOf(await extension.R_ETH2());
          expect(rETh2Units).to.eq(ZERO);

          await expect(subject()).to.be.revertedWith("rETH2 units must be greater than zero");
        });
      });

      context("when rETH2 balance of setToken is greater than 0", async () => {
        beforeEach(async () => {
          await rETH2.connect(whale).transfer(setToken.address, minReceiveQuantity);
        });

        it("should absorb and reinvest rETH2 into sETH2", async () => {
          const beforeREth2Units = await rETH2.balanceOf(setToken.address);
          const beforeSEth2Units = await setToken.getTotalComponentRealUnits(
            await extension.S_ETH2(),
          );

          expect(beforeREth2Units).to.eq(ether(10));
          expect(beforeSEth2Units).to.eq(ether(1));

          await subject();

          const afterSEth2Units = await setToken.getTotalComponentRealUnits(
            await extension.S_ETH2(),
          );
          const afterREth2Units = await rETH2.balanceOf(setToken.address);

          expect(afterREth2Units).to.eq(ZERO);
          expect(afterSEth2Units).to.gte(beforeSEth2Units.add(minReceiveQuantity));
          expect(afterSEth2Units).to.lte(
            beforeSEth2Units
              .add(minReceiveQuantity)
              .mul(101)
              .div(100),
          );
        });
      });

      context("when the caller is not an allowed caller", async () => {
        async function subject() {
          await extension.connect(owner.wallet).reinvest(minReceiveQuantity);
        }

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Address not permitted to call");
        });
      });
    });
  });
}
