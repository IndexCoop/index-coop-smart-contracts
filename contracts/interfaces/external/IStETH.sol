// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;

interface IStETH {
    function submit(address _referral) external payable returns (uint256);
}
