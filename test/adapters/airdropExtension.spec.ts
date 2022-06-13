import "module-alias/register";

import { Address, Account, AirdropSettings } from "@utils/types";
import { ADDRESS_ZERO, MAX_UINT_256, ONE } from "@utils/constants";
import { AirdropExtension, BaseManagerV2 } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getRandomAccount,
  getRandomAddress,
  getWaffleExpect,
  preciseDiv,
  preciseMul,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("AirdropExtension", () => {
  let owner: Account;
  let methodologist: Account;
  let operator: Account;
  let allowedCaller: Account;

  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let baseManagerV2: BaseManagerV2;
  let airdropExtension: AirdropExtension;

  before(async () => {
    [
      owner,
      methodologist,
      operator,
      allowedCaller,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();


    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(100)],
      [setV2Setup.airdropModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Issue some set tokens
    await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

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
    let subjectAirdropModule: Address;

    beforeEach(async () => {
      subjectManager = baseManagerV2.address;
      subjectAirdropModule = setV2Setup.airdropModule.address;
    });

    async function subject(): Promise<AirdropExtension> {
      return await deployer.extensions.deployAirdropExtension(
        subjectManager,
        subjectAirdropModule
      );
    }

    it("should set the correct set token address", async () => {
      const airdropExtension = await subject();

      const actualSetToken = await airdropExtension.setToken();
      expect(actualSetToken).to.eq(setToken.address);
    });

    it("should set the correct manager address", async () => {
      const airdropExtension = await subject();

      const manager = await airdropExtension.manager();
      expect(manager).to.eq(subjectManager);
    });

    it("should set the correct airdrop module address", async () => {
      const airdropExtension = await subject();

      const airdropModule = await airdropExtension.airdropModule();
      expect(airdropModule).to.eq(subjectAirdropModule);
    });
  });

  context("when airdrop extension is deployed and module needs to be initialized", async () => {
    beforeEach(async () => {
      airdropExtension = await deployer.extensions.deployAirdropExtension(
        baseManagerV2.address,
        setV2Setup.airdropModule.address
      );

      await baseManagerV2.connect(operator.wallet).addExtension(airdropExtension.address);

      // Transfer ownership to BaseManager
      await setToken.setManager(baseManagerV2.address);
    });

    describe("#initialize", async () => {
      let subjectCaller: Account;
      let subjectAirdropSettings: AirdropSettings;

      beforeEach(async () => {
        subjectCaller = operator;
        subjectAirdropSettings = {
          airdrops: [setV2Setup.dai.address],
          feeRecipient: await getRandomAddress(),
          airdropFee: BigNumber.from(12345),
          anyoneAbsorb: false,
        };
      });

      async function subject(): Promise<ContractTransaction> {
        return await airdropExtension.connect(subjectCaller.wallet).initializeAirdropModule(
          subjectAirdropSettings
        );
      }

      it("should initialize AirdropModule", async () => {
        await subject();

        const isInitialized = await setToken.isInitializedModule(setV2Setup.airdropModule.address);
        expect(isInitialized).to.be.true;
      });

      it("should set the correct AirdropSettings", async () => {
        await subject();

        const settings = await setV2Setup.airdropModule.airdropSettings(setToken.address);

        expect(settings.airdropFee).to.eq(subjectAirdropSettings.airdropFee);
        expect(settings.feeRecipient).to.eq(subjectAirdropSettings.feeRecipient);
        expect(settings.anyoneAbsorb).to.eq(subjectAirdropSettings.anyoneAbsorb);
      });

      it("should set the correct initial airdrops", async () => {
        await subject();

        const airdrops = await setV2Setup.airdropModule.getAirdrops(setToken.address);

        expect(airdrops.length).to.eq(ONE);
        expect(airdrops[0]).to.eq(setV2Setup.dai.address);
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

    context("when airdrop extension is deployed and initialized", async () => {
      beforeEach(async () => {
        await airdropExtension.connect(operator.wallet).initializeAirdropModule({
          airdrops: [setV2Setup.dai.address],
          feeRecipient: operator.address,
          airdropFee: BigNumber.from(0),
          anyoneAbsorb: false,
        });
      });

      describe("#absorb", async () => {
        let subjectTokenToAbsorb: Address;
        let subjectAirdropAmount: BigNumber;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectTokenToAbsorb = setV2Setup.dai.address;
          subjectAirdropAmount = ether(3);
          subjectCaller = allowedCaller;

          await airdropExtension.connect(operator.wallet).updateCallerStatus([allowedCaller.address], [true]);
          await setV2Setup.dai.transfer(setToken.address, subjectAirdropAmount);
        });

        async function subject(): Promise<ContractTransaction> {
          return await airdropExtension.connect(subjectCaller.wallet).absorb(subjectTokenToAbsorb);
        }

        it("should absorb the airdropped tokens", async () => {
          const totalSupply = await setToken.totalSupply();
          const initComponentUnits = await setToken.getDefaultPositionRealUnit(subjectTokenToAbsorb);

          await subject();

          const finalComponentUnits = await setToken.getDefaultPositionRealUnit(subjectTokenToAbsorb);
          const expectedComponentUnits = preciseDiv(preciseMul(totalSupply, initComponentUnits).add(subjectAirdropAmount), totalSupply);

          expect(finalComponentUnits).to.eq(expectedComponentUnits);
        });

        context("when the caller is not an allowed caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });

      describe("#batchAbsorb", async () => {
        let subjectTokensToAbsorb: Address[];
        let subjectAirdropAmount: BigNumber;
        let subjectCaller: Account;

        beforeEach(async () => {
          subjectTokensToAbsorb = [ setV2Setup.dai.address ];
          subjectAirdropAmount = ether(3);
          subjectCaller = allowedCaller;

          await airdropExtension.connect(operator.wallet).updateCallerStatus([allowedCaller.address], [true]);
          await setV2Setup.dai.transfer(setToken.address, subjectAirdropAmount);
        });

        async function subject(): Promise<ContractTransaction> {
          return await airdropExtension.connect(subjectCaller.wallet).batchAbsorb(subjectTokensToAbsorb);
        }

        it("should absorb the airdropped tokens", async () => {
          const totalSupply = await setToken.totalSupply();
          const initComponentUnits = await setToken.getDefaultPositionRealUnit(subjectTokensToAbsorb[0]);

          await subject();

          const finalComponentUnits = await setToken.getDefaultPositionRealUnit(subjectTokensToAbsorb[0]);
          const expectedComponentUnits = preciseDiv(preciseMul(totalSupply, initComponentUnits).add(subjectAirdropAmount), totalSupply);

          expect(finalComponentUnits).to.eq(expectedComponentUnits);
        });

        context("when the caller is not an allowed caller", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Address not permitted to call");
          });
        });
      });

      describe("#addAirdrop", async () => {
        let subjectAirdropToAdd: Address;
        let subjectCaller: Account;

        beforeEach(() => {
          subjectAirdropToAdd = setV2Setup.usdc.address;
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return airdropExtension.connect(subjectCaller.wallet).addAirdrop(subjectAirdropToAdd);
        }

        it("should add the new airdrop", async () => {
          const initAirdrops = await setV2Setup.airdropModule.getAirdrops(setToken.address);
          await subject();
          const finalAirdrops = await setV2Setup.airdropModule.getAirdrops(setToken.address);

          expect(finalAirdrops.length - initAirdrops.length).to.eq(ONE);
          expect(finalAirdrops[1]).to.eq(subjectAirdropToAdd);
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

      describe("#removeAirdrop", async () => {
        let subjectAirdropToRemove: Address;
        let subjectCaller: Account;

        beforeEach(() => {
          subjectAirdropToRemove = setV2Setup.dai.address;
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return airdropExtension.connect(subjectCaller.wallet).removeAirdrop(subjectAirdropToRemove);
        }

        it("should remove the specified airdrop", async () => {
          const initAirdrops = await setV2Setup.airdropModule.getAirdrops(setToken.address);
          await subject();
          const finalAirdrops = await setV2Setup.airdropModule.getAirdrops(setToken.address);

          expect(initAirdrops.length - finalAirdrops.length).to.eq(ONE);
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

      describe("#updateAnyoneAbsorb", async () => {
        let subjectAnyoneAbsorb: boolean;
        let subjectCaller: Account;

        beforeEach(() => {
          subjectAnyoneAbsorb = true;
          subjectCaller = operator;
        });

        async function subject(): Promise<ContractTransaction> {
          return airdropExtension.connect(subjectCaller.wallet).updateAnyoneAbsorb(subjectAnyoneAbsorb);
        }

        it("should update the anyoneAbsorb setting", async () => {
          const initSettings = await setV2Setup.airdropModule.airdropSettings(setToken.address);
          await subject();
          const finalSettings = await setV2Setup.airdropModule.airdropSettings(setToken.address);

          expect(initSettings.anyoneAbsorb).to.be.false;
          expect(finalSettings.anyoneAbsorb).to.be.true;
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
