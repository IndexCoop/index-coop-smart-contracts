// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.19;

import { IERC20 } from "openzeppelin-contracts-4.9/token/ERC20/IERC20.sol";

contract MockZeroExCallTarget {
  uint256 overrideAmountIn;
  uint256 overrideAmountOut;
  bytes overrideReturnData;
  bool toRevert;
  string revertReason;

  function trade(
    address _tokenIn,
    address _tokenOut,
    uint256 _maxAmountIn,
    uint256 _minAmountOut
  ) external returns (bytes memory) {
      return tradeWithUserAddress(msg.sender, _tokenIn, _tokenOut, _maxAmountIn, _minAmountOut);
  }

  function tradeWithUserAddress(
    address _user,
    address _tokenIn,
    address _tokenOut,
    uint256 _maxAmountIn,
    uint256 _minAmountOut
  ) public returns (bytes memory) {
    require(!toRevert, revertReason);
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

    tokenIn.transferFrom(_user, address(this), amountIn);
    tokenOut.transfer(_user, amountOut);

    return overrideReturnData;
  }
  function setOverrideAmounts(uint256 _amountIn, uint256 _amountOut) external {
    overrideAmountIn = _amountIn;
    overrideAmountOut = _amountOut;
  }

  function setOverrideReturnData(bytes memory _returnData) external {
    overrideReturnData = _returnData;
  }

  function setToRevert(bool _toRevert) external {
    toRevert = _toRevert;
  }
  function setRevertReason(string memory _revertReason) external {
    toRevert = true;
    revertReason = _revertReason;
  }
}

