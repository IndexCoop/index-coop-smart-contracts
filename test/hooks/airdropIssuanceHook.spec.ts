import "module-alias/register";

import { Address, Account } from "@utils/types";
import { AirdropIssuanceHook } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
  getRandomAddress,
} from "@utils/index";
import { SetFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { MAX_UINT_256 } from "@utils/constants";
import { preciseDiv, preciseMul } from "@utils/common";

const expect = getWaffleExpect();

describe("AirdropIssuanceHook", () => {
  let owner: Account;
  let setV2Setup: SetFixture;

  let deployer: DeployHelper;
  let setToken: SetToken;

  let issuanceHook: AirdropIssuanceHook;

  before(async () => {
    [ owner ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.dai.address],
      [ether(1)],
      [setV2Setup.issuanceModule.address, setV2Setup.airdropModule.address]
    );

    issuanceHook = await deployer.hooks.deployAirdropIssuanceHook(setV2Setup.airdropModule.address);

    // initialize modules
    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      issuanceHook.address
    );

    await setV2Setup.airdropModule.initialize(
      setToken.address,
      {
        airdrops: [setV2Setup.dai.address],
        feeRecipient: owner.address,
        airdropFee: ether(0),
        anyoneAbsorb: true,
      }
    );

    // issue some tokes
    await setV2Setup.dai.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(1), await getRandomAddress());
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectAirdropModule: Address;

    beforeEach(async () => {
      subjectAirdropModule = await getRandomAddress();
    });

    async function subject(): Promise<AirdropIssuanceHook> {
      return await deployer.hooks.deployAirdropIssuanceHook(subjectAirdropModule);
    }

    it("should set the correct AirdropModule address", async () => {
      const hook = await subject();

      const airdropModule = await hook.airdropModule();
      expect(airdropModule).to.eq(subjectAirdropModule);
    });
  });

  describe("#invokePreIssueHook", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectCaller = owner;
      await setV2Setup.dai.connect(subjectCaller.wallet).approve(setV2Setup.issuanceModule.address, ether(100));

      subjectSetToken = setToken.address;
      subjectQuantity = ether(5);
      subjectTo = owner.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await setV2Setup.issuanceModule.connect(subjectCaller.wallet).issue(
        subjectSetToken,
        subjectQuantity,
        subjectTo
      );
    }

    it("should issue the correct amount of set tokens", async () => {
      const initSetAmount = await setToken.balanceOf(subjectTo);
      await subject();
      const finalSetAmount = await setToken.balanceOf(subjectTo);

      expect(finalSetAmount.sub(initSetAmount)).to.eq(subjectQuantity);
    });

    it("should spend the correct amount of component tokens", async () => {
      const initComponentAmount = await setV2Setup.dai.balanceOf(subjectCaller.address);
      await subject();
      const finalComponentAmount = await setV2Setup.dai.balanceOf(subjectCaller.address);

      expect(initComponentAmount.sub(finalComponentAmount)).to.eq(subjectQuantity);
    });

    context("when tokens are airdropped to the set", async () => {
      let subjectAirdropAmount: BigNumber;

      beforeEach(async () => {
        subjectCaller = owner;
        await setV2Setup.dai.connect(subjectCaller.wallet).approve(setV2Setup.issuanceModule.address, ether(100));

        subjectSetToken = setToken.address;
        subjectQuantity = ether(5);
        subjectTo = owner.address;
        subjectAirdropAmount = ether(2);

        await setV2Setup.dai.transfer(setToken.address, subjectAirdropAmount);
      });

      it("should absorb airdropped tokens", async () => {
        const initUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.dai.address);
        const totalSupply = await setToken.totalSupply();

        await subject();

        const finalUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.dai.address);

        const totalComponentAmount = preciseMul(initUnits, totalSupply);
        const expectedNewUnits = preciseDiv(totalComponentAmount.add(subjectAirdropAmount), totalSupply);

        expect(finalUnits).to.eq(expectedNewUnits);
      });

      it("should issue the correct amount of set tokens", async () => {
        const initSetAmount = await setToken.balanceOf(subjectTo);
        await subject();
        const finalSetAmount = await setToken.balanceOf(subjectTo);

        expect(finalSetAmount.sub(initSetAmount)).to.eq(subjectQuantity);
      });

      it("should spend the correct amount of component tokens", async () => {
        const initComponentAmount = await setV2Setup.dai.balanceOf(subjectCaller.address);

        await subject();

        const finalComponentAmount = await setV2Setup.dai.balanceOf(subjectCaller.address);
        const componentUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.dai.address);

        expect(initComponentAmount.sub(finalComponentAmount)).to.eq(preciseMul(componentUnits, subjectQuantity));
      });
    });
  });

  describe("#invokePreRedeemHook", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectSender: Address;
    let subjectTo: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectQuantity = ether(0);
      subjectSender = await getRandomAddress();
      subjectTo = await getRandomAddress();
    });

    async function subject(): Promise<ContractTransaction> {
      return await issuanceHook.invokePreRedeemHook(subjectSetToken, subjectQuantity, subjectSender, subjectTo);
    }

    context("when tokens are airdropped to the set", async () => {
      let subjectAirdropAmount: BigNumber;

      beforeEach(async () => {
        subjectAirdropAmount = ether(2);
        await setV2Setup.dai.transfer(setToken.address, subjectAirdropAmount);
      });

      it("should absorb airdropped tokens", async () => {
        const initUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.dai.address);
        const totalSupply = await setToken.totalSupply();

        await subject();

        const finalUnits = await setToken.getDefaultPositionRealUnit(setV2Setup.dai.address);

        const totalComponentAmount = preciseMul(initUnits, totalSupply);
        const expectedNewUnits = preciseDiv(totalComponentAmount.add(subjectAirdropAmount), totalSupply);

        expect(finalUnits).to.eq(expectedNewUnits);
      });
    });
  });
});