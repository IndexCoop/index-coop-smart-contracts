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
}