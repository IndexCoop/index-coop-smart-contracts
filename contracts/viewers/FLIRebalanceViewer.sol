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

import { FlexibleLeverageStrategyAdapter } from "../adapters/FlexibleLeverageStrategyAdapter.sol";
import { ICompoundPriceOracle } from "../interfaces/ICompoundPriceOracle.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";


/**
 * @title FLIRebalanceViewer
 * @author Set Protocol
 *
 * ETHFLI Rebalance viewer that returns whether a Compound oracle update should be forced before a rebalance goes through
 */
contract FLIRebalanceViewer {

    enum FLIRebalanceAction {
        NONE,                   // Indicates no rebalance action can be taken
        REBALANCE,              // Indicates rebalance() function can be successfully called
        ITERATE_REBALANCE,      // Indicates iterateRebalance() function can be successfully called
        RIPCORD,                // Indicates ripcord() function can be successfully called
        ORACLE                  // Indicates Compound oracle update should be pushed 
    }

    IUniswapV2Router public uniswapRouter;
    IFLIStrategyAdapter public strategyAdapter;

    constructor(IUniswapV2Router _uniswapRouter, IFLIStrategyAdapter _strategyAdapter) public {
        uniswapRouter = _uniswapRouter;
        strategyAdapter = _strategyAdapter;
    }

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
            FlexibleLeverageStrategyAdapter.IncentiveSettings memory incentive = strategyAdapter.incentive();
            return shouldOracleBeUpdated(incentive.incentivizedTwapMaxTradeSize, incentive.incentivizedSlippageTolerance) ? 
                FLIRebalanceAction.ORACLE : 
                FLIRebalanceAction.RIPCORD;
        } else {
            FlexibleLeverageStrategyAdapter.ExecutionSettings memory execution = strategyAdapter.execution();
            return shouldOracleBeUpdated(execution.twapMaxTradeSize, execution.slippageTolerance) ? 
                FLIRebalanceAction.ORACLE : 
                shouldRebalance == FlexibleLeverageStrategyAdapter.ShouldRebalance.REBALANCE ? FLIRebalanceAction.REBALANCE : FLIRebalanceAction.ITERATE_REBALANCE;
        }
    }

    function shouldOracleBeUpdated(
        uint256 maxTradeSize,
        uint256 slippageTolerance
    )
        internal
        view
        returns (bool)
    {
        uint256 currentLeverageRatio = strategyAdapter.getCurrentLeverageRatio();
        uint256 targetLeverageRatio = strategyAdapter.methodology().targetLeverageRatio;
        FlexibleLeverageStrategyAdapter.ContractSettings memory settings = strategyAdapter.strategy();

        
    }
}
