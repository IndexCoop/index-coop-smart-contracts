import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { Account, Address, Bytes } from "@utils/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import { BaseAdapterMock, ICManagerV2 } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import { ContractCallerMock } from "@utils/contracts/setV2";

import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getRandomAccount,
  getSetFixture,
  ether,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("BaseAdapter", () => {
  let owner: Account;
  let methodologist: Account;
  let otherAccount: Account;
  let deployer: DeployHelper;
  let setToken: SetToken;
  let setV2Setup: SetFixture;

  let icManagerV2: ICManagerV2;
  let baseAdapterMock: BaseAdapterMock;

  before(async () => {
    [
      owner,
      methodologist,
      otherAccount,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
    );

    // Initialize modules
    await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    const feeRecipient = owner.address;
    const maxStreamingFeePercentage = ether(.1);
    const streamingFeePercentage = ether(.02);
    const streamingFeeSettings = {
      feeRecipient,
      maxStreamingFeePercentage,
      streamingFeePercentage,
      lastStreamingFeeTimestamp: ZERO,
    };
    await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

    baseAdapterMock = await deployer.mocks.deployBaseAdapterMock();

    // Deploy ICManagerV2
    icManagerV2 = await deployer.manager.deployICManagerV2(
      setToken.address,
      owner.address,
      methodologist.address,
      [baseAdapterMock.address]
    );

    // Transfer ownership to ICManagerV2
    await setToken.setManager(icManagerV2.address);

    await baseAdapterMock.updateManager(icManagerV2.address);
    await baseAdapterMock.updateCallAllowList(owner.address, true);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#testOnlyOperator", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseAdapterMock.connect(subjectCaller.wallet).testOnlyOperator();
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not operator", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be operator");
      });
    });
  });

  describe("#testOnlyMethodologist", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseAdapterMock.connect(subjectCaller.wallet).testOnlyMethodologist();
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not methodologist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be methodologist");
      });
    });
  });

  describe("#testOnlyMethodologist", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = methodologist;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseAdapterMock.connect(subjectCaller.wallet).testOnlyMethodologist();
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the sender is not EOA", async () => {
      let subjectTarget: Address;
      let subjectCallData: string;
      let subjectValue: BigNumber;

      let contractCaller: ContractCallerMock;

      beforeEach(async () => {
        contractCaller = await deployer.setV2.deployContractCallerMock();

        subjectTarget = baseAdapterMock.address;
        subjectCallData = baseAdapterMock.interface.encodeFunctionData("testOnlyEOA");
        subjectValue = ZERO;
      });

      async function subjectContractCaller(): Promise<any> {
        return await contractCaller.invoke(
          subjectTarget,
          subjectValue,
          subjectCallData
        );
      }

      it("the trade reverts", async () => {
        await expect(subjectContractCaller()).to.be.revertedWith("Caller must be EOA Address");
      });
    });
  });

  describe("#testOnlyAllowedCaller", async () => {
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseAdapterMock.connect(subjectCaller.wallet).testOnlyAllowedCaller(subjectCaller.address);
    }

    it("should succeed without revert", async () => {
      await subject();
    });

    describe("when the caller is not on allowlist", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Address not permitted to call");
      });

      describe("when anyoneCallable is flipped to true", async () => {
        beforeEach(async () => {
          await baseAdapterMock.updateAnyoneCallable(true);
        });

        it("should succeed without revert", async () => {
          await subject();
        });
      });
    });
  });

  describe("#testInvokeManager", async () => {
    let subjectModule: Address;
    let subjectCallData: Bytes;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectModule = setV2Setup.streamingFeeModule.address;
      subjectCallData = setV2Setup.streamingFeeModule.interface.encodeFunctionData("updateFeeRecipient", [
        setToken.address,
        otherAccount.address,
      ]);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return baseAdapterMock.connect(subjectCaller.wallet).testInvokeManager(subjectModule, subjectCallData);
    }

    it("should call updateFeeRecipient on the streaming fee module from the SetToken", async () => {
      await subject();
      const feeStates = await setV2Setup.streamingFeeModule.feeStates(setToken.address);
      expect(feeStates.feeRecipient).to.eq(otherAccount.address);
    });
  });
});