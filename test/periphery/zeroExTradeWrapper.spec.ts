import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, Signer, utils } from "ethers";
import { expect } from "chai";
import {
  MockZeroExCallTarget,
  MockZeroExCallTarget__factory,
  StandardTokenMock,
  StandardTokenMock__factory,
  ZeroExTradeWrapper,
  ZeroExTradeWrapper__factory,
} from "../../typechain";

describe("ZeroExTradeWrapper", function() {
  let zeroExTradeWrapper: ZeroExTradeWrapper;
  let callTarget: MockZeroExCallTarget;
  let tokenA: StandardTokenMock;
  let tokenB: StandardTokenMock;
  let owner: Signer;
  let user: Signer;
  let totalTokenSupply: BigNumber;

  beforeEach(async function() {
    [owner, user] = await ethers.getSigners();

    callTarget = await new MockZeroExCallTarget__factory(owner).deploy();

    // Deploy the wrapper contract
    zeroExTradeWrapper = await new ZeroExTradeWrapper__factory(owner).deploy([callTarget.address]);

    totalTokenSupply = utils.parseEther("1000000000");
    // Deploy the tokens
    tokenA = await new StandardTokenMock__factory(owner).deploy(
      await owner.getAddress(),
      totalTokenSupply,
      "Token A",
      "A",
      18,
    );
    await tokenA.transfer(callTarget.address, totalTokenSupply.div(2));
    tokenB = await new StandardTokenMock__factory(owner).deploy(
      await owner.getAddress(),
      totalTokenSupply,
      "Token B",
      "B",
      18,
    );
    await tokenB.transfer(callTarget.address, totalTokenSupply.div(2));
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

  describe("#executeTrade", function() {
    let subjectCallTarget: string;
    let subjectCallData: string;
    let subjectTokenIn: StandardTokenMock;
    let subjectMaxAmountIn: BigNumber;
    let subjectTokenOut: StandardTokenMock;
    let subjectMinAmountOut: BigNumber;
    let subjectCaller: Signer;

    async function subject() {
      return zeroExTradeWrapper
        .connect(subjectCaller)
        .executeTrade(
          subjectCallTarget,
          subjectCallData,
          subjectTokenIn.address,
          subjectMaxAmountIn,
          subjectTokenOut.address,
          subjectMinAmountOut,
        );
    }

    beforeEach(async function() {
      subjectCaller = owner;
      subjectCallTarget = callTarget.address;
      subjectTokenIn = tokenA;
      subjectMaxAmountIn = BigNumber.from(1000);
      subjectTokenOut = tokenB;
      subjectMinAmountOut = (await subjectTokenOut.balanceOf(subjectCallTarget)).div(100);
      subjectCallData = callTarget.interface.encodeFunctionData("trade", [
        subjectTokenIn.address,
        subjectTokenOut.address,
        subjectMaxAmountIn,
        subjectMinAmountOut,
      ]);
    });

    describe("when wrapper contract IS NOT approved to spend input token", function() {
      it("should revert", async function() {
        await expect(subject()).to.be.reverted;
      });
    });
    describe("when wrapper contract IS approved to spend input token", function() {
      let inputAmountSpent: BigNumber;
      let outputAmountReceived: BigNumber;
      beforeEach(async function() {
        inputAmountSpent = subjectMaxAmountIn;
        outputAmountReceived = subjectMinAmountOut;
        await subjectTokenIn
          .connect(subjectCaller)
          .approve(zeroExTradeWrapper.address, subjectMaxAmountIn);
      });

      describe("when callTarget is not approved", function() {
        beforeEach(async function() {
          subjectCallTarget = await owner.getAddress();
        });
        it("should revert", async function() {
          await expect(subject()).to.be.revertedWith(
            "ZeroExTradeWrapper: Call target not approved",
          );
        });
      });

      describe("when input amount spent is less than max amount and output amount higher than min", function() {
        beforeEach(async function() {
          inputAmountSpent = subjectMaxAmountIn.div(2);
          outputAmountReceived = subjectMinAmountOut.mul(2);
          await callTarget.setOverrideAmounts(inputAmountSpent, outputAmountReceived);
        });
        it("should spend correct amount of input token", async function() {
          const inputBalanceBefore = await subjectTokenIn.balanceOf(await subjectCaller.getAddress());
          await subject();
          expect(await subjectTokenIn.balanceOf(await subjectCaller.getAddress())).to.eq(
            inputBalanceBefore.sub(inputAmountSpent),
          );
        });
        it("should receive correct amout of output token", async function() {
          const outputBalanceBefore = await subjectTokenOut.balanceOf(
            await subjectCaller.getAddress(),
          );
          await subject();
          expect(await subjectTokenOut.balanceOf(await subjectCaller.getAddress())).to.eq(
            outputBalanceBefore.add(outputAmountReceived),
          );
        });

        describe("when output amount is less than min amount", function() {
          beforeEach(async function() {
            outputAmountReceived = subjectMinAmountOut.div(2);
            await callTarget.setOverrideAmounts(inputAmountSpent, outputAmountReceived);
          });
          it("should revert", async function() {
            await expect(subject()).to.be.revertedWith(
              "ZeroExTradeWrapper: Insufficient tokens received",
            );
          });
        });
        describe("when zeroEx contract fails with custom revert reason", function() {
          let revertReason: string;
          beforeEach(async function() {
            revertReason = "Custom revert reason";
            await callTarget.setRevertReason(revertReason);
          });

          it("should pass through the revertReason", async function() {
            await expect(subject()).to.be.revertedWith(revertReason);
          });
        });
      });
    });
  });
});
