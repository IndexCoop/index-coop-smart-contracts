// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.6.10;


interface IAToken {
  /**
   * @dev Returns the address of the underlying asset of this aToken (E.g. WETH for aWETH)
   **/
  function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}
