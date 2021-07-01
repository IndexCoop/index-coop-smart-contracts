pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { FlexibleLeverageStrategyExtension } from "../adapters/FlexibleLeverageStrategyExtension.sol";
import { StringArrayUtils } from "../lib/StringArrayUtils.sol";
import { IFLIStrategyExtension } from "../interfaces/IFLIStrategyExtension.sol";
import { IQuoter } from "../interfaces/IQuoter.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

contract FLIRebalanceViewer {

    using StringArrayUtils for string[];
    using SafeMath for uint256;
    using PreciseUnitMath  for uint256;

    IFLIStrategyExtension public fliStrategyExtension;
    IQuoter public uniswapV3Quoter;
    IUniswapV2Router public uniswapV2Router;
    string public uniswapV3ExchangeName;
    string public uniswapV2ExchangeName;

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

    function _getPrices(uint256 _uniV3Index, uint256 _uniV2Index) internal returns (uint256 uniswapV3Price, uint256 uniswapV2Price) {

        // Get notional to rebalance from FLI adapter for V3 and V2
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

    function _getV3Price(uint256 _sellSize, bool _isLever) internal returns (uint256) {
        // Get V3 trade path. The exchange data is the encoded path
        bytes memory uniswapV3TradePath = _isLever ? 
            fliStrategyExtension.getExchangeSettings(uniswapV3ExchangeName).leverExchangeData : 
            fliStrategyExtension.getExchangeSettings(uniswapV3ExchangeName).deleverExchangeData;

        // Get quote from Uniswap V3 SwapRouter
        uint256 outputAmount = uniswapV3Quoter.quoteExactInput(uniswapV3TradePath, _sellSize);

        // Divide to get ratio of quote / base asset. Don't care about decimals here. Standardizes to 10e18 with preciseDiv
        return outputAmount.preciseDiv(_sellSize);
    }

    function _getV2Price(uint256 _sellSize, bool _isLever, address _sellAsset, address _buyAsset) internal view returns (uint256) {
        // Get V2 trade path. The exchange data is the encoded path
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
        
        // Get quote from Uniswap V2 Router
        uint256 outputAmount = uniswapV2Router.getAmountsOut(_sellSize, uniswapV2TradePath)[uniswapV2TradePath.length.sub(1)];
        
        // Divide to get ratio of quote / base asset. Don't care about decimals here. Standardizes to 10e18 with preciseDiv
        return outputAmount.preciseDiv(_sellSize);
    }

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

        // Check shouldRebalanceWithBounds on strategy adapter
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