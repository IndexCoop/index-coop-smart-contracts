import "module-alias/register";

import DeployHelper from "@utils/deploys";
import { SetFixture } from "@utils/fixtures";
import { SetToken } from "@utils/contracts/setV2";
import {
  ERC4626WrapV2Adapter,
  StandardTokenMock,
  ERC4626Mock,
} from "@utils/contracts/index";
import { Account, Address } from "@utils/types";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getSetFixture,
  getWaffleExpect,
} from "@utils/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO, ZERO_BYTES } from "@utils/constants";
import { BigNumber } from "ethers";

const expect = getWaffleExpect();

describe("ERC4626WrapV2Adapter", async () => {
  let owner: Account;

  let deployer: DeployHelper;
  let setV2Setup: SetFixture;

  let setToken: SetToken;

  let wrapAdapter: ERC4626WrapV2Adapter;
  let wrapAdapterName: string;

  let underlyingToken: StandardTokenMock;
  let wrappedToken: ERC4626Mock;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSetFixture(owner.address);
    await setV2Setup.initialize();

    // setup wrap adapter
    wrapAdapter = await deployer.extensions.deployERC4626WrapV2Adapter();
    wrapAdapterName = "ERC462_WRAP_ADAPTER";
    await setV2Setup.integrationRegistry.addIntegration(
      setV2Setup.wrapModule.address,
      wrapAdapterName,
      wrapAdapter.address
    );

    setToken = await setV2Setup.createSetToken(
      [setV2Setup.usdc.address],
      [ether(0.1)],
      [setV2Setup.wrapModule.address, setV2Setup.issuanceModule.address]
    );

    await setV2Setup.issuanceModule.initialize(
      setToken.address,
      ADDRESS_ZERO
    );

    // Issue some set tokens
    await setV2Setup.usdc.approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await setV2Setup.issuanceModule.issue(setToken.address, ether(5), owner.address);

    // setup mock vault
    underlyingToken = setV2Setup.usdc;
    wrappedToken = await deployer.mocks.deployERC4626Mock("maUSDC", "maUSDC", setV2Setup.usdc.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getSpenderAddress", async () => {
    async function subject(): Promise<any> {
      return wrapAdapter.getSpenderAddress(underlyingToken.address, wrappedToken.address);
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(wrappedToken.address);
    });
  });

  describe("#getWrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectUnderlyingUnits: BigNumber;
    let subjectTo: Address;
    let subjectWrapData: string;

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectUnderlyingUnits = ether(2);
      subjectTo = setToken.address;
      subjectWrapData = ZERO_BYTES;
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return wrapAdapter.getWrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectUnderlyingUnits, subjectTo, subjectWrapData);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = wrappedToken.interface.encodeFunctionData(
        "deposit",
        [subjectUnderlyingUnits, subjectTo]
      );

      expect(targetAddress).to.eq(wrappedToken.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid wrapped token / underlying token pair", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = setV2Setup.dai.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });
  });

  describe("#getUnwrapCallData", async () => {
    let subjectUnderlyingToken: Address;
    let subjectWrappedToken: Address;
    let subjectWrappedTokenUnits: BigNumber;
    let subjectTo: Address;
    let subjectUnwrapData: string;

    beforeEach(async () => {
      subjectUnderlyingToken = underlyingToken.address;
      subjectWrappedToken = wrappedToken.address;
      subjectWrappedTokenUnits = ether(2);
      subjectTo = setToken.address;
      subjectUnwrapData = ZERO_BYTES;
    });

    async function subject(): Promise<[string, BigNumber, string]> {
      return wrapAdapter.getUnwrapCallData(subjectUnderlyingToken, subjectWrappedToken, subjectWrappedTokenUnits, subjectTo, subjectUnwrapData);
    }

    it("should return correct data for valid pair", async () => {
      const [targetAddress, ethValue, callData] = await subject();

      const expectedCallData = wrappedToken.interface.encodeFunctionData(
        "withdraw",
        [subjectWrappedTokenUnits, subjectTo, subjectTo]
      );

      expect(targetAddress).to.eq(wrappedToken.address);
      expect(ethValue).to.eq(ZERO);
      expect(callData).to.eq(expectedCallData);
    });

    describe("when invalid wrapped token / underlying token pair", () => {
      beforeEach(async () => {
        subjectUnderlyingToken = underlyingToken.address;
        subjectWrappedToken = setV2Setup.dai.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid token pair");
      });
    });
  });
});
