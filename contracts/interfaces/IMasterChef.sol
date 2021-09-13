// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

interface IMasterChef {
    function userInfo(uint256 nr, address who) external view returns (uint256, uint256);
}