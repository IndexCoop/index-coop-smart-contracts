// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { FlexibleLeverageStrategyExtension } from "../adapters/FlexibleLeverageStrategyExtension.sol";

// Mock contract for FlexibleLeverageStrategyExtension used to test FLIRebalanceViewer
contract FLIStrategyExtensionMock {

    string[] internal shouldRebalanceNames;
    FlexibleLeverageStrategyExtension.ShouldRebalance[] internal shouldRebalancesEnums;

    uint256[] internal chunkRebalanceSizes;
    address internal chunkRebalanceSellAsset;
    address internal chunkRebalanceBuyAsset;

    FlexibleLeverageStrategyExtension.ContractSettings internal strategy;

    mapping(string => FlexibleLeverageStrategyExtension.ExchangeSettings) internal exchangeSettings;


    function shouldRebalanceWithBounds(
        uint256 /* _customMinLeverageRatio */,
        uint256 /* _customMaxLeverageRatio */
    )
        external
        view
        returns(string[] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory)
    {
        return (shouldRebalanceNames, shouldRebalancesEnums);
    }

    function getChunkRebalanceNotional(
        string[] calldata /* _exchangeNames */
    )
        external
        view
        returns(uint256[] memory sizes, address sellAsset, address buyAsset)
    {
        sizes = chunkRebalanceSizes;
        sellAsset = chunkRebalanceSellAsset;
        buyAsset = chunkRebalanceBuyAsset;
    }

    function getStrategy() external view returns (FlexibleLeverageStrategyExtension.ContractSettings memory) {
        return strategy;
    }

    function getExchangeSettings(string memory _exchangeName) external view returns (FlexibleLeverageStrategyExtension.ExchangeSettings memory) {
        return exchangeSettings[_exchangeName];
    }

    function getEnabledExchanges() external view returns (string[] memory) {
        return shouldRebalanceNames;
    }

    /* =========== Functions for setting mock state =========== */

    function setShouldRebalanceWithBounds(
        string[] memory _shouldRebalanceNames,
        FlexibleLeverageStrategyExtension.ShouldRebalance[] memory _shouldRebalancesEnums
    )
        external
    {
        shouldRebalanceNames = _shouldRebalanceNames;
        shouldRebalancesEnums = _shouldRebalancesEnums;
    }

    function setGetChunkRebalanceWithBounds(
        uint256[] memory _chunkRebalanceSizes,
        address _chunkRebalanceSellAsset,
        address _chunkRebalanceBuyAsset
    )
        external
    {
        chunkRebalanceSizes = _chunkRebalanceSizes;
        chunkRebalanceSellAsset = _chunkRebalanceSellAsset;
        chunkRebalanceBuyAsset = _chunkRebalanceBuyAsset;
    }

    function setStrategy(FlexibleLeverageStrategyExtension.ContractSettings memory _strategy) external {
        strategy = _strategy;
    }

    function setExchangeSettings(string memory _exchangeName, FlexibleLeverageStrategyExtension.ExchangeSettings memory _settings) external {
        exchangeSettings[_exchangeName] = _settings;
    }
}