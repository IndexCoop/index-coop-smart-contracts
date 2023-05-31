import "module-alias/register";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { expect } from "chai";
import {
  MockZeroExCallTarget,
  MockZeroExCallTarget__factory,
  ZeroExTradeWrapper,
  ZeroExTradeWrapper__factory,
} from "../../typechain";

describe("ZeroExTradeWrapper", function() {
  let zeroExTradeWrapper: ZeroExTradeWrapper;
  let callTarget: MockZeroExCallTarget;
  let owner: Signer;
  let user: Signer;

  beforeEach(async function() {
    [owner, user] = await ethers.getSigners();

    callTarget = await new MockZeroExCallTarget__factory(owner).deploy();

    // Deploy the wrapper contract
    zeroExTradeWrapper = await new ZeroExTradeWrapper__factory(owner).deploy([callTarget.address]);
  });

  describe("#changeCallTargetApproval", function() {
    let subjectCallTarget: string;
    let subjectApprovalStatus: boolean;
    let caller: Signer;

    async function subject(): Promise<any> {
      return zeroExTradeWrapper
        .connect(caller)
        .changeCallTargetApprovalStatus(subjectCallTarget, subjectApprovalStatus);
    }
    describe("when caller is owner", function() {
      beforeEach(function() {
        caller = owner;
      });
      describe("when approving new call target", function() {
        beforeEach(function() {
          subjectCallTarget = "0x1234567890123456789012345678901234567890";
          subjectApprovalStatus = true;
        });

        it("should set the call target approval status", async function() {
          await subject();
          expect(await zeroExTradeWrapper.approvedCallTargets(subjectCallTarget)).to.be.true;
        });
      });

      describe("when removing approval for call target", function() {
        beforeEach(async function() {
          subjectCallTarget = callTarget.address;
          subjectApprovalStatus = false;
        });
        it("should set the call target approval status", async function() {
          await subject();
          expect(await zeroExTradeWrapper.approvedCallTargets(subjectCallTarget)).to.be.false;
        });
      });
    });
    describe("whenc caller is not the owner", function() {
      beforeEach(function() {
        caller = user;
      });
      it("should revert", async function() {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });
});
