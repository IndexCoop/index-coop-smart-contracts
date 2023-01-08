/*
    Copyright 2022 Set Labs Inc.

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
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { INotionalTradeModule } from "../interfaces/INotionalTradeModule.sol";
import { INotionalProxy, MarketParameters } from "../interfaces/INotionalProxy.sol";
import { IWrappedfCashComplete } from "../interfaces/IWrappedfCash.sol";
import { IWrappedfCashFactory } from "../interfaces/IWrappedfCashFactory.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";




/**
 * @title FixedRebalanceExtension
 * @author IndexCoop
 *
 * Smart contract that enables rebalancing of FIXED products
 * Will sell redeem fCash positions and mint underweight fCash positions via NotionalTradeModule
 */
contract FixedRebalanceExtension is BaseExtension {
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;


    // /* ============ Events ============ */

    event AllocationsUpdated(uint256[] _maturities, uint256[] _allocations, uint256[] _minPositions);

    // /* ============ State Variables ============ */

    uint256[] internal maturities;                               // Array of relative maturities in seconds (i.e. 3 months / 6 months)
    uint256[] internal allocations;                              // Relative allocations 
    uint256[] internal minPositions;                             // Minimum positions to achieve after every full rebalancing (assuming share = 100 %)

    ISetToken public immutable setToken;                       
    INotionalTradeModule internal immutable notionalTradeModule; 
    INotionalProxy internal immutable notionalProxy;                            
    IWrappedfCashFactory internal immutable wrappedfCashFactory; 
    address internal immutable underlyingToken;
    address internal immutable assetToken;
    uint16 public immutable currencyId;
    
    bool internal tradeViaUnderlying;

    // /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        ISetToken _setToken,
        INotionalTradeModule _notionalTradeModule,
        INotionalProxy _notionalProxy,
        IWrappedfCashFactory _wrappedfCashFactory,
        address _underlyingToken,
        address _assetToken,
        uint256[] memory _maturities,
        uint256[] memory _allocations,
        uint256[] memory _minPositions
    )
        public
        BaseExtension(_manager)
    {
        setToken = _setToken;
        notionalTradeModule = _notionalTradeModule;
        notionalProxy = _notionalProxy;
        wrappedfCashFactory = _wrappedfCashFactory;
        underlyingToken = _underlyingToken;
        assetToken = _assetToken;
        currencyId = _notionalProxy.getCurrencyId(_assetToken);

        _setAllocations(_maturities, _allocations, _minPositions);
    }

    // /* ============ External Functions ============ */

    /**
     * ONLY OPERATOR: Updates the relative maturities that are valid to allocate to
     *
     * @param _tradeViaUnderlying        Boolean indicating whether or not to trade via the underlying token
     */
    function setTradeViaUnderlying(bool _tradeViaUnderlying) external onlyOperator {
        tradeViaUnderlying = _tradeViaUnderlying;
    }

    /**
     * ONLY OPERATOR: Updates the relative maturities that are valid to allocate to
     *
     * @param _maturities                Relative maturities (i.e. "3 months") in seconds
     * @param _allocations               Relative allocations (i.e. 0.9 = 90%) with 18 decimals corresponding to the respective maturity
     */
    function setAllocations(uint256[] memory _maturities, uint256[] memory _allocations, uint256[] memory _minPositions) external onlyOperator {
        _setAllocations(_maturities, _allocations, _minPositions);
    }

    /**
     * ONLY ALLOWED CALLER: Rebalances the positions towards the configured allocation percentages.
     *
     * @param _share                 Relative share of the necessary trade volume to execute (allows for splitting the rebalance over multiple transactions
     * @param _rebalanceMinPositions Minimum positions (in set token units) for each maturity after this rebalance operation. 
     * @dev Will revert if _rebalanceMinPositions is lower than the minPositions configured by the operator (weighted by share)
     */
    function rebalance(uint256 _share, uint256[] memory _rebalanceMinPositions) external onlyAllowedCaller(msg.sender) returns(uint256[] memory) {
        require(_share > 0, "Share must be greater than 0");
        require(_share <= 1 ether, "Share cannot exceed 100%");

        uint256[] memory currentPositionsBefore = _sellOverweightPositions(_share);
        _buyUnderweightPositions(_share);
        return _checkCurrentPositions(currentPositionsBefore, _rebalanceMinPositions, _share);
    }

    // Aggregates all fCash positions + asset token position into a single value
    // @dev The value represents the current value of all relevant positions and can be multiplied by the relative allocation to calculate the target position size
    function getTotalAllocation() external view returns(uint256) {
        return _getTotalAllocation();
    }


    // Get positions that are currently below their targeted weight
    function getUnderweightPositions() external view returns(uint256[] memory, uint256[] memory,  uint256[] memory) {
        return _getUnderweightPositions();
    }

    // Get absolute maturities corresponding to currently configured allocations
    function getAbsoluteMaturities() external view returns (uint256[] memory absoluteMaturities) {
        absoluteMaturities = new uint256[](maturities.length);
        for(uint256 i = 0; i < maturities.length; i++) {
            absoluteMaturities[i] = _relativeToAbsoluteMaturity(maturities[i]);
        }
    }

    // Get maturities, allocations and minPositions
    function getAllocations() external view returns (uint256[] memory, uint256[] memory, uint256[] memory) {
        return (maturities, allocations, minPositions);
    }

    // Convert relative to aboslute maturity
    function relativeToAbsoluteMaturity(uint256 _relativeMaturity) external view returns (uint256) {
        return _relativeToAbsoluteMaturity(_relativeMaturity);
    }

    // Return current token position for each maturity;
    function getCurrentPositions()
        external
        view
        returns(uint256[] memory currentPositions)
    {
        currentPositions = new uint256[](maturities.length);
        for(uint i = 0; i < maturities.length; i++) {
            uint256 maturity = _relativeToAbsoluteMaturity(maturities[i]);
            address wrappedfCash = wrappedfCashFactory.computeAddress(currencyId, uint40(maturity));
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(wrappedfCash);
            require(currentPositionSigned >= 0, "Negative position");
            currentPositions[i] = uint256(currentPositionSigned);
        }
    }




    // /* ============ Internal Functions ============ */

    // @dev Sells fCash positions that are currently above their targeted allocation
    // @dev _maturity         absolute maturity of fCash to redeem
    // @param _share          Relative share of the necessary trade volume to execute (allows for splitting the rebalance over multiple transactions
    function _sellOverweightPositions(uint256 _share) internal returns(uint256[] memory){
        (
            uint256[] memory overweightPositions,
            uint256[] memory currentPositions,
            uint256[] memory absoluteMaturities
        ) = _getOverweightPositions();
        for(uint256 i = 0; i < overweightPositions.length; i++) {
            uint256 receiveAmount = overweightPositions[i].preciseMul(_share);
            if(overweightPositions[i] > 0) {
                _redeemFCash(absoluteMaturities[i], receiveAmount, currentPositions[i]);
            }
        }
        return currentPositions;
    }

    // @dev Buys fCash positions that are currently below their targeted allocation
    // @dev _maturity         absolute maturity of fCash to redeem
    // @param _share          Relative share of the necessary trade volume to execute (allows for splitting the rebalance over multiple transactions
    function _buyUnderweightPositions(uint256 _share) internal {
        (
            uint256[] memory underweightPositions,,
            uint256[] memory absoluteMaturities
        ) = _getUnderweightPositions();
        for(uint256 i = 0; i < underweightPositions.length; i++) {
            uint256 sendAmount = underweightPositions[i].preciseMul(_share);
            if(sendAmount > 0) {
                _mintFCash(absoluteMaturities[i], sendAmount);
            }
        }
    }

    // @dev Checks that the positions after rebalance are above the _rebalanceMinPositions specified in rebalanceCall
    // @dev Also verifies that _rebalanceMinPositions are above the minPositions configured by the operator (weighted by _share)
    function _checkCurrentPositions(uint256[] memory _positionsBefore, uint256[] memory _rebalanceMinPositions, uint256 _share)
        internal
        view
        returns(uint256[] memory currentPositions)
    {
        require(_rebalanceMinPositions.length == maturities.length , "Min positions must be same length as maturities");
        currentPositions = new uint256[](maturities.length);
        for(uint i = 0; i < maturities.length; i++) {

            uint256 weightedMinPosition = _getWeightedMinPosition(minPositions[i], _positionsBefore[i], _share);
            require(_rebalanceMinPositions[i] >= weightedMinPosition, "Caller provided min position must not be less than operator specified value weighted by share");
            uint256 maturity = _relativeToAbsoluteMaturity(maturities[i]);
            address wrappedfCash = wrappedfCashFactory.computeAddress(currencyId, uint40(maturity));
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(wrappedfCash);
            require(currentPositionSigned >= 0, "Negative position");
            require(uint256(currentPositionSigned) >= _rebalanceMinPositions[i], "Position below min");
            currentPositions[i] = uint256(currentPositionSigned);
        }
    }

    // @dev Calculates the minimumPosition for a given maturity by taking the weighted average between the _minPosition configured by the operator and the position before the rebalance call.
    function _getWeightedMinPosition(uint256 _minPosition, uint256 _positionBefore, uint256 _share) internal pure returns(uint256) {
        if(_minPosition > _positionBefore) {
            // If the position was below the min position before you have to increase it by at least _share % of the difference
            return _positionBefore.add(_minPosition.sub(_positionBefore).preciseMul(_share));
        } else {
            // If the position was above the min position before you can only decrease it by maximum _share % of the difference
            return _positionBefore.sub(_positionBefore.sub(_minPosition).preciseMul(_share));
        } 
    }


    // @dev Get positions that are currently above their targeted weight
    function _getOverweightPositions()
        internal
        view
        returns(
            uint256[] memory overweightPositions,
            uint256[] memory currentPositions,
            uint256[] memory absoluteMaturities
        )
    {
        uint256 totalFCashAndUnderlyingPosition = _getTotalAllocation();

        overweightPositions = new uint256[](maturities.length);
        currentPositions = new uint256[](maturities.length);
        absoluteMaturities = new uint256[](maturities.length);
        for(uint i = 0; i < maturities.length; i++) {
            uint256 maturity = _relativeToAbsoluteMaturity(maturities[i]);
            absoluteMaturities[i] = maturity;
            address wrappedfCash = wrappedfCashFactory.computeAddress(currencyId, uint40(maturity));
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(wrappedfCash);
            require(currentPositionSigned >= 0, "Negative position");
            uint256 currentPosition = _getCurrentValue(uint256(currentPositionSigned), maturity);
            uint256 targetPosition = allocations[i].preciseMul(totalFCashAndUnderlyingPosition);

            currentPositions[i] = uint256(currentPositionSigned);
            if(currentPosition > targetPosition) {
                overweightPositions[i] = currentPosition.sub(targetPosition);
            }
        }
    }

    // @dev Get positions that are currently below their targeted weight
    function _getUnderweightPositions()
        internal
        view
        returns(
            uint256[] memory underweightPositions,
            uint256[] memory currentPositions,
            uint256[] memory absoluteMaturities
        )
    {
        uint256 totalFCashAndUnderlyingPosition = _getTotalAllocation();

        underweightPositions = new uint256[](maturities.length);
        currentPositions = new uint256[](maturities.length);
        absoluteMaturities = new uint256[](maturities.length);
        for(uint i = 0; i < maturities.length; i++) {
            uint256 maturity = _relativeToAbsoluteMaturity(maturities[i]);
            absoluteMaturities[i] = maturity;
            address wrappedfCash = wrappedfCashFactory.computeAddress(currencyId, uint40(maturity));
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(wrappedfCash);
            require(currentPositionSigned >= 0, "Negative position");
            uint256 currentPosition = _getCurrentValue(uint256(currentPositionSigned), maturity);
            uint256 targetPosition = allocations[i].preciseMul(totalFCashAndUnderlyingPosition);

            currentPositions[i] = uint256(currentPositionSigned);
            if(currentPosition < targetPosition) {
                underweightPositions[i] = targetPosition.sub(currentPosition);
            }
        }
    }

    // @dev Aggregates all fCash positions + asset token position into a single value
    // @dev The value represents the current value of all relevant positions and can be multiplied by the relative allocation to calculate the target position size
    function _getTotalAllocation() internal view returns(uint256) {
        address tradeToken = _getTradeToken();
        int256 tradeTokenPosition = setToken.getDefaultPositionRealUnit(tradeToken);
        require(tradeTokenPosition >= 0, "Negative asset position");
        return _getTotalFCashPosition().add(uint256(tradeTokenPosition));
    }

    // @dev Aggregates all fCash positions into a single value
    // @dev Converts all fCashPosition to their equivalent assetToken value and returns the sum
    function _getTotalFCashPosition() internal view returns(uint256 totalFCashPosition) {
        address[] memory fCashComponents = notionalTradeModule.getFCashComponents(setToken);
        for(uint256 i = 0; i < fCashComponents.length; i++) {
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(fCashComponents[i]);
            require(currentPositionSigned >= 0, "Negative position");
            uint256 maturity = IWrappedfCashComplete(fCashComponents[i]).getMaturity();
            uint256 currentPositionDiscounted = _getCurrentValue(uint256(currentPositionSigned), maturity);
            totalFCashPosition = totalFCashPosition.add(uint256(currentPositionDiscounted));
        }
    }

    // @dev Converts a given amount of fcash at given maturity to the equivalent asset or underlying token value
    // @dev Represents the current / discounted value of the fCash position
    function _getCurrentValue(uint256 _amount, uint256 _maturity) internal view returns(uint256) {
        (uint256 underlyingTokenAmount, uint256 assetTokenAmount,,) = notionalProxy.getDepositFromfCashLend(
            currencyId,
            _amount,
            _maturity,
            0,
            block.timestamp
        );
        return tradeViaUnderlying ? underlyingTokenAmount : assetTokenAmount;
    }

    // @dev Mint fCash for asset token
    // @dev _maturity         absolute maturity of fCash to redeem
    // @dev _tradeTokenAmount corresponding tradeToken amount for which to mint fCash
    function _mintFCash(uint256 _maturity, uint256 _tradeTokenAmount) internal {
        address tradeToken = _getTradeToken();
        uint256 tradeTokenPosition = uint256(setToken.getDefaultPositionRealUnit(tradeToken));
        require(tradeTokenPosition >= _tradeTokenAmount, "Insufficient asset token balance for mint");

        // TODO: Check if we need to calculate a better value for slippage protection etc.
        uint256 minFCashAmount = 0;
        bytes memory callData = abi.encodeWithSignature(
                "mintFCashForFixedToken(address,uint16,uint40,uint256,address,uint256)",
                address(setToken),
                currencyId,
                uint40(_maturity),
                minFCashAmount,
                address(tradeToken),
                _tradeTokenAmount
        );
        invokeManager(
            address(notionalTradeModule),
            callData
        );
    }

    // @dev Redeems fCash for trade token
    // @dev _maturity         absolute maturity of fCash to redeem
    // @dev _tradeTokenAmount corresponding tradeToken amount for which to redeem fCash
    // @dev _fCashPosiiton    current fCash position of the setToken
    function _redeemFCash(
        uint256 _maturity,
        uint256 _tradeTokenAmount,
        uint256 _fCashPosition
    )
    internal
    {
        address tradeToken = _getTradeToken();
        bytes memory callData = abi.encodeWithSignature(
                "redeemFCashForFixedToken(address,uint16,uint40,uint256,address,uint256,uint256)",
                address(setToken),
                currencyId,
                uint40(_maturity),
                _fCashPosition,
                address(tradeToken),
                _tradeTokenAmount,
                0.01 ether
        );
        invokeManager(
            address(notionalTradeModule),
            callData
        );
    }

    // @dev Converts relative to absolute maturity
    // @param _relativeMaturity     Relative maturity to convert (i.e. "3 months" in seconds)
    // @return absoluteMaturity     Absolute maturity to convert (i.e. "2022-12-22" in seconds)
    // @dev Returns largest active maturity on notional that is smaller than the relative maturity
    function _relativeToAbsoluteMaturity(uint256 _relativeMaturity) internal view returns (uint256 absoluteMaturity) {
        MarketParameters[] memory  activeMarkets = notionalProxy.getActiveMarkets(currencyId);
        for(uint256 i = 0; i < activeMarkets.length; i++) {
            if(activeMarkets[i].maturity > block.timestamp && (activeMarkets[i].maturity - block.timestamp) < _relativeMaturity) {
                if(activeMarkets[i].maturity > absoluteMaturity) {
                    absoluteMaturity = activeMarkets[i].maturity;
                }
            }
        }
        require(absoluteMaturity > 0, "No active market found for given relative maturity");
    }



    // @dev Sets configured allocations for the setToken
    function _setAllocations(uint256[] memory _maturities, uint256[] memory _allocations, uint256[] memory _minPositions) internal {
        require((_maturities.length == _allocations.length) && (_maturities.length == _minPositions.length), "Maturities, minPositions and allocations must be same length");
        uint256 totalAllocation = 0;
        for (uint256 i = 0; i < _maturities.length; i++) {
            totalAllocation = totalAllocation.add(_allocations[i]);
        }
        require(totalAllocation == PreciseUnitMath.preciseUnit(), "Allocations must sum to 1");
        maturities = _maturities;
        allocations = _allocations;
        minPositions = _minPositions;
        emit AllocationsUpdated(_maturities, _allocations, _minPositions);
    }

    // @dev Returns the token via which to trade
    function _getTradeToken() internal view returns(address) {
        return tradeViaUnderlying ? underlyingToken : assetToken;
    }
}
