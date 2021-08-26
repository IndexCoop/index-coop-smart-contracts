// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

interface IChainlinkAggregatorV3 {
    function latestAnswer() external view returns (int256);
}