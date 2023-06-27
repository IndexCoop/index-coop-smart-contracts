// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;


contract ChainlinkAggregatorV3Mock {

    int256 private latestPrice;

    constructor() public {
        latestPrice = 0;
    }

    function setPrice(int256 _price) external {
        latestPrice = _price;
    }

    function latestAnswer() external view returns (int256) {
        return latestPrice;
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (0, latestPrice, block.timestamp - 10, block.timestamp - 1, 0);
    }
}
