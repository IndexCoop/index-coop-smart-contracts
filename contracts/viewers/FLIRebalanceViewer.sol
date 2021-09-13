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

    SPDX-License-Identifier: Apache License, Version 2.0
*/
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { FlexibleLeverageStrategyExtension } from "../adapters/FlexibleLeverageStrategyExtension.sol";
import { IFLIStrategyExtension } from "../interfaces/IFLIStrategyExtension.sol";
import { IQuoter } from "../interfaces/IQuoter.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { StringArrayUtils } from "../lib/StringArrayUtils.sol";


/**
 * @title FLIRebalanceViewer
 * @author Set Protocol
 *
 * Viewer contract for FlexibleLeverageStrategyExtension. Used by keeper bots to determine which exchanges to use when rebalancing.
 * This contract can only determine whether to use Uniswap V3 or Uniswap V2 (or forks) for rebalancing. Since AMMTradeSplitter adheres to
 * the Uniswap V2 router interface, this contract is compatible with that as well.
 */
contract FLIRebalanceViewer {

    using PreciseUnitMath  for uint256;
    using SafeMath for uint256;
    using StringArrayUtils for string[];

    /* ============ Structs ============ */

    struct ActionInfo {
        string[] exchangeNames;                                                     // List of enabled exchange names
        FlexibleLeverageStrategyExtension.ShouldRebalance[] rebalanceActions;       // List of rebalance actions with respect to exchangeNames
        uint256 uniV3Index;                                                         // Index of Uni V3 in both lists
        uint256 uniV2Index;                                                         // Index of Uni V2 in both lists
        uint256 minLeverage;                                                        // Minimum leverage ratio of strategy
        uint256 maxLeverage;                                                        // Maximum leverage ratio of strategy
        uint256[] chunkSendQuantity;                                                // Size of rebalances (quoted in sell asset units)
        address sellAsset;                                                          // Address of asset to sell during rebalance
        address buyAsset;                                                           // Address of asset to buy during rebalance
        bool isLever;                                                               // Whether the rebalance is a lever or delever
    }

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
     * shouldRebalanceWithBound of FlexibleLeverageStrategyExtension. Note: this function is not marked as view
     * due to a quirk in the Uniswap V3 Quoter contract, but should be static called to save gas
     *
     * @param _minLeverageRatio       Min leverage ratio
     * @param _maxLeverageRatio       Max leverage ratio
     *
     * @return string[] memory              Ordered array of exchange names to use. Earlier elements in the array produce the best trades
     * @return ShouldRebalance[] memory     Array of ShouldRebalance Enums. Ordered relative to returned exchange names array
     */
    function shouldRebalanceWithBounds(
        uint256 _minLeverageRatio,
        uint256 _maxLeverageRatio
    )
        external
        returns(string[2] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[2] memory)
    {

        ActionInfo memory actionInfo = _getActionInfo(_minLeverageRatio, _maxLeverageRatio);

        (uint256 uniswapV3Price, uint256 uniswapV2Price) = _getPrices(actionInfo);

        return _getExchangePriority(
            uniswapV3Price,
            uniswapV2Price,
            actionInfo
        );
    }

    /* ================= Internal Functions ================= */

    /**
     * Fetches prices for rebalancing trades on Uniswap V3 and Uniswap V2. Trade sizes are determined by FlexibleLeverageStrategyExtension's
     * getChunkRebalanceNotional.
     *
     * @param _actionInfo    ActionInfo struct
     *
     * @return uniswapV3Price   price of rebalancing trade on Uniswap V3 (scaled by trade size)
     * @return uniswapV2Price   price of rebalancing trade on Uniswap V2 (scaled by trade size)
     */
    function _getPrices(ActionInfo memory _actionInfo) internal returns (uint256 uniswapV3Price, uint256 uniswapV2Price) {
        uniswapV3Price = _getV3Price(_actionInfo.chunkSendQuantity[_actionInfo.uniV3Index], _actionInfo.isLever);
        uniswapV2Price = _getV2Price(
            _actionInfo.chunkSendQuantity[_actionInfo.uniV2Index],
            _actionInfo.isLever, _actionInfo.sellAsset, _actionInfo.buyAsset
        );
    }

    /**
     * Fetches price of a Uniswap V3 trade. Uniswap V3 fetches quotes using a write function that always reverts. This means that
     * this function cannot be view only. Additionally, the Uniswap V3 quoting function cannot be static called in solidity due to the
     * internal revert. To save on gas, static call the top level shouldRebalanceWithBounds function when interacting with this contact
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
     * Fetches price of a Uniswap V2 trade
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
        if (uniswapV2TradePathRaw.length == 0) {
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
     * @param _actionInfo                   ActionInfo struct
     *
     * @return string[] memory              Ordered array of exchange names to use. Earlier elements in the array produce the best trades
     * @return ShouldRebalance[] memory     Array of ShouldRebalance Enums. Ordered relative to returned exchange names array
     */
    function _getExchangePriority(
        uint256 _uniswapV3Price,
        uint256 _uniswapV2Price,
        ActionInfo memory _actionInfo
    )
        internal
        view
        returns (string[2] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[2] memory)
    {

        // If no rebalance is required, set price to 0 so it is ordered last
        if (_actionInfo.rebalanceActions[_actionInfo.uniV3Index] == FlexibleLeverageStrategyExtension.ShouldRebalance.NONE) _uniswapV3Price = 0;
        if (_actionInfo.rebalanceActions[_actionInfo.uniV2Index] == FlexibleLeverageStrategyExtension.ShouldRebalance.NONE) _uniswapV2Price = 0;

        if (_uniswapV3Price > _uniswapV2Price) {
            return ([ uniswapV3ExchangeName, uniswapV2ExchangeName ],
                    [ _actionInfo.rebalanceActions[_actionInfo.uniV3Index], _actionInfo.rebalanceActions[_actionInfo.uniV2Index] ]);
        } else {
            return ([ uniswapV2ExchangeName, uniswapV3ExchangeName ],
                    [ _actionInfo.rebalanceActions[_actionInfo.uniV2Index], _actionInfo.rebalanceActions[_actionInfo.uniV3Index] ]);
        }
    }

    /**
     * Creates the an ActionInfo struct containing information about the rebalancing action
     *
     * @param _minLeverage          Min leverage ratio
     * @param _maxLeverage          Max leverage ratio
     *
     * @return actionInfo           Populated ActionInfo struct
     */
    function _getActionInfo(uint256 _minLeverage, uint256 _maxLeverage) internal view returns (ActionInfo memory actionInfo) {

        (actionInfo.exchangeNames, actionInfo.rebalanceActions) = fliStrategyExtension.shouldRebalanceWithBounds(
            _minLeverage,
            _maxLeverage
        );

        (actionInfo.uniV3Index, ) = actionInfo.exchangeNames.indexOf(uniswapV3ExchangeName);
        (actionInfo.uniV2Index, ) = actionInfo.exchangeNames.indexOf(uniswapV2ExchangeName);

        actionInfo.minLeverage = _minLeverage;
        actionInfo.maxLeverage = _maxLeverage;

        (actionInfo.chunkSendQuantity, actionInfo.sellAsset, actionInfo.buyAsset) = fliStrategyExtension.getChunkRebalanceNotional(
            actionInfo.exchangeNames
        );

        actionInfo.isLever = actionInfo.sellAsset == fliStrategyExtension.getStrategy().borrowAsset;
    }
}