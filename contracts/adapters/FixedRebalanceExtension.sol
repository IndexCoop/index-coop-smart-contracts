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


    struct CallArguments {
        address setToken;
        uint16 currencyId;
        uint40 maturity;
        uint256 minMintAmount;
        address sendToken;
        uint256 sendAmount;
    }

    // /* ============ Events ============ */

    event AllocationSet(uint256 _maturity, uint256 _oldAllocation, uint256 _newAllocation);
    event MaturityStatusSet(uint256 _maturity, bool _newStatus);

    // /* ============ State Variables ============ */

    mapping(uint256 => bool) internal isValidMaturity;       // Mapping of valid maturities
    uint256[] validMaturities;                               // Array of valid maturities
    ISetToken setToken;                                      // Instance of leverage token
    INotionalTradeModule notionalTradeModule;                // Instance of leverage token
    INotionalProxy notionalProxy;                            
    IWrappedfCashFactory wrappedfCashFactory;                // Instance of leverage token
    address underlyingToken;
    address assetToken;
    uint256[] maturities;                                    // Array of relative maturities in seconds (i.e. 3 months / 6 months)
    uint256[] allocations;                                   // Relative allocations 
    uint16 public currencyId;

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
        uint256[] memory _validMaturities
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

        for(uint256 i = 0; i < _validMaturities.length; i++) {
            if(i < _validMaturities.length - 1) {
                require(_validMaturities[i] < _validMaturities[i + 1], "validMaturities must be in ascending order");
            }
            isValidMaturity[_validMaturities[i]] = true;
            emit MaturityStatusSet(_validMaturities[i], true);
        }
        validMaturities = _validMaturities;

        _setAllocations(_maturities, _allocations);
    }

    // /* ============ External Functions ============ */

    /**
     * ONLY OPERATOR: Rebalances the positions towards the configured allocation percentages.
     *
     * @param _share                Relative share of the necessary trade volume to execute (allows for splitting the rebalance over multiple transactions
     */
    function rebalance(uint256 _share) external onlyOperator {
        require(_share > 0, "Share must be greater than 0");
        require(_share <= 1 ether, "Share cannot exceed 100%");

        // TODO: Review if we want to open up this method for anyone to call.
        _sellOverweightPositions(_share);
        _buyUnderweightPositions(_share);
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




    // /* ============ Internal Functions ============ */

    // @dev Sells fCash positions that are currently above their targeted allocation
    // @dev _maturity         absolute maturity of fCash to redeem
    // @param _share          Relative share of the necessary trade volume to execute (allows for splitting the rebalance over multiple transactions
    function _sellOverweightPositions(uint256 _share) internal {
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
            uint256 currentPosition = _convertToAssetToken(uint256(currentPositionSigned), maturity);
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
            uint256 currentPosition = _convertToAssetToken(uint256(currentPositionSigned), maturity);
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
        int256 assetPosition = setToken.getDefaultPositionRealUnit(assetToken);
        require(assetPosition >= 0, "Negative asset position");
        return _getTotalFCashPosition().add(uint256(assetPosition));
    }

    // @dev Aggregates all fCash positions into a single value
    // @dev Converts all fCashPosition to their equivalent assetToken value and returns the sum
    function _getTotalFCashPosition() internal view returns(uint256 totalFCashPosition) {
        address[] memory fCashComponents = notionalTradeModule.getFCashComponents(setToken);
        for(uint256 i = 0; i < fCashComponents.length; i++) {
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(fCashComponents[i]);
            require(currentPositionSigned >= 0, "Negative position");
            uint256 maturity = IWrappedfCashComplete(fCashComponents[i]).getMaturity();
            uint256 currentPositionDiscounted = _convertToAssetToken(uint256(currentPositionSigned), maturity);
            totalFCashPosition = totalFCashPosition.add(uint256(currentPositionDiscounted));
        }
    }

    // @dev Converts a given amount of fcash at given maturity to the equivalent asset token value
    // @dev Represents the current / discounted value of the fCash position
    function _convertToAssetToken(uint256 _amount, uint256 _maturity) internal view returns(uint256) {
        (,uint256 currentPositionDiscounted,,) = notionalProxy.getDepositFromfCashLend(
            currencyId,
            _amount,
            _maturity,
            0,
            block.timestamp
        );
        return currentPositionDiscounted;
    }

    // @dev Mint fCash for asset token
    // @dev _maturity         absolute maturity of fCash to redeem
    // @dev _assetTokenAmount corresponding assetToken amount for which to mint fCash
    function _mintFCash(uint256 _maturity, uint256 _assetTokenAmount) internal {
        uint256 assetTokenPosition = uint256(setToken.getDefaultPositionRealUnit(assetToken));
        require(assetTokenPosition >= _assetTokenAmount, "Insufficient asset token balance for mint");

        // TODO: Check if we need to calculate a better value for slippage protection etc.
        uint256 minFCashAmount = 0;
        bytes memory callData = abi.encodeWithSignature(
                "mintFCashForFixedToken(address,uint16,uint40,uint256,address,uint256)",
                address(setToken),
                currencyId,
                uint40(_maturity),
                minFCashAmount,
                address(assetToken),
                _assetTokenAmount
        );
        invokeManager(
            address(notionalTradeModule),
            callData
        );
    }

    // @dev Redeems fCash for asset token
    // @dev _maturity         absolute maturity of fCash to redeem
    // @dev _assetTokenAmount corresponding assetToken amount for which to redeem fCash
    // @dev _fCashPosiiton    current fCash position of the setToken
    function _redeemFCash(
        uint256 _maturity,
        uint256 _assetTokenAmount,
        uint256 _fCashPosition
    )
    internal
    {
        bytes memory callData = abi.encodeWithSignature(
                "redeemFCashForFixedToken(address,uint16,uint40,uint256,address,uint256,uint256)",
                address(setToken),
                currencyId,
                uint40(_maturity),
                _fCashPosition,
                address(assetToken),
                _assetTokenAmount,
                0.01 ether
        );
        invokeManager(
            address(notionalTradeModule),
            callData
        );
    }

    // @dev Returns fCash component address and their relative maturities
    // @dev Will revert if set token contains an fCash component that does not correspond to a whitelisted maturity
    function _getFCashComponentsAndMaturities() 
    internal
    view
    returns (address[] memory fCashComponents, uint256[] memory fCashMaturities)
    {
        fCashComponents = notionalTradeModule.getFCashComponents(setToken);
        fCashMaturities = new uint256[](fCashComponents.length);
        for(uint256 i = 0; i < fCashComponents.length; i++) {
            fCashMaturities[i] = _absoluteToRelativeMaturity(
                IWrappedfCashComplete(fCashComponents[i]).getMaturity()
            );
        }
    }

    // @dev Converts absolute maturity to corresponding relative maturity if it is whitelisted
    // @param _absoluteMaturity Absolute maturity to convert (i.e. "2022-12-22" in seconds)
    // @return Corresponding relative maturity (i.e. "3 months" in seconds)
    // @dev Returns smallest whitelisted relative maturity that is greater than the remaining maturity
    // @dev Reverts if absolute maturity cannot be matched to a whitelisted relative maturity
    function _absoluteToRelativeMaturity(uint256 _absoluteMaturity) internal view returns (uint256) {
        // This will revert if absolute maturity is less than timestamp (i.e. matured positions)
        // TODO: Verify that this is not an issue
        uint256 remainingMaturity = _absoluteMaturity.sub(block.timestamp);
        // Valid maturities is sorted in ascending order
        for(uint256 i = 0; i < validMaturities.length; i++) {
            if(validMaturities[i] >= remainingMaturity) {
                return validMaturities[i];
            }
        }
        revert("Remaining maturity is larger than any valid maturity");
    }

    // @dev Converts relative to absolute maturity
    // @param _relativeMaturity     Relative maturity to convert (i.e. "3 months" in seconds)
    // @return absoluteMaturity     Absolute maturity to convert (i.e. "2022-12-22" in seconds)
    // @dev Returns largest active maturity on notional that is smaller than the relative maturity
    // @dev Inverse of _absoluteToRelativeMaturity TODO: Check that this is correct
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
    function _setAllocations(uint256[] memory _maturities, uint256[] memory _allocations) internal {
        require(_maturities.length == _allocations.length, "Maturities and allocations must be same length");
        uint256 totalAllocation = 0;
        for (uint256 i = 0; i < _maturities.length; i++) {
            require(isValidMaturity[_maturities[i]], "Invalid maturity");
            totalAllocation = totalAllocation.add(_allocations[i]);
        }
        require(totalAllocation == PreciseUnitMath.preciseUnit(), "Allocations must sum to 1");
        maturities = _maturities;
        allocations = _allocations;
    }

}
