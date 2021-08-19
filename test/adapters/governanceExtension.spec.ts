import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, EMPTY_BYTES, ONE, TWO } from "@utils/constants";
import { GovernanceExtension, BaseManagerV2, GovernanceAdapterMock } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  bigNumberToData,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("GovernanceExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let delegatee: Account;
  let approvedCaller: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManagerV2;
  let governanceExtension: GovernanceExtension;
  let governanceMock: GovernanceAdapterMock;

  const governanceMockName: string = "GovernanceMock";

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      delegatee,
      approvedCaller,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    governanceMock = await deployer.mocks.deployGovernanceAdapterMock(ONE);
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.governanceModule.address,
      governanceMockName,
      governanceMock.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.governanceModule.address]
    );

    // Deploy BaseManager
    baseManagerV2 = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      methodologist.address
    );
    await baseManagerV2.connect(methodologist.wallet).authorizeInitialization();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectGovernanceModule: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectGovernanceModule = setV2Setup.governanceModule.address;
    });

    async function subject(): Promise<GovernanceExtension> {
      return await deployer.extensions.deployGovernanceExtension(
        subjectManager,
        subjectGovernanceModule
      );
    }

    it("should set the correct SetToken address", async () => {
      const governanceExtension = await subject();

      const actualToken = await governanceExtension.setToken();
      expect(actualToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const governanceExtension = await subject();

      const actualManager = await governanceExtension.manager();
      expect(actualManager).to.eq(baseManagerV2.address);
    });

    it("should set the correct governance module address", async () => {
      const governanceExtension = await subject();

      const actualStreamingFeeModule = await governanceExtension.governanceModule();
      expect(actualStreamingFeeModule).to.eq(subjectGovernanceModule);
    });
  });

  context("when governance extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      governanceExtension = await deployer.extensions.deployGovernanceExtension(
        baseManagerV2.address,
        setV2Setup.governanceModule.address
      );

      await baseManagerV2.connect(operator.wallet).addExtension(governanceExtension.address);

      await governanceExtension.connect(operator.wallet).updateCallerStatus([approvedCaller.address], [true]);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await governanceExtension.connect(subjectCaller.wallet).initialize();
      }

      it("should initialize GovernanceModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.governanceModule.address);
        expect(isInitialized).to.be.true;
      });

      describe("when the operator is not the caller", async () => {
        beforeEach(async () => {
          subjectCaller = approvedCaller;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when governance extension is deployed and system fully set up", async () => {
      beforeEach(async () => {
        await governanceExtension.connect(operator.wallet).initialize();
      });

      describe("#delegate", async () => {
        let subjectGovernanceName: string;
        let subjectDelegatee: Address;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectGovernanceName = governanceMockName;
          subjectDelegatee = delegatee.address;
          subjectCaller = approvedCaller;
        });

        async function subject(): Promise<ContractTransaction> {
          return await governanceExtension.connect(subjectCaller.wallet).delegate(subjectGovernanceName, subjectDelegatee);
        }

        it("should correctly delegate votes", async () => {
          await subject();

          const delegatee = await governanceMock.delegatee();
          expect(delegatee).to.eq(subjectDelegatee);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = methodologist;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });

      describe("#propose", async () => {
        let subjectGovernanceName: string;
        let subjectProposalData: string;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectGovernanceName = governanceMockName;
          subjectProposalData = "0x" + bigNumberToData(TWO);
          subjectCaller = approvedCaller;
        });

        async function subject(): Promise<ContractTransaction> {
          return await governanceExtension.connect(subjectCaller.wallet).propose(subjectGovernanceName, subjectProposalData);
        }

        it("should submit a proposal", async () => {
          const proposalStatusBefore = await governanceMock.proposalCreated(TWO);
          expect(proposalStatusBefore).to.eq(false);

          await subject();

          const proposalStatusAfter = await governanceMock.proposalCreated(TWO);
          expect(proposalStatusAfter).to.eq(true);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = methodologist;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });

      describe("#register", async () => {
        let subjectGovernanceName: string;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectGovernanceName = governanceMockName;
          subjectCaller = approvedCaller;
        });

        async function subject(): Promise<ContractTransaction> {
          return await governanceExtension.connect(subjectCaller.wallet).register(subjectGovernanceName);
        }

        it("should register the SetToken for voting", async () => {
          await subject();

          const delegatee = await governanceMock.delegatee();
          expect(delegatee).to.eq(setToken.address);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = methodologist;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });

      describe("#revoke", async () => {
        let subjectGovernanceName: string;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectGovernanceName = governanceMockName;
          subjectCaller = approvedCaller;
        });

        async function subject(): Promise<ContractTransaction> {
          return await governanceExtension.connect(subjectCaller.wallet).revoke(subjectGovernanceName);
        }

        it("should revoke the SetToken's voting rights", async () => {
          await subject();

          const delegatee = await governanceMock.delegatee();
          expect(delegatee).to.eq(ADDRESS_ZERO);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = methodologist;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });

      describe("#vote", async () => {
        let subjectGovernanceName: string;
        let subjectProposalId: BigNumber;
        let subjectSupport: boolean;
        let subjectData: string;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectGovernanceName = governanceMockName;
          subjectProposalId = ONE;
          subjectSupport = true;
          subjectData = EMPTY_BYTES;
          subjectCaller = approvedCaller;
        });

        async function subject(): Promise<ContractTransaction> {
          return await governanceExtension.connect(subjectCaller.wallet).vote(
            subjectGovernanceName,
            subjectProposalId,
            subjectSupport,
            subjectData
          );
        }

        it("should vote on the proposal", async () => {
          const proposalStatusBefore = await governanceMock.proposalToVote(subjectProposalId);
          expect(proposalStatusBefore).to.eq(false);

          await subject();

          const proposalStatusAfter = await governanceMock.proposalToVote(subjectProposalId);
          expect(proposalStatusAfter).to.eq(true);
        });

        describe("when the caller is an approved caller", async () => {
          beforeEach(async () => {
            subjectCaller = methodologist;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });
    });
  });
});