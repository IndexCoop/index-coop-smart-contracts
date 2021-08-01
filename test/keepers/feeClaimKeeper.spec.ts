import "module-alias/register";

import { BaseManager, StreamingFeeSplitExtension, FeeClaimKeeper } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getLastBlockTimestamp,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { defaultAbiCoder } from "ethers/lib/utils";

const expect = getWaffleExpect();

describe("FeeClaimKeeper", () => {

  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManager: BaseManager;
  let feeExtension: StreamingFeeSplitExtension;

  let feeClaimKeeper: FeeClaimKeeper;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Deploy BaseManager
    baseManager = await deployer.manager.deployBaseManager(
      setToken.address,
      operator.address,
      methodologist.address
    );

    // Deploy streaming fee module
    const feeRecipient = baseManager.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Deploy streaming fee extension
    feeExtension = await deployer.adapters.deployStreamingFeeSplitExtension(
      baseManager.address,
      setV2Setup.streamingFeeModule.address,
      ether(0.7)
    );
    await baseManager.connect(operator.wallet).addAdapter(feeExtension.address);

    // Transfer ownership of set to baseManager
    await setToken.setManager(baseManager.address);

    // Mint some sets
    await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, ether(3));
    await setV2Setup.issuanceModule.issue(setToken.address, ether(2), owner.address);

    // Deploy keeper
    feeClaimKeeper = await deployer.keepers.deployFeeClaimKeeper();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#checkUpkeep", async () => {

    let subjectCheckData: string;

    beforeEach(() => {
      subjectCheckData = defaultAbiCoder.encode(["address", "uint256"], [feeExtension.address, 60 * 60 * 24]);
    });

    async function subject(): Promise<[boolean, string]> {
      return await feeClaimKeeper.checkUpkeep(subjectCheckData);
    }

    it("should return true for upkeepNeeded and encode the correct streaming fee extension to call", async () => {
      const [ upkeepNeeded, performData ] = await subject();

      expect(upkeepNeeded).to.be.true;
      expect(performData).to.eq(defaultAbiCoder.encode(["address"], [feeExtension.address]));
    });
  });

  describe("#performUpkeep", async () => {

    let subjectPerformData: string;

    beforeEach(() => {
      subjectPerformData = defaultAbiCoder.encode(["address"], [feeExtension.address]);
    });

    async function subject(): Promise<ContractTransaction> {
      return await feeClaimKeeper.performUpkeep(subjectPerformData);
    }

    it("should claim fees", async () => {
      const initOperatorSetBalance = await setToken.balanceOf(operator.address);
      const initMethodologistSetBalance = await setToken.balanceOf(methodologist.address);

      await subject();

      const finalOperatorSetBalance = await setToken.balanceOf(operator.address);
      const finalMethodologistSetBalance = await setToken.balanceOf(methodologist.address);

      expect(finalOperatorSetBalance.gt(initOperatorSetBalance)).to.be.true;
      expect(finalMethodologistSetBalance.gt(initMethodologistSetBalance)).to.be.true;
    });

    it("should update the lastUpkeeps value for the extension", async () => {
      await subject();

      const lastUpkeep = await feeClaimKeeper.lastUpkeeps(feeExtension.address);
      const expectedLastUpkeep = await getLastBlockTimestamp();

      expect(lastUpkeep).to.eq(expectedLastUpkeep);
    });
  });
});