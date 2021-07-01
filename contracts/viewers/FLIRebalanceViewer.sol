pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { FlexibleLeverageStrategyExtension } from "../adapters/FlexibleLeverageStrategyExtension.sol";
import { StringArrayUtils } from "../lib/StringArrayUtils.sol";
import { IFLIStrategyExtension } from "../interfaces/IFLIStrategyExtension.sol";
import { IQuoter } from "../interfaces/IQuoter.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

import { console } from "hardhat/console.sol";

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
        view
        returns(string[] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory)
    {

        (uint256 uniswapV3Price, uint256 uniswapV2Price) = _getPrices();
        
        return _getPriorityExchange(uniswapV3Price, uniswapV2Price, _customMinLeverageRatio, _customMaxLeverageRatio);
    }

    /* ================= Internal Functions ================= */

    function _getPrices() internal view returns (uint256 uniswapV3Price, uint256 uniswapV2Price) {
        // Get notional to rebalance from FLI adapter for V3 and V2
        string[] memory exchangeNames = new string[](2);
        exchangeNames[0] = uniswapV3ExchangeName;
        exchangeNames[1] = uniswapV2ExchangeName;

        (uint256[] memory chunkSendQuantity, address sellAsset, address buyAsset) = fliStrategyExtension.getChunkRebalanceNotional(exchangeNames);
        uint256 uniswapV3ChunkSendQuantity = chunkSendQuantity[0];
        uint256 uniswapV2ChunkSendQuantity = chunkSendQuantity[1];

        bool isLever = sellAsset == fliStrategyExtension.getStrategy().borrowAsset;

        // Get V3 trade path. The exchange data is the encoded path
        bytes memory uniswapV3TradePath = isLever ? 
            fliStrategyExtension.getExchangeSettings(uniswapV3ExchangeName).leverExchangeData : 
            fliStrategyExtension.getExchangeSettings(uniswapV3ExchangeName).deleverExchangeData;

        // Get quote from Uniswap V3 SwapRouter
        uint256 uniswapV3ReceiveQuantity = _getUniswapV3Quote(uniswapV3TradePath, uniswapV3ChunkSendQuantity);

        // Get V2 trade path. The exchange data is the encoded path
        bytes memory uniswapV2TradePathRaw = isLever ? 
            fliStrategyExtension.getExchangeSettings(uniswapV2ExchangeName).leverExchangeData : 
            fliStrategyExtension.getExchangeSettings(uniswapV2ExchangeName).deleverExchangeData;

        address[] memory uniswapV2TradePath;
        if (keccak256(bytes(uniswapV2TradePathRaw)) == keccak256(bytes(""))) {
            uniswapV2TradePath = new address[](2);
            uniswapV2TradePath[0] = sellAsset;
            uniswapV2TradePath[1] = buyAsset;
        } else {
            uniswapV2TradePath = abi.decode(uniswapV2TradePathRaw, (address[]));
        }
        
        // Get quote from Uniswap V2 Router
        uint256 uniswapV2ReceiveQuantity = uniswapV2Router.getAmountsOut(uniswapV2ChunkSendQuantity, uniswapV2TradePath)[uniswapV2TradePath.length.sub(1)];

        // Divide to get ratio of quote / base asset. Don't care about decimals here. Standardizes to 10e18 with preciseDiv
        uniswapV3Price = uniswapV3ReceiveQuantity.preciseDiv(uniswapV3ChunkSendQuantity);
        uniswapV2Price = uniswapV2ReceiveQuantity.preciseDiv(uniswapV2ChunkSendQuantity);
    }

    function _getPriorityExchange(
        uint256 _uniswapV3Price,
        uint256 _uniswapV2Price,
        uint256 _customMinLeverageRatio,
        uint256 _customMaxLeverageRatio
    )
        internal
        view returns (string[] memory, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory)
    {

        // Check shouldRebalanceWithBounds on strategy adapter
        (string[] memory enabledExchanges, FlexibleLeverageStrategyExtension.ShouldRebalance[] memory rebalanceAction) = fliStrategyExtension.shouldRebalanceWithBounds(
            _customMinLeverageRatio,
            _customMaxLeverageRatio
        );

        // Assume Uniswap V2 and Uniswap V3 are enabled as exchanges. TBD: do we want a 3rd exchange?
        (uint256 uniV3Index, ) = enabledExchanges.indexOf(uniswapV3ExchangeName);
        (uint256 uniV2Index, ) = enabledExchanges.indexOf(uniswapV2ExchangeName);

        string[] memory exchangeNamesOrdered = new string[](1);
        FlexibleLeverageStrategyExtension.ShouldRebalance[] memory rebalanceActionOrdered = new FlexibleLeverageStrategyExtension.ShouldRebalance[](1);

        if (_uniswapV3Price > _uniswapV2Price) {
            exchangeNamesOrdered[0] = uniswapV3ExchangeName;
            rebalanceActionOrdered[0] = rebalanceAction[uniV3Index];
        } else {
            exchangeNamesOrdered[0] = uniswapV2ExchangeName;
            rebalanceActionOrdered[0] = rebalanceAction[uniV2Index];
        }

        return (exchangeNamesOrdered, rebalanceActionOrdered);
    }

    function _getUniswapV3Quote(bytes memory _path, uint256 _sellQuantity) internal view returns (uint256) {
        ///bytes memory uniswapV3Calldata = abi.encodeWithSelector(IQuoter.quoteExactInput.selector, _path, _sellQuantity);

        bytes memory uniswapV3Calldata = abi.encodeWithSignature("quoteExactInput(bytes,uint256)", _path, _sellQuantity);
        
        console.logBytes(uniswapV3Calldata);
        console.log(address(uniswapV3Quoter));

        (bool works, bytes memory returnData) = address(uniswapV3Quoter).staticcall(uniswapV3Calldata);

        console.logBytes(returnData);
        console.logString(string(returnData));

        return abi.decode(returnData, (uint256));
    }
}