// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;


contract ChainlinkAggregatorV3Mock {

    int256 private latestPrice;
    uint256 private priceAge;

    constructor() public {
        latestPrice = 0;
    }

    function setPrice(int256 _price) external {
        latestPrice = _price;
    }

    function latestAnswer() external view returns (int256) {
        return latestPrice;
    }

    function setPriceAge(uint256 _priceAge) external {
        priceAge = _priceAge;
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        answer = latestPrice;
        updatedAt = block.timestamp - priceAge;
        startedAt = updatedAt - 1;
    }
}
