// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.19;

import { IERC20 } from "openzeppelin-contracts-4.9/token/ERC20/IERC20.sol";

contract MockZeroExCallTarget {
  uint256 overrideAmountIn;
  uint256 overrideAmountOut;
  bytes overrideReturnData;

  function trade(
    address _tokenIn,
    address _tokenOut,
    uint256 _maxAmountIn,
    uint256 _minAmountOut
  ) external returns (bool) {
    // Transfer tokens
    IERC20 tokenIn = IERC20(_tokenIn);
    IERC20 tokenOut = IERC20(_tokenOut);

    uint256 amountOut;
    if (overrideAmountOut > 0) {
      amountOut = overrideAmountOut;
    } else {
      amountOut = _minAmountOut;
    }

    uint256 amountIn;
    if (overrideAmountIn > 0) {
      amountIn = overrideAmountIn;
    } else {
      amountIn = _maxAmountIn;
    }

    tokenIn.transferFrom(msg.sender, address(this), amountIn);
    tokenOut.transfer(msg.sender, amountOut);

    return true;
  }

  function setOverrideAmounts(uint256 _amountIn, uint256 _amountOut) external {
    overrideAmountIn = _amountIn;
    overrideAmountOut = _amountOut;
  }

  function setOverrideReturnData(bytes memory _returnData) external {
    overrideReturnData = _returnData;
  }
}

