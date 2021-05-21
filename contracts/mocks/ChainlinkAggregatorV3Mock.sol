pragma solidity 0.6.10;


contract ChainlinkAggregatorV3Mock {
    
    int256 private latestPrice;

    constructor() public {
        latestPrice = 0;
    }

    function setPrice(int256 _price) external {
        latestPrice = _price;
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        return (0, latestPrice, 0, 0, 0);
    }
}