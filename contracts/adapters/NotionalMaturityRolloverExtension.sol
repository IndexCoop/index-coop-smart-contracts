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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { INotionalTradeModule } from "../interfaces/INotionalTradeModule.sol";
import { INotionalProxy, MarketParameters } from "../interfaces/INotionalProxy.sol";
import { IWrappedfCashComplete } from "../interfaces/IWrappedfCash.sol";
import { IWrappedfCashFactory } from "../interfaces/IWrappedfCashFactory.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";



/**
 * @title NotionalMaturityRolloverExtension
 * @author IndexCoop
 *
 * Smart contract that enables trustless rollover of matured notional / fCash positions at maturity, maintining configured maturity allocation
 */
contract NotionalMaturityRolloverExtension is BaseExtension {
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;



    // /* ============ Events ============ */

    event Engaged();
    event AllocationSet(uint256 _maturity, uint256 _oldAllocation, uint256 _newAllocation);
    event MaturityStatusSet(uint256 _maturity, bool _newStatus);
    event Disengaged();

    // /* ============ State Variables ============ */

    mapping(uint256 => bool) internal isValidMaturity;              // Mapping of valid maturities
    uint256[] validMaturities;
    ISetToken setToken;                             // Instance of leverage token
    INotionalTradeModule notionalTradeModule;                             // Instance of leverage token
    INotionalProxy notionalProxy;                             
    IWrappedfCashFactory wrappedfCashFactory;                             // Instance of leverage token
    address underlyingToken;
    address assetToken;
    uint256[] maturities;                           // Array of relative maturities in seconds (i.e. 3 months / 6 months)
    uint256[] allocations;                          // Relative allocations 
    uint16 currencyId;

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

    function rollOverPosition(uint256 _executionShare) external onlyOperator {
        notionalTradeModule.redeemMaturedPositions(setToken);
        int256 underlyingPosition = setToken.getDefaultPositionRealUnit(underlyingToken);
        require(underlyingPosition > 0, "No underlying position");
        uint256 underlyingPositionUint = uint256(underlyingPosition);


    }

    function getTotalFCashPosition() public view returns(uint256 totalFCashPosition) {
        address[] memory fCashComponents = notionalTradeModule.getFCashComponents(setToken);
        for(uint256 i = 0; i < fCashComponents.length; i++) {
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(fCashComponents[i]);
            require(currentPositionSigned >= 0, "Negative position");
            totalFCashPosition = totalFCashPosition.add(uint256(currentPositionSigned));
        }
    }

    function getShortfalls() public view returns(uint256[] memory shortfalls) {
        int256 underlyingPosition = setToken.getDefaultPositionRealUnit(underlyingToken);
        require(underlyingPosition >= 0, "Negative underlying position");
        uint256 underlyingPositionUint = uint256(underlyingPosition);
        uint256 totalFCashPosition = getTotalFCashPosition();
        return _getShortfalls(underlyingPositionUint.add(totalFCashPosition));
    }

    function _getShortfalls(uint256 _totalFCashAndUnderlyingPosition) internal view returns(uint256[] memory shortfalls) {
        shortfalls = new uint256[](maturities.length);
        for(uint i = 0; i < maturities.length; i++) {
            uint256 maturity = getAbsoluteMaturity(maturities[i]);
            address wrappedfCash = wrappedfCashFactory.computeAddress(currencyId, uint40(maturity));
            int256 currentPositionSigned = setToken.getDefaultPositionRealUnit(wrappedfCash);
            require(currentPositionSigned >= 0, "Negative position");
            uint256 currentPosition = uint256(currentPositionSigned);
            uint256 targetPosition = allocations[i].preciseMul(_totalFCashAndUnderlyingPosition);
            if(currentPosition < targetPosition) {
                shortfalls[i] = targetPosition.sub(currentPosition);
            }
        }
    }

    function getFCashComponentsAndMaturities() external view returns (address[] memory, uint256[] memory) {
        return _getFCashComponentsAndMaturities();
    }

    function _remainingToAbsoluteMaturity(uint256 _remainingMaturity) internal view returns (uint256) {
        for(uint256 i = 0; i < validMaturities.length; i++) {
            if(validMaturities[i] >= _remainingMaturity) {
                return validMaturities[i];
            }
        }
        revert("Remaining maturity is larger than any valid maturity");
    }

    function getAbsoluteMaturities() external view returns (uint256[] memory absoluteMaturities) {
        absoluteMaturities = new uint256[](maturities.length);
        for(uint256 i = 0; i < maturities.length; i++) {
            absoluteMaturities[i] = getAbsoluteMaturity(maturities[i]);
        }
    }

    function getAbsoluteMaturity(uint256 _relativeMaturity) public view returns (uint256 absoluteMaturity) {
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

    function _getFCashComponentsAndMaturities() 
    internal
    view
    returns (address[] memory fCashComponents, uint256[] memory fCashMaturities)
    {
        fCashComponents = notionalTradeModule.getFCashComponents(setToken);
        fCashMaturities = new uint256[](fCashComponents.length);
        for(uint256 i = 0; i < fCashComponents.length; i++) {
            fCashMaturities[i] = _remainingToAbsoluteMaturity(IWrappedfCashComplete(fCashComponents[i]).getMaturity() - block.timestamp);
        }
    }


    // /* ============ Internal Functions ============ */

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
