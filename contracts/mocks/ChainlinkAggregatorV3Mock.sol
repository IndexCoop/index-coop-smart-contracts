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
}