import "module-alias/register";
import { BigNumber, ContractTransaction } from "ethers";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { Account, Address } from "@utils/types";
import { FliRebalanceKeeper } from "../../typechain/FliRebalanceKeeper";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, EMPTY_BYTES, ZERO_BYTES } from "@utils/constants";
import { cacheBeforeEach } from "@utils/test";
import { FlexibleLeverageStrategyExtensionMock } from "../../typechain/FlexibleLeverageStrategyExtensionMock";
import { BaseManager } from "../../typechain/BaseManager";
import { SetToken } from "../../typechain/SetToken";
import { SetFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("fliRebalanceKeeper", async () => {
  let owner: Account;
  let methodologist: Account;
  let registry: Account;
  let setV2Setup: SetFixture;
  let manager: BaseManager;
  let deployer: DeployHelper;

  let setToken: SetToken;
  let fliExtension: FlexibleLeverageStrategyExtensionMock;

  const exchangeName: string = "Uniswap";

  cacheBeforeEach(async () => {
    [owner, methodologist, registry] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();
    const daiUnits = BigNumber.from("23252699054621733");
    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [daiUnits],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address],
    );
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

    // Deploy BaseManager
    manager = await deployer.manager.deployBaseManager(
      setToken.address,
      owner.address,
      methodologist.address,
    );
    // Transfer ownership to BaseManager
    await setToken.setManager(manager.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  const deployFliExtension = (currentLeverageRatio: number) => {
    return deployer.mocks.deployFlexibleLeverageStrategyExtensionMock(
      manager.address,
      currentLeverageRatio,
      exchangeName,
    );
  };

  const deploySubjectKeeper = async (fliExtension: Address): Promise<FliRebalanceKeeper> => {
    return deployer.keepers.deployFliRebalanceKeeper(fliExtension, registry.address);
  };

  describe("#constructor", async () => {
    let subjectKeeper: FliRebalanceKeeper;

    async function subject(): Promise<FliRebalanceKeeper> {
      fliExtension = await deployFliExtension(1);
      return deployer.keepers.deployFliRebalanceKeeper(fliExtension.address, registry.address);
    }

    it("should have the correct fliExtension address", async () => {
      subjectKeeper = await subject();
      expect(await subjectKeeper.fliExtension()).to.eq(fliExtension.address);
    });

    it("should have the correct registry address", async () => {
      subjectKeeper = await subject();
      expect(await subjectKeeper.registryAddress()).to.eq(registry.address);
    });
  });

  describe("#checkUpkeep", async () => {
    let subjectKeeper: FliRebalanceKeeper;

    context("when caller is not an registry address", async () => {
      async function subject(): Promise<ContractTransaction> {
        fliExtension = await deployFliExtension(1);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(owner.wallet).checkUpkeep(ZERO_BYTES);
      }
      it("should revert when call is not a registry address", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when caller is registry", async () => {
      async function subject(): Promise<[boolean, string]> {
        fliExtension = await deployFliExtension(1);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }
      it("should always return true and empty bytes", async () => {
        const response = await subject();
        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(EMPTY_BYTES);
      });
    });
  });

  describe("#performUpkeep", async () => {
    let subjectKeeper: FliRebalanceKeeper;
    let rebalanceCalldata: string;

    async function getRebalanceCalldata(leverageRatio: number): Promise<string> {
      switch (leverageRatio) {
        case 1:
          return fliExtension.interface.encodeFunctionData("rebalance", [exchangeName]);
        case 2:
          return fliExtension.interface.encodeFunctionData("iterateRebalance", [exchangeName]);
        case 3:
          return fliExtension.interface.encodeFunctionData("ripcord", [exchangeName]);
        default:
          return ZERO_BYTES;
      }
    }

    async function setup(leverageRatio: number) {
      fliExtension = await deployFliExtension(leverageRatio);
      subjectKeeper = await deploySubjectKeeper(fliExtension.address);
      await fliExtension.updateCallerStatus([subjectKeeper.address], [true]);
      rebalanceCalldata = await getRebalanceCalldata(leverageRatio);
    }

    context("when caller is not an registry address", async () => {
      beforeEach(async () => {
        const leverageRatio = 0;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(owner.wallet).performUpkeep(rebalanceCalldata);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when leverage ratio is 0", async () => {
      beforeEach(async () => {
        const leverageRatio = 0;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).performUpkeep(rebalanceCalldata);
      }

      it("should revert when call is not a registry address", async () => {
        await expect(subject()).to.be.revertedWith("No rebalance required");
      });
    });

    context("when leverage ratio is 1", async () => {
      beforeEach(async () => {
        const leverageRatio = 1;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).performUpkeep(rebalanceCalldata);
      }

      it("should call rebalance on fliExtension and emit RebalanceEvent with arg of 1", async () => {
        await expect(subject()).to.emit(fliExtension, "RebalanceEvent");
      });
    });

    context("when leverage ratio is 2", async () => {
      beforeEach(async () => {
        const leverageRatio = 2;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).performUpkeep(rebalanceCalldata);
      }

      it("should call iterateRebalance on fliExtension and emit RebalanceEvent with arg of 2", async () => {
        await expect(subject())
          .to.emit(fliExtension, "RebalanceEvent")
          .withArgs(2);
      });
    });

    context("when leverage ratio is 3", async () => {
      beforeEach(async () => {
        const leverageRatio = 3;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).performUpkeep(rebalanceCalldata);
      }

      it("should call ripcord on fliExtension and emit RebalanceEvent with arg of 3", async () => {
        await expect(subject())
          .to.emit(fliExtension, "RebalanceEvent")
          .withArgs(3);
      });
    });
  });
});
