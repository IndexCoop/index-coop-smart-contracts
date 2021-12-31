import "module-alias/register";

import DeployHelper from "@utils/deploys";
import { SetFixture } from "@utils/fixtures";
import { SetToken } from "@utils/contracts/setV2";
import {
  BaseManagerV2,
  WrapExtension,
  WrapAdapterMock,
} from "@utils/contracts/index";
import { Account, Address } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getWaffleExpect,
} from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("WrapExtension", async () => {
  let owner: Account;
  let operator: Account;

  let deployer: DeployHelper;
  let setV2Setup: SetFixture;

  let setToken: SetToken;
  let baseManager: BaseManagerV2;
  let wrapExtension: WrapExtension;

  let wrapAdapter: WrapAdapterMock;
  let wrapAdapterName: string;

  before(async () => {
    [
      owner,
      operator,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // setup mock wrap adapter
    wrapAdapter = await deployer.mocks.deployWrapAdapterMock(owner.address, ether(1000));
    wrapAdapterName = "WRAP_ADAPTER";
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModule.address,
      wrapAdapterName,
      wrapAdapter.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.weth.address],
      [ether(0.1)],
      [setV2Setup.wrapModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Issue some set tokens
    await setV2Setup.weth.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

    // Deploy BaseManager
    baseManager = await deployer.manager.deployBaseManagerV2(
      setToken.address,
      operator.address,
      operator.address
    );
    await baseManager.connect(operator.wallet).authorizeInitialization();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectManager: Address;
    let subjectWrapModule: Address;

    beforeEach(async () => {
      subjectManager = baseManager.address;
      subjectWrapModule = setV2Setup.wrapModule.address;
    });

    async function subject(): Promise<WrapExtension> {
      return await deployer.extensions.deployWrapExtension(
        subjectManager,
        subjectWrapModule
      );
    }

    it("should set the correct set token address", async () => {
      const wrapExtension = await subject();

      const actualSetToken = await wrapExtension.setToken();
      expect(actualSetToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const wrapExtension = await subject();

      const manager = await wrapExtension.manager();
      expect(manager).to.eq(subjectManager);
    });

    it("should set the correct wrap module address", async () => {
      const wrapExtension = await subject();

      const wrapModule = await wrapExtension.wrapModule();
      expect(wrapModule).to.eq(subjectWrapModule);
    });
  });

  context("when wrap extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      wrapExtension = await deployer.extensions.deployWrapExtension(
        baseManager.address,
        setV2Setup.wrapModule.address
      );

      await baseManager.connect(operator.wallet).addExtension(wrapExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManager.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectCaller = operator;
      });

      async function subject(): Promise<ContractTransaction> {
        return await wrapExtension.connect(subjectCaller.wallet).initialize();
      }

      it("should initialize WrapModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.wrapModule.address);
        expect(isInitialized).to.be.true;
      });

      context("when the operator is not the caller", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be operator");
        });
      });
    });

    context("when wrap extension is deployed and initialized", async () => {
      beforeEach(async () => {
        await wrapExtension.connect(operator.wallet).initialize();
      });

      describe("#wrap", async () => {
        let subjectCaller: Account;
        let subjectUnderlyingToken: Address;
        let subjectWrappedToken: Address;
        let subjectUnderlyingUnits: BigNumber;
        let subjectIntegrationName: string;

        beforeEach(async () => {
          subjectCaller = operator;
          subjectUnderlyingToken = setV2Setup.weth.address;
          subjectWrappedToken = wrapAdapter.address;
          subjectUnderlyingUnits = ether(0.1);
          subjectIntegrationName = wrapAdapterName;
        });

        async function subject(): Promise<ContractTransaction> {
          return await wrapExtension.connect(subjectCaller.wallet).wrap(
            subjectUnderlyingToken,
            subjectWrappedToken,
            subjectUnderlyingUnits,
            subjectIntegrationName
          );
        }

        it("should wrap the correct number of units", async () => {
          await subject();

          const wrappedTokenUnits = await setToken.getDefaultPositionRealUnit(subjectWrappedToken);
          const expectedWrappedTokenUnits = subjectUnderlyingUnits;  // 1 to 1 exchange rate
          expect(wrappedTokenUnits).to.eq(expectedWrappedTokenUnits);

          const underlyingTokenUnits = await setToken.getDefaultPositionRealUnit(subjectUnderlyingToken);
          const expectedUnderlyingTokenUnits = ZERO;
          expect(underlyingTokenUnits).to.eq(expectedUnderlyingTokenUnits);
        });

        context("when the operator is not the caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#wrapWithEther", async () => {
        let subjectCaller: Account;
        let subjectWrappedToken: Address;
        let subjectUnderlyingUnits: BigNumber;
        let subjectIntegrationName: string;

        beforeEach(async () => {
          subjectCaller = operator;
          subjectWrappedToken = wrapAdapter.address;
          subjectUnderlyingUnits = ether(0.1);
          subjectIntegrationName = wrapAdapterName;
        });

        async function subject(): Promise<ContractTransaction> {
          return await wrapExtension.connect(subjectCaller.wallet).wrapWithEther(
            subjectWrappedToken,
            subjectUnderlyingUnits,
            subjectIntegrationName
          );
        }

        it("should wrap the correct number of units", async () => {
          await subject();

          const wrappedTokenUnits = await setToken.getDefaultPositionRealUnit(subjectWrappedToken);
          const expectedWrappedTokenUnits = subjectUnderlyingUnits;  // 1 to 1 exchange rate
          expect(wrappedTokenUnits).to.eq(expectedWrappedTokenUnits);

          const underlyingTokenUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
          const expectedUnderlyingTokenUnits = ZERO;
          expect(underlyingTokenUnits).to.eq(expectedUnderlyingTokenUnits);
        });

        context("when the operator is not the caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#unwrap", async () => {
        let subjectCaller: Account;
        let subjectUnderlyingToken: Address;
        let subjectWrappedToken: Address;
        let subjectWrappedUnits: BigNumber;
        let subjectIntegrationName: string;

        beforeEach(async () => {
          subjectCaller = operator;
          subjectUnderlyingToken = setV2Setup.weth.address;
          subjectWrappedToken = wrapAdapter.address;
          subjectWrappedUnits = ether(0.1);
          subjectIntegrationName = wrapAdapterName;

          await wrapExtension.connect(operator.wallet).wrap(
            setV2Setup.weth.address,
            wrapAdapter.address,
            ether(0.1),
            wrapAdapterName
          );
        });

        async function subject(): Promise<ContractTransaction> {
          return await wrapExtension.connect(subjectCaller.wallet).unwrap(
            subjectUnderlyingToken,
            subjectWrappedToken,
            subjectWrappedUnits,
            subjectIntegrationName
          );
        }

        it("should unwrap the correct number of units", async () => {
          await subject();

          const wrappedTokenUnits = await setToken.getDefaultPositionRealUnit(subjectWrappedToken);
          const expectedWrappedTokenUnits = ZERO;
          expect(wrappedTokenUnits).to.eq(expectedWrappedTokenUnits);

          const underlyingTokenUnits = await setToken.getDefaultPositionRealUnit(subjectUnderlyingToken);
          const expectedUnderlyingTokenUnits = subjectWrappedUnits;   // 1 to 1 exchange rate
          expect(underlyingTokenUnits).to.eq(expectedUnderlyingTokenUnits);
        });

        context("when the operator is not the caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });

      describe("#unwrapWithEther", async () => {
        let subjectCaller: Account;
        let subjectWrappedToken: Address;
        let subjectWrappedUnits: BigNumber;
        let subjectIntegrationName: string;

        beforeEach(async () => {
          subjectCaller = operator;
          subjectWrappedToken = wrapAdapter.address;
          subjectWrappedUnits = ether(0.1);
          subjectIntegrationName = wrapAdapterName;

          await wrapExtension.connect(operator.wallet).wrap(
            setV2Setup.weth.address,
            wrapAdapter.address,
            ether(0.1),
            wrapAdapterName
          );

          await owner.wallet.sendTransaction({ to: wrapAdapter.address, value: ether(1000) });
        });

        async function subject(): Promise<ContractTransaction> {
          return await wrapExtension.connect(subjectCaller.wallet).unwrapWithEther(
            subjectWrappedToken,
            subjectWrappedUnits,
            subjectIntegrationName
          );
        }

        it("should unwrap the correct number of units", async () => {
          await subject();

          const wrappedTokenUnits = await setToken.getDefaultPositionRealUnit(subjectWrappedToken);
          const expectedWrappedTokenUnits = ZERO;
          expect(wrappedTokenUnits).to.eq(expectedWrappedTokenUnits);

          const underlyingTokenUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.weth.address);
          const expectedUnderlyingTokenUnits = subjectWrappedUnits;   // 1 to 1 exchange rate
          expect(underlyingTokenUnits).to.eq(expectedUnderlyingTokenUnits);
        });

        context("when the operator is not the caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be operator");
          });
        });
      });
    });
  });
});