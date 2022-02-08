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

  const deploySubjectKeeper = async (fliExtension: Address): Promise<FliRebalanceKeeper> => {
    return deployer.keepers.deployFliRebalanceKeeper(fliExtension, registry.address);
  };

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

    context("when leverage ratio is 0", async () => {
      let subjectLeverageRatio: number;
      beforeEach(async () => {
        subjectLeverageRatio = 0;
        fliExtension = await deployFliExtension(subjectLeverageRatio);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return false and empty bytes", async () => {
        const response = await subject();
        expect(response[0]).to.be.false;
        expect(response[1]).to.equal(EMPTY_BYTES);
      });
    });

    context("when leverage ratio is 1", async () => {
      let subjectLeverageRatio: number;
      beforeEach(async () => {
        subjectLeverageRatio = 1;
        fliExtension = await deployFliExtension(subjectLeverageRatio);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return true and rebalance(string)", async () => {
        const expectedCalldata = fliExtension.interface.encodeFunctionData("rebalance", [
          exchangeName,
        ]);

        const response = await subject();

        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(expectedCalldata);
      });
    });

    context("when leverage ratio is 2", async () => {
      let subjectLeverageRatio: number;

      beforeEach(async () => {
        subjectLeverageRatio = 2;
        fliExtension = await deployFliExtension(subjectLeverageRatio);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return true and iterateRebalance(string)", async () => {
        const expectedCalldata = fliExtension.interface.encodeFunctionData("iterateRebalance", [
          exchangeName,
        ]);

        const response = await subject();

        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(expectedCalldata);
      });
    });

    context("when leverage ratio is 3", async () => {
      let subjectLeverageRatio: number;
      beforeEach(async () => {
        subjectLeverageRatio = 3;
        fliExtension = await deployFliExtension(subjectLeverageRatio);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return true and ripcord(string)", async () => {
        const expectedCalldata = fliExtension.interface.encodeFunctionData("ripcord", [
          exchangeName,
        ]);

        const response = await subject();

        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(expectedCalldata);
      });
    });
  });

  describe("#performUpkeep", async () => {
    let subjectKeeper: FliRebalanceKeeper;

    context("when caller is not an registry address", async () => {
      async function subject(): Promise<void> {
        fliExtension = await deployFliExtension(1);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(owner.wallet).callStatic.performUpkeep(ZERO_BYTES);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when arbitrary callData is passed in", async () => {
      async function subject(): Promise<void> {
        fliExtension = await deployFliExtension(1);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(registry.wallet).callStatic.performUpkeep(ZERO_BYTES);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when leverage ratio is 0 and rebalance callData is passed in", async () => {
      async function subject(): Promise<void> {
        fliExtension = await deployFliExtension(0);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(registry.wallet).callStatic.performUpkeep(ZERO_BYTES);
      }

      it("should revert when call is not a registry address", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when leverage ratio is 1 and rebalance callData is passed in", async () => {
      async function subject(): Promise<void> {
        fliExtension = await deployFliExtension(1);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(registry.wallet).callStatic.performUpkeep(ZERO_BYTES);
      }

      it("should revert when call is not a registry address", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when leverage ratio is 2 and rebalance callData is passed in", async () => {
      async function subject(): Promise<void> {
        fliExtension = await deployFliExtension(2);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        return subjectKeeper.connect(registry.wallet).callStatic.performUpkeep(ZERO_BYTES);
      }

      it("should revert when call is not a registry address", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });

    context("when leverage ratio is 3 and rebalance callData is passed in", async () => {
      async function subject(): Promise<void> {
        fliExtension = await deployFliExtension(3);
        subjectKeeper = await deploySubjectKeeper(fliExtension.address);
        const ripcord = await fliExtension.ripcord(exchangeName);
        return subjectKeeper.connect(registry.wallet).callStatic.performUpkeep(ripcord.data);
      }

      it("should revert when call is not a registry address", async () => {
        await expect(subject()).to.be.revertedWith("Only registry address can call this function");
      });
    });
  });
});
