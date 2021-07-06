/*
    Copyright 2021 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { FlexibleLeverageStrategyExtension } from "../adapters/FlexibleLeverageStrategyExtension.sol";
import { StringArrayUtils } from "../lib/StringArrayUtils.sol";
import { IFLIStrategyExtension } from "../interfaces/IFLIStrategyExtension.sol";
import { IQuoter } from "../interfaces/IQuoter.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title FLIRebalanceViewer
 * @author Set Protocol
 *
 * Viewer contract for FlexibleLeverageStrategyExtension. Used by keeper bots to determine which exchanges to use when rebalancing.
 * This contract can only determine whether to use Uniswap V3 or Uniswap V2 (or forks) for rebalancing. Since AMMTradeSplitter adheres to
 * the Uniswap V2 router interface, this contract is compatible with that as well.
 */
contract FLIRebalanceViewer {

    using StringArrayUtils for string[];
    using SafeMath for uint256;
    using PreciseUnitMath  for uint256;

    /* ============ State Variables ============ */

    IFLIStrategyExtension public fliStrategyExtension;

    IQuoter public uniswapV3Quoter;
    IUniswapV2Router public uniswapV2Router;

    string public uniswapV3ExchangeName;
    string public uniswapV2ExchangeName;

    /* ============ Constructor ============ */

    /**
     * Sets state variables
     *
     * @param _fliStrategyExtension     FlexibleLeverageStrategyAdapter contract address
     * @param _uniswapV3Quoter          Uniswap V3 Quoter contract address
     * @param _uniswapV2Router          Uniswap v2 Router contract address
     * @param _uniswapV3ExchangeName    Name of Uniswap V3 exchange in Set's IntegrationRegistry (ex: UniswapV3ExchangeAdapter)
     * @param _uniswapV2ExchangeName    Name of Uniswap V2 exchange in Set's IntegrationRegistry (ex: AMMSplitterExchangeAdapter)
     */
    constructor(
        IFLIStrategyExtension _fliStrategyExtension,
        IQuoter _uniswapV3Quoter,
        IUniswapV2Router _uniswapV2Router,
        string memory _uniswapV3ExchangeName,
        string memory _uniswapV2ExchangeName
    )
        public
    {
        fliStrategyExtension = _fliStrategyExtension;
        uniswapV3Quoter = _uniswapV3Quoter;
        uniswapV2Router = _uniswapV2Router;
        uniswapV3ExchangeName = _uniswapV3ExchangeName;
        uniswapV2ExchangeName = _uniswapV2ExchangeName;
    }

    /* =========== External Functions ============ */

    /**
     * Gets the priority order for which exchange should be used while rebalancing. Mimics the interface for
     * shouldRebalanceWithBound of FlexibleLeverageStrategyExtension.
     *
     * @param _customMinLeverageRatio       Min leverage ratio passed in by caller
     * @param _customMaxLeverageRatio       Max leverage ratio passed in by caller
     *
     * @return string[] memory              Ordered array of exchange names to use. Earlier elements in the array produce the best trades
     * @return ShouldRebalance[] memory     Array of ShouldRebalance Enums. Ordered relative to returned exchange names array
     */
    function shouldRebalanceWithBounds(
        uint256 _customMinLeverageRatio,
        uint256 _customMaxLeverageRatio
    )
        external
        returns(string[] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory)
    {

        string[] memory enabledExchanges = fliStrategyExtension.getEnabledExchanges();

        // Assume Uniswap V2 and Uniswap V3 are enabled as exchanges
        (uint256 uniV3Index, ) = enabledExchanges.indexOf(uniswapV3ExchangeName);
        (uint256 uniV2Index, ) = enabledExchanges.indexOf(uniswapV2ExchangeName);

        (uint256 uniswapV3Price, uint256 uniswapV2Price) = _getPrices(uniV3Index, uniV2Index);
        
        return _getExchangePriority(
            uniswapV3Price,
            uniswapV2Price,
            _customMinLeverageRatio,
            _customMaxLeverageRatio,
            uniV3Index,
            uniV2Index
        );
    }

    /* ================= Internal Functions ================= */

    /**
     * Fetches prices for rebalancing trades on Uniswap V3 and Uniswap V2. Trade sizes are determined by FlexibleLeverageStrategyExtension's
     * getChunkRebalanceNotional.
     *
     * @param _uniV3Index       index of Uniswap V3 in the list returned by FlexibleLeverageStrategyExtension's getExchangeNames
     * @param _uniV2Index       index of Uniswap V2 in the list returned by FlexibleLeverageStrategyExtension's getExchangeNames
     *
     * @return uniswapV3Price   price of rebalancing trade on Uniswap V3 (scaled by trade size)
     * @return uniswapV2Price   price of rebalancing trade on Uniswap V2 (scaled by trade size)
     */
    function _getPrices(uint256 _uniV3Index, uint256 _uniV2Index) internal returns (uint256 uniswapV3Price, uint256 uniswapV2Price) {

        string[] memory exchangeNames = new string[](2);
        exchangeNames[0] = uniswapV3ExchangeName;
        exchangeNames[1] = uniswapV2ExchangeName;

        (uint256[] memory chunkSendQuantity, address sellAsset, address buyAsset) = fliStrategyExtension.getChunkRebalanceNotional(exchangeNames);
        uint256 uniswapV3ChunkSellQuantity = chunkSendQuantity[_uniV3Index];
        uint256 uniswapV2ChunkSellQuantity = chunkSendQuantity[_uniV2Index];

        bool isLever = sellAsset == fliStrategyExtension.getStrategy().borrowAsset;

        uniswapV3Price = _getV3Price(uniswapV3ChunkSellQuantity, isLever);
        uniswapV2Price = _getV2Price(uniswapV2ChunkSellQuantity, isLever, sellAsset, buyAsset);
    }

    /**
     * Fetches price of a Uniswap V3 trade. Prices are quoted in units of the sell asset.
     *
     * @param _sellSize     quantity of asset to sell
     * @param _isLever      whether FLI needs to lever or delever
     *
     * @return uint256      price of trade on Uniswap V3
     */
    function _getV3Price(uint256 _sellSize, bool _isLever) internal returns (uint256) {
        
        bytes memory uniswapV3TradePath = _isLever ? 
            fliStrategyExtension.getExchangeSettings(uniswapV3ExchangeName).leverExchangeData : 
            fliStrategyExtension.getExchangeSettings(uniswapV3ExchangeName).deleverExchangeData;

        uint256 outputAmount = uniswapV3Quoter.quoteExactInput(uniswapV3TradePath, _sellSize);

        // Divide to get ratio of quote / base asset. Don't care about decimals here. Standardizes to 10e18 with preciseDiv
        return outputAmount.preciseDiv(_sellSize);
    }

    /**
     * Fetches price of a Uniswap V2 trade. Prices are quoted in units of the sell asset.
     *
     * @param _sellSize     quantity of asset to sell
     * @param _isLever      whether FLI needs to lever or delever
     *
     * @return uint256      price of trade on Uniswap V2
     */
    function _getV2Price(uint256 _sellSize, bool _isLever, address _sellAsset, address _buyAsset) internal view returns (uint256) {
        
        bytes memory uniswapV2TradePathRaw = _isLever ? 
            fliStrategyExtension.getExchangeSettings(uniswapV2ExchangeName).leverExchangeData : 
            fliStrategyExtension.getExchangeSettings(uniswapV2ExchangeName).deleverExchangeData;

        address[] memory uniswapV2TradePath;
        if (keccak256(bytes(uniswapV2TradePathRaw)) == keccak256(bytes(""))) {
            uniswapV2TradePath = new address[](2);
            uniswapV2TradePath[0] = _sellAsset;
            uniswapV2TradePath[1] = _buyAsset;
        } else {
            uniswapV2TradePath = abi.decode(uniswapV2TradePathRaw, (address[]));
        }
        
        uint256 outputAmount = uniswapV2Router.getAmountsOut(_sellSize, uniswapV2TradePath)[uniswapV2TradePath.length.sub(1)];
        
        // Divide to get ratio of quote / base asset. Don't care about decimals here. Standardizes to 10e18 with preciseDiv
        return outputAmount.preciseDiv(_sellSize);
    }

    /**
     * Gets the ordered priority of which exchanges to use for a rebalance
     *
     * @param _uniswapV3Price               price of rebalance trade on Uniswap V3
     * @param _uniswapV2Price               price of rebalance trade on Uniswap V2
     * @param _customMinLeverageRatio       Min leverage ratio passed in by caller
     * @param _customMaxLeverageRatio       Max leverage ratio passed in by caller
     * @param _uniV3Index                   index of Uniswap V3 in the list returned by FlexibleLeverageStrategyExtension's getExchangeNames
     * @param _uniV2Index                   index of Uniswap V2 in the list returned by FlexibleLeverageStrategyExtension's getExchangeNames
     *
     * @return string[] memory              Ordered array of exchange names to use. Earlier elements in the array produce the best trades
     * @return ShouldRebalance[] memory     Array of ShouldRebalance Enums. Ordered relative to returned exchange names array
     */
    function _getExchangePriority(
        uint256 _uniswapV3Price,
        uint256 _uniswapV2Price,
        uint256 _customMinLeverageRatio,
        uint256 _customMaxLeverageRatio,
        uint256 _uniV3Index,
        uint256 _uniV2Index
    )
        internal
        view returns (string[] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory)
    {

        (, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory rebalanceAction) = fliStrategyExtension.shouldRebalanceWithBounds(
            _customMinLeverageRatio,
            _customMaxLeverageRatio
        );

        string[] memory exchangeNamesOrdered = new string[](2);
        FlexibleLeverageStrategyExtension.ShouldRebalance[] memory rebalanceActionOrdered = new FlexibleLeverageStrategyExtension.ShouldRebalance[](2);

        if (_uniswapV3Price > _uniswapV2Price) {
            exchangeNamesOrdered[0] = uniswapV3ExchangeName;
            rebalanceActionOrdered[0] = rebalanceAction[_uniV3Index];

            exchangeNamesOrdered[1] = uniswapV2ExchangeName;
            rebalanceActionOrdered[1] = rebalanceAction[_uniV2Index];
        } else {
            exchangeNamesOrdered[0] = uniswapV2ExchangeName;
            rebalanceActionOrdered[0] = rebalanceAction[_uniV2Index];

            exchangeNamesOrdered[1] = uniswapV3ExchangeName;
            rebalanceActionOrdered[1] = rebalanceAction[_uniV3Index];
        }

        return (exchangeNamesOrdered, rebalanceActionOrdered);
    }
}