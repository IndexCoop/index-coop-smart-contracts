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
import { IWrappedfCashComplete } from "../interfaces/IWrappedfCash.sol";
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

    mapping(uint256 => bool) internal validMaturities;              // Mapping of valid maturities
    ISetToken setToken;                             // Instance of leverage token
    INotionalTradeModule notionalTradeModule;                             // Instance of leverage token
    address underlyingToken;
    uint256[] maturities;                           // Array of relative maturities in seconds (i.e. 3 months / 6 months)
    uint256[] allocations;                          // Relative allocations 

    // /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        ISetToken _setToken,
        INotionalTradeModule _notionalTradeModule,
        address _underlyingToken,
        uint256[] memory _maturities,
        uint256[] memory _allocations,
        uint256[] memory _validMaturities
    )
        public
        BaseExtension(_manager)
    {
        setToken = _setToken;
        notionalTradeModule = _notionalTradeModule;
        underlyingToken = _underlyingToken;

        for(uint256 i = 0; i < _validMaturities.length; i++) {
            validMaturities[_validMaturities[i]] = true;
            emit MaturityStatusSet(_validMaturities[i], true);
        }

        _setAllocations(_maturities, _allocations);
    }

    // /* ============ External Functions ============ */

    function rollOverPosition(uint256 _executionShare) external onlyOperator {
        notionalTradeModule.redeemMaturedPositions(setToken);
        int256 underlyingPosition = setToken.getDefaultPositionRealUnit(underlyingToken);
        require(underlyingPosition > 0, "No underlying position");
        uint256 underlyingPositionUint = uint256(underlyingPosition);

    }

    function getFCashComponentsAndMaturities() external view returns (address[] memory, uint256[] memory) {
        return _getFCashComponentsAndMaturities();
    }

    function _getFCashComponentsAndMaturities() 
    internal
    view
    returns (address[] memory fCashComponents, uint256[] memory fCashMaturities)
    {
        fCashComponents = notionalTradeModule.getFCashComponents(setToken);
        fCashMaturities = new uint256[](fCashComponents.length);
        for(uint256 i = 0; i < fCashComponents.length; i++) {
            fCashMaturities[i] = IWrappedfCashComplete(fCashComponents[i]).getMaturity();
        }
    }


    // /* ============ Internal Functions ============ */

    function _setAllocations(uint256[] memory _maturities, uint256[] memory _allocations) internal {
        require(_maturities.length == _allocations.length, "Maturities and allocations must be same length");
        uint256 totalAllocation = 0;
        for (uint256 i = 0; i < _allocations.length; i++) {
            require(validMaturities[_maturities[i]], "Invalid maturity");
            totalAllocation = totalAllocation.add(_allocations[i]);
        }
        require(totalAllocation == PreciseUnitMath.preciseUnit(), "Allocations must sum to 1");
        maturities = _maturities;
        allocations = _allocations;
    }
}
