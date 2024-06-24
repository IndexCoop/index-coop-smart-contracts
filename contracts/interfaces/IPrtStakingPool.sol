// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity ^0.6.10;

interface IPrtStakingPool {
    function accrue(uint256 _amount) external;
    function distributor() external view returns (address);
    function stakeToken() external view returns (address);
    function rewardToken() external view returns (address);
}
