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
pragma experimental "ABIEncoderV2";

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { FlexibleLeverageStrategyAdapter } from "../adapters/FlexibleLeverageStrategyAdapter.sol";
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { ICompoundPriceOracle } from "../interfaces/ICompoundPriceOracle.sol";
import { IFLIStrategyAdapter } from "../interfaces/IFLIStrategyAdapter.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


/**
 * @title FLIRebalanceViewer
 * @author Set Protocol
 *
 * ETHFLI Rebalance viewer that returns whether a Compound oracle update should be forced before a rebalance goes through, if no
 * oracle update the type of rebalance transaction will be returned adhering to the enum specified in FlexibleLeverageStrategyAdapter
 */
contract FLIRebalanceViewer {
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Enums ============ */

    enum FLIRebalanceAction {
        NONE,                   // Indicates no rebalance action can be taken
        REBALANCE,              // Indicates rebalance() function can be successfully called
        ITERATE_REBALANCE,      // Indicates iterateRebalance() function can be successfully called
        RIPCORD,                // Indicates ripcord() function can be successfully called
        ORACLE                  // Indicates Compound oracle update should be pushed 
    }

    /* ============ State Variables ============ */

    IUniswapV2Router public uniswapRouter;
    IFLIStrategyAdapter public strategyAdapter;
    address public cEther;

    /* ============ Constructor ============ */

    constructor(IUniswapV2Router _uniswapRouter, IFLIStrategyAdapter _strategyAdapter, address _cEther) public {
        uniswapRouter = _uniswapRouter;
        strategyAdapter = _strategyAdapter;
        cEther = _cEther;
    }

    /* ============ External Functions ============ */

    /**
     * Helper that checks if conditions are met for rebalance or ripcord with custom max and min bounds specified by caller. This function simplifies the
     * logic for off-chain keeper bots to determine what threshold to call rebalance when leverage exceeds max or drops below min. Returns an enum with
     * 0 = no rebalance, 1 = call rebalance(), 2 = call iterateRebalance(), 3 = call ripcord(). Additionally, logic is added to check if an oracle update
     * should be forced to the Compound protocol ahead of the rebalance (4). 
     *
     * @param _customMinLeverageRatio          Min leverage ratio passed in by caller
     * @param _customMaxLeverageRatio          Max leverage ratio passed in by caller
     *
     * return FLIRebalanceAction               Enum detailing whether to do nothing, rebalance, iterateRebalance, ripcord, or update Compound oracle
     */
    function shouldRebalanceWithBounds(
        uint256 _customMinLeverageRatio,
        uint256 _customMaxLeverageRatio
    )
        external
        view
        returns(FLIRebalanceAction)
    {
        FlexibleLeverageStrategyAdapter.ShouldRebalance shouldRebalance = strategyAdapter.shouldRebalanceWithBounds(
            _customMinLeverageRatio,
            _customMaxLeverageRatio
        );

        if (shouldRebalance == FlexibleLeverageStrategyAdapter.ShouldRebalance.NONE) {
            return FLIRebalanceAction.NONE;
        } else if (shouldRebalance == FlexibleLeverageStrategyAdapter.ShouldRebalance.RIPCORD) {
            FlexibleLeverageStrategyAdapter.IncentiveSettings memory incentive = strategyAdapter.getIncentive();
            return _shouldOracleBeUpdated(incentive.incentivizedTwapMaxTradeSize, incentive.incentivizedSlippageTolerance) ? 
                FLIRebalanceAction.ORACLE : 
                FLIRebalanceAction.RIPCORD;
        } else {
            FlexibleLeverageStrategyAdapter.ExecutionSettings memory execution = strategyAdapter.getExecution();
            return _shouldOracleBeUpdated(execution.twapMaxTradeSize, execution.slippageTolerance) ? 
                FLIRebalanceAction.ORACLE : 
                shouldRebalance == FlexibleLeverageStrategyAdapter.ShouldRebalance.REBALANCE ? FLIRebalanceAction.REBALANCE : FLIRebalanceAction.ITERATE_REBALANCE;
        }
    }

    /* ============ Internal Functions ============ */

    /**
     * Checks if the Compound oracles should be updated before executing any rebalance action. Updates must occur if the resulting trade would end up outside the
     * slippage bounds as calculated against the Compound oracle. Aligning the oracle more closely with market prices should allow rebalances to go through.
     *
     * @param _maxTradeSize                 Max trade size of rebalance action (varies whether its ripcord or normal rebalance)
     * @param _slippageTolerance            Slippage tolerance of rebalance action (varies whether its ripcord or normal rebalance)
     *
     * return bool                          Boolean indicating whether oracle needs to be updated
     */
    function _shouldOracleBeUpdated(
        uint256 _maxTradeSize,
        uint256 _slippageTolerance
    )
        internal
        view
        returns (bool)
    {
        FlexibleLeverageStrategyAdapter.ContractSettings memory settings = strategyAdapter.getStrategy();

        (
            uint256 executionPrice,
            uint256 oraclePrice
        ) = strategyAdapter.getCurrentLeverageRatio() > strategyAdapter.getMethodology().targetLeverageRatio ? 
            (
                _getUniswapExecutionPrice(settings.borrowAsset, settings.collateralAsset, _maxTradeSize, false),
                _getCompoundOraclePrice(settings.priceOracle, settings.targetBorrowCToken, settings.targetCollateralCToken)
            ) :
            (
                _getUniswapExecutionPrice(settings.collateralAsset, settings.borrowAsset, _maxTradeSize, true),
                _getCompoundOraclePrice(settings.priceOracle, settings.targetCollateralCToken, settings.targetBorrowCToken)   
            );

        return executionPrice > oraclePrice.preciseMul(PreciseUnitMath.preciseUnit().add(_slippageTolerance));
    }

    /**
     * Calculates Uniswap exection price by querying Uniswap for expected token flow amounts for a trade and implying market price. Returned value
     * is normalized to 18 decimals.
     *
     * @param _buyAsset                     Asset being bought on Uniswap
     * @param _sellAsset                    Asset being sold on Uniswap
     * @param _tradeSize                    Size of the trade in collateral units
     * @param _isBuyingCollateral           Whether collateral is being bought or sold (used to determine which Uniswap function to call)
     *
     * return uint256                       Implied Uniswap market price for pair, normalized to 18 decimals
     */
    function _getUniswapExecutionPrice(
        address _buyAsset,
        address _sellAsset,
        uint256 _tradeSize,
        bool _isBuyingCollateral
    )
        internal
        view
        returns (uint256)
    {
        address[] memory path = new address[](2);
        path[0] = _sellAsset;
        path[1] = _buyAsset;

        // Returned [sellAmount, buyAmount]
        uint256[] memory flows = _isBuyingCollateral ? uniswapRouter.getAmountsIn(_tradeSize, path) : uniswapRouter.getAmountsOut(_tradeSize, path);

        uint256 buyDecimals = uint256(10)**ERC20(_buyAsset).decimals();
        uint256 sellDecimals = uint256(10)**ERC20(_sellAsset).decimals();

        return flows[0].preciseDiv(sellDecimals).preciseDiv(flows[1].preciseDiv(buyDecimals));
    }

    /**
     * Calculates Compound oracle price
     *
     * @param _priceOracle          Compound price oracle
     * @param _cTokenBuyAsset       CToken having net exposure increased (ie if net balance is short, decreasing short)
     * @param _cTokenSellAsset      CToken having net exposure decreased (ie if net balance is short, increasing short)
     *
     * return uint256               Compound oracle price for pair, normalized to 18 decimals
     */
    function _getCompoundOraclePrice(
        ICompoundPriceOracle _priceOracle,
        ICErc20 _cTokenBuyAsset,
        ICErc20 _cTokenSellAsset
    )
        internal
        view
        returns (uint256)
    {
        uint256 buyPrice = _priceOracle.getUnderlyingPrice(address(_cTokenBuyAsset));
        uint256 sellPrice = _priceOracle.getUnderlyingPrice(address(_cTokenSellAsset));

        uint256 buyDecimals = address(_cTokenBuyAsset) == cEther ?
            PreciseUnitMath.preciseUnit() : 
            uint256(10)**ERC20(_cTokenBuyAsset.underlying()).decimals();
        uint256 sellDecimals = address(_cTokenSellAsset) == cEther ?
            PreciseUnitMath.preciseUnit() :
            uint256(10)**ERC20(_cTokenSellAsset.underlying()).decimals();

        return buyPrice.mul(buyDecimals).preciseDiv(sellPrice.mul(sellDecimals));
    }
}
