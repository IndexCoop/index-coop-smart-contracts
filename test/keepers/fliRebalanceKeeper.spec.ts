import "module-alias/register";
import { BigNumber, ContractTransaction } from "ethers";
import { defaultAbiCoder } from "ethers/lib/utils";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { Account, Address } from "@utils/types";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach } from "@utils/test";
import { SetFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO_BYTES } from "@utils/constants";

import { FliRebalanceKeeper } from "../../typechain/FliRebalanceKeeper";
import { FlexibleLeverageStrategyExtensionMock } from "../../typechain/FlexibleLeverageStrategyExtensionMock";
import { BaseManager } from "../../typechain/BaseManager";
import { SetToken } from "../../typechain/SetToken";

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

  let subjectKeeper: FliRebalanceKeeper;
  let performData: string;

  let customMinLeverageRatio: number;
  let customMaxLeverageRatio: number;

  const exchangeName: string = "Uniswap";
  const exchangeIndex: number = 0;

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

    customMinLeverageRatio = 1;
    customMaxLeverageRatio = 2;
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
    return deployer.keepers.deployFliRebalanceKeeper(
      fliExtension,
      registry.address,
      exchangeIndex,
      { customMinLeverageRatio, customMaxLeverageRatio },
    );
  };

  const setup = async (leverageRatio: number) => {
    fliExtension = await deployFliExtension(leverageRatio);
    subjectKeeper = await deploySubjectKeeper(fliExtension.address);
    await fliExtension.updateCallerStatus([subjectKeeper.address], [true]);
    performData = await getPerformData(leverageRatio);
  };

  const getPerformData = async (leverageRatio: number): Promise<string> => {
    switch (leverageRatio) {
      case 1:
        return defaultAbiCoder.encode(["uint256", "string"], [1, exchangeName]);
      case 2:
        return defaultAbiCoder.encode(["uint256", "string"], [2, exchangeName]);
      case 3:
        return defaultAbiCoder.encode(["uint256", "string"], [3, exchangeName]);
      default:
        return defaultAbiCoder.encode(["uint256", "string"], [0, exchangeName]);
    }
  };

  describe("#constructor", async () => {
    let subjectKeeper: FliRebalanceKeeper;

    async function subject(): Promise<FliRebalanceKeeper> {
      fliExtension = await deployFliExtension(1);
      return deployer.keepers.deployFliRebalanceKeeper(
        fliExtension.address,
        registry.address,
        exchangeIndex,
        { customMinLeverageRatio, customMaxLeverageRatio },
      );
    }

    it("should have the correct fliExtension address", async () => {
      subjectKeeper = await subject();
      expect(await subjectKeeper.fliExtension()).to.eq(fliExtension.address);
    });

    it("should have the correct registry address", async () => {
      subjectKeeper = await subject();
      expect(await subjectKeeper.registryAddress()).to.eq(registry.address);
    });

    it("should have the correct exchange index", async () => {
      subjectKeeper = await subject();
      expect(await subjectKeeper.exchangeIndex()).to.eq(exchangeIndex);
    });

    it("should have the correct leverage settings", async () => {
      subjectKeeper = await subject();
      const leverageSettings = await subjectKeeper.leverageSettings();
      expect(leverageSettings.customMinLeverageRatio).to.eq(customMinLeverageRatio);
      expect(leverageSettings.customMaxLeverageRatio).to.eq(customMaxLeverageRatio);
    });
  });

  describe("#checkUpkeep", async () => {
    context("when leverage ratio is 0", async () => {
      beforeEach(async () => {
        const leverageRatio = 0;
        await setup(leverageRatio);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return false, encoded shouldRebalance and exchangeName", async () => {
        const expectedPerformData = defaultAbiCoder.encode(
          ["uint256", "string"],
          [0, exchangeName],
        );

        const response = await subject();

        expect(response[0]).to.be.false;
        expect(response[1]).to.eq(expectedPerformData);
      });
    });

    context("when leverage ratio is 1", async () => {
      beforeEach(async () => {
        const leverageRatio = 1;
        await setup(leverageRatio);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return true, encoded shouldRebalance and exchangeName", async () => {
        const expectedPerformData = defaultAbiCoder.encode(
          ["uint256", "string"],
          [1, exchangeName],
        );

        const response = await subject();

        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(expectedPerformData);
      });
    });

    context("when leverage ratio is 2", async () => {
      beforeEach(async () => {
        const leverageRatio = 2;
        await setup(leverageRatio);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return true, encoded shouldRebalance and exchangeName", async () => {
        const expectedPerformData = defaultAbiCoder.encode(
          ["uint256", "string"],
          [2, exchangeName],
        );

        const response = await subject();

        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(expectedPerformData);
      });
    });

    context("when leverage ratio is 3", async () => {
      beforeEach(async () => {
        const leverageRatio = 3;
        await setup(leverageRatio);
      });

      async function subject(): Promise<[boolean, string]> {
        return subjectKeeper.connect(registry.wallet).callStatic.checkUpkeep(ZERO_BYTES);
      }

      it("should return true, encoded shouldRebalance and exchangeName", async () => {
        const expectedPerformData = defaultAbiCoder.encode(
          ["uint256", "string"],
          [3, exchangeName],
        );

        const response = await subject();

        expect(response[0]).to.be.true;
        expect(response[1]).to.eq(expectedPerformData);
      });
    });
  });

  describe("#performUpkeep", async () => {
    context("when leverage ratio is 0", async () => {
      beforeEach(async () => {
        const leverageRatio = 0;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).performUpkeep(performData);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "FliRebalanceKeeper: invalid shouldRebalance or no rebalance required",
        );
      });
    });

    context("when leverage ratio is 1", async () => {
      beforeEach(async () => {
        const leverageRatio = 1;
        await setup(leverageRatio);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).performUpkeep(performData);
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
        return subjectKeeper.connect(registry.wallet).performUpkeep(performData);
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
        return subjectKeeper.connect(registry.wallet).performUpkeep(performData);
      }

      it("should call ripcord on fliExtension and emit RebalanceEvent with arg of 3", async () => {
        await expect(subject())
          .to.emit(fliExtension, "RebalanceEvent")
          .withArgs(3);
      });
    });
  });

  describe("#setExchangeIndex", async () => {
    context("when changing the exchange index to 1", async () => {
      beforeEach(async () => {
        await setup(1);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(owner.wallet).setExchangeIndex(1);
      }

      it("should set the exchange index", async () => {
        const beforeIndex = await subjectKeeper.exchangeIndex();
        expect(beforeIndex).to.eq(0);

        await subject();

        const afterIndex = await subjectKeeper.exchangeIndex();
        expect(afterIndex).to.eq(1);
      });
    });

    context("when caller is not the owner address", async () => {
      beforeEach(async () => {
        await setup(1);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper.connect(registry.wallet).setExchangeIndex(1);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setLeverageSettings", async () => {
    context("when setting LeverageSettings bounds to min = 2 and max = 3", async () => {
      beforeEach(async () => {
        await setup(1);
        customMinLeverageRatio = 2;
        customMaxLeverageRatio = 3;
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper
          .connect(owner.wallet)
          .setLeverageSettings({ customMinLeverageRatio, customMaxLeverageRatio });
      }

      it("should set the leverage settings", async () => {
        const beforeLeverageSettings = await subjectKeeper.leverageSettings();
        expect(beforeLeverageSettings.customMinLeverageRatio).to.eq(1);
        expect(beforeLeverageSettings.customMaxLeverageRatio).to.eq(2);

        await subject();

        const afterLeverageSettings = await subjectKeeper.leverageSettings();
        expect(afterLeverageSettings.customMinLeverageRatio).to.eq(customMinLeverageRatio);
        expect(afterLeverageSettings.customMaxLeverageRatio).to.eq(customMaxLeverageRatio);
      });
    });

    context("when caller is not the owner address", async () => {
      beforeEach(async () => {
        await setup(1);
      });

      async function subject(): Promise<ContractTransaction> {
        return subjectKeeper
          .connect(registry.wallet)
          .setLeverageSettings({ customMinLeverageRatio, customMaxLeverageRatio });
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
