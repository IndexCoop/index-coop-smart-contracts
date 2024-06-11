// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity ^0.6.10;

interface IPrtStakingPool {
    function stake(uint256 _amount) external;
    function unstake(uint256 _amount) external;
    function accrue(uint256 _amount) external;
    function claim() external;
    function setFeeSplitExtension(address _feeSplitExtension) external;
    function getCurrentId() external view returns (uint256); 
    function getPendingRewards(address _account) external view returns (uint256); 
    function getSnapshotRewards(uint256 _snapshotId, address _account) external view returns (uint256);
    function feeSplitExtension() external view returns (address);
    function prt() external view returns (address);
}
