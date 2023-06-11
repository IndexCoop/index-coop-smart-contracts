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
    zeroExTradeWrapper = await new ZeroExTradeWrapper__factory(owner).deploy(callTarget.address);

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
    await tokenA.transfer(await user.getAddress(), totalTokenSupply.div(2));
    tokenB = await new StandardTokenMock__factory(owner).deploy(
      await owner.getAddress(),
      totalTokenSupply,
      "Token B",
      "B",
      18,
    );
    await tokenB.transfer(callTarget.address, totalTokenSupply.div(2));
    await tokenB.transfer(await user.getAddress(), totalTokenSupply.div(2));
  });

  describe("#executeTrade", function() {
    let subjectCallData: string;
    let tokenIn: StandardTokenMock;
    let subjectTokenIn: string;
    let subjectMaxAmountIn: BigNumber;
    let tokenOut: StandardTokenMock;
    let subjectTokenOut: string;
    let subjectMinAmountOut: BigNumber;
    let subjectCaller: Signer;

    async function subject() {
      return zeroExTradeWrapper
        .connect(subjectCaller)
        .executeTrade(
          subjectCallData,
          subjectTokenIn,
          subjectMaxAmountIn,
          subjectTokenOut,
          subjectMinAmountOut,
        );
    }

    beforeEach(async function() {
      subjectCaller = user;
      tokenIn = tokenA;
      subjectTokenIn = tokenIn.address;
      subjectMaxAmountIn = BigNumber.from(1000);
      tokenOut = tokenB;
      subjectTokenOut = tokenOut.address;
      subjectMinAmountOut = (await tokenOut.balanceOf(callTarget.address)).div(100);
      subjectCallData = callTarget.interface.encodeFunctionData("trade", [
        subjectTokenIn,
        subjectTokenOut,
        subjectMaxAmountIn,
        subjectMinAmountOut,
      ]);
    });

    describe("when tradeTarget sends / receives tokens directly from user", function() {
      beforeEach(async function() {
        subjectCaller = user;
        subjectTokenIn = ethers.constants.AddressZero;
        subjectMaxAmountIn = BigNumber.from(1000);
        subjectTokenOut = ethers.constants.AddressZero;
        subjectMinAmountOut = (await tokenOut.balanceOf(callTarget.address)).div(100);
        subjectCallData = callTarget.interface.encodeFunctionData("tradeWithUserAddress", [
          await subjectCaller.getAddress(),
          tokenA.address,
          tokenB.address,
          subjectMaxAmountIn,
          subjectMinAmountOut,
        ]);

        await tokenA.connect(subjectCaller).approve(callTarget.address, subjectMaxAmountIn);
      });
      it("should spend correct amount of input token", async function() {
        const inputBalanceBefore = await tokenIn.balanceOf(await subjectCaller.getAddress());
        await subject();
        expect(await tokenIn.balanceOf(await subjectCaller.getAddress())).to.eq(
          inputBalanceBefore.sub(subjectMaxAmountIn),
        );
      });
      it("should receive correct amout of output token", async function() {
        const outputBalanceBefore = await tokenOut.balanceOf(await subjectCaller.getAddress());
        await subject();
        expect(await tokenOut.balanceOf(await subjectCaller.getAddress())).to.eq(
          outputBalanceBefore.add(subjectMinAmountOut),
        );
      });
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
        await tokenIn
          .connect(subjectCaller)
          .approve(zeroExTradeWrapper.address, subjectMaxAmountIn);
      });

      describe("when input amount spent is less than max amount and output amount higher than min", function() {
        beforeEach(async function() {
          inputAmountSpent = subjectMaxAmountIn.div(2);
          outputAmountReceived = subjectMinAmountOut.mul(2);
          await callTarget.setOverrideAmounts(inputAmountSpent, outputAmountReceived);
        });
        it("should spend correct amount of input token", async function() {
          const inputBalanceBefore = await tokenIn.balanceOf(await subjectCaller.getAddress());
          await subject();
          expect(await tokenIn.balanceOf(await subjectCaller.getAddress())).to.eq(
            inputBalanceBefore.sub(inputAmountSpent),
          );
        });
        it("should receive correct amout of output token", async function() {
          const outputBalanceBefore = await tokenOut.balanceOf(await subjectCaller.getAddress());
          await subject();
          expect(await tokenOut.balanceOf(await subjectCaller.getAddress())).to.eq(
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
