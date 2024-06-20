/*
    Copyright 2024 Index Cooperative

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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { FeeSplitExtension } from "./FeeSplitExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IIssuanceModule } from "../interfaces/IIssuanceModule.sol";
import { IPrt } from "../interfaces/IPrt.sol";
import { IPrtStakingPool } from "../interfaces/IPrtStakingPool.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title PrtFeeSplitExtension
 * @dev Extension that allows for splitting and setting streaming and mint/redeem fees with a 
 * PRT Staking Pool. The operator can accrue fees from the streaming fee module and distribute
 * them to the operator and the PRT Staking Pool, snapshotting the PRT Staking Pool. The operator 
 * can update the PRT staking pool address and the fee split between the operator and the 
 * PRT staking pool. Includes an optional allow list and timelock on accrue function.
 */
contract PrtFeeSplitExtension is FeeSplitExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event AnyoneAccrueUpdated(bool isAnyoneAllowedToAccrue);
    event AccruerStatusUpdated(address indexed accruer, bool isAccruerAllowed);
    event OperatorFeeSplitUpdated(uint256 newFeeSplit);
    event PrtFeesDistributed(
        address indexed operatorFeeRecipient,
        address indexed prtStakingPool,
        uint256 operatorTake,
        uint256 prtTake
    );
    event PrtStakingPoolUpdated(address newPrtStakingPool);

    /* ============ Immutables ============ */

    IPrt public immutable prt;

    /* ============ State Variables ============ */

    bool public isAnyoneAllowedToAccrue;
    address[] accrueAllowList;
    mapping(address => bool) public accrueAllowMap;
    IPrtStakingPool public prtStakingPool;

    /* ============ Modifiers ============ */

    modifier onlyAllowedAccruer() {
        require(_isAllowedAccruer(msg.sender), "Not allowed to accrue");
        _;
    }

    /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        IStreamingFeeModule _streamingFeeModule,
        IIssuanceModule _issuanceModule,
        uint256 _operatorFeeSplit,
        address _operatorFeeRecipient,
        IPrt _prt
    )
        public
        FeeSplitExtension(
            _manager,
            _streamingFeeModule,
            _issuanceModule,
            _operatorFeeSplit,
            _operatorFeeRecipient
        )
    {
        require(_prt.setToken() == address(manager.setToken()), "SetToken mismatch with Prt");
        prt = _prt;
    }

    /* ============ External Functions ============ */

    /**
     * @notice MUTUAL UPGRADE: Updates PRT staking pool. PRT staking pool must have this extension set as the feeSplitExtension.
     * @param _prtStakingPool Address of the new PRT staking pool
     */
    function updatePrtStakingPool(IPrtStakingPool _prtStakingPool) 
        external 
        mutualUpgrade(manager.operator(), manager.methodologist()) 
    {
        require(address(_prtStakingPool) != address(0), "Zero address not valid");
        require(_prtStakingPool.distributor() == address(this), "PRT Staking Pool distributor must be this extension");
        require(_prtStakingPool.stakeToken() == address(prt), "PRT Staking Pool stake token must be PRT");
        require(_prtStakingPool.rewardToken() == address(manager.setToken()), "PRT Staking Pool reward token must be SetToken");
        prtStakingPool = _prtStakingPool;
        emit PrtStakingPoolUpdated(address(_prtStakingPool));
    }

    /**
     * @notice ONLY ALLOWED ACCRUER: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * operator and PRT staking pool, and sends to operator fee recipient and PRT Staking Pool respectively. NOTE: mint/redeem fees
     * will automatically be sent to this address so reading the balance of the SetToken in the contract after accrual is
     * sufficient for accounting for all collected fees. If the PRT take is greater than 0, the PRT Staking Pool will accrue the fees
     * and update the snapshot.
     */
    function accrueFeesAndDistribute() public override onlyAllowedAccruer {
        require(address(prtStakingPool) != address(0), "PRT Staking Pool not set");

        // Emits a FeeActualized event
        streamingFeeModule.accrueFee(setToken);

        uint256 totalFees = setToken.balanceOf(address(this));

        uint256 operatorTake = totalFees.preciseMul(operatorFeeSplit);
        uint256 prtTake = totalFees.sub(operatorTake);

        if (operatorTake > 0) {
            setToken.transfer(operatorFeeRecipient, operatorTake);
        }

        // Accrue PRT Staking Pool rewards and update snapshot
        if (prtTake > 0) {
            setToken.approve(address(prtStakingPool), prtTake);
            prtStakingPool.accrue(prtTake);
        }

        emit PrtFeesDistributed(operatorFeeRecipient, address(prtStakingPool), operatorTake, prtTake);
    }

    /**
     * @notice MUTUAL UPGRADE: Updates fee split between operator and PRT Staking Pool. Split defined in precise units (1% = 10^16).
     * Does not accrue fees and snapshot PRT Staking Pool.
     * @param _newFeeSplit Percent of fees in precise units (10^16 = 1%) sent to operator, (rest go to the PRT Staking Pool).
     */
    function updateFeeSplit(uint256 _newFeeSplit)
        external
        override
        mutualUpgrade(manager.operator(), manager.methodologist())
    {
        require(_newFeeSplit <= PreciseUnitMath.preciseUnit(), "Fee must be less than 100%");
        operatorFeeSplit = _newFeeSplit;
        emit OperatorFeeSplitUpdated(_newFeeSplit);
    }

    /**
     * @notice ONLY OPERATOR: Toggles the permission status of specified addresses to call the `accrueFeesAndDistribute()` function.
     * @param _accruers An array of addresses whose accrue permission status is to be toggled.
     * @param _statuses An array of booleans indicating the new accrue permission status for each corresponding address in `_accruers`.
     */
    function setAccruersStatus(
        address[] memory _accruers,
        bool[] memory _statuses
    )
        external
        onlyOperator
    {
        _accruers.validatePairsWithArray(_statuses);
        for (uint256 i = 0; i < _accruers.length; i++) {
            _updateAccrueAllowList(_accruers[i], _statuses[i]);
            accrueAllowMap[_accruers[i]] = _statuses[i];
            emit AccruerStatusUpdated(_accruers[i], _statuses[i]);
        }
    }

    /**
     * @notice ONLY OPERATOR: Toggles whether or not anyone is allowed to call the `accrueFeesAndDistribute()` function.
     * If set to true, it bypasses the accrueAllowList, allowing any address to call the `accrueFeesAndDistribute()` function.
     * @param _status A boolean indicating if anyone can accrue.
     */
    function updateAnyoneAccrue(bool _status)
        external
        onlyOperator
    {
        isAnyoneAllowedToAccrue = _status;
        emit AnyoneAccrueUpdated(_status);
    }

    /**
     * @notice Determines whether the given address is permitted to `accrueFeesAndDistribute()`.
     * @param _accruer Address of the accruer.
     * @return bool True if the given `_accruer` is permitted to accrue, false otherwise.
     */
    function isAllowedAccruer(address _accruer) external view returns (bool) {
        return _isAllowedAccruer(_accruer);
    }

    /**
     * @dev Retrieves the list of addresses that are permitted to `accrueFeesAndDistribute()`.
     * @return address[] Array of addresses representing the allowed accruers.
     */
    function getAllowedAccruers() external view returns (address[] memory) {
        return accrueAllowList;
    }


    /* ============ Internal Functions ============ */

    function _isAllowedAccruer(address _accruer) internal view returns (bool) {
        return isAnyoneAllowedToAccrue || accrueAllowMap[_accruer];
    }

    function _updateAccrueAllowList(address _accruer, bool _status) internal {
        if (_status && !accrueAllowList.contains(_accruer)) {
            accrueAllowList.push(_accruer);
        } else if(!_status && accrueAllowList.contains(_accruer)) {
            accrueAllowList.removeStorage(_accruer);
        }
    }
}
