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
 * PRT staking pool. 
 */
contract PrtFeeSplitExtension is FeeSplitExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event PrtFeesDistributed(
        address indexed operatorFeeRecipient,
        address indexed prtStakingPool,
        uint256 operatorTake,
        uint256 prtTake
    );

    /* ============ Immutables ============ */

    IPrt public immutable prt;

    /* ============ State Variables ============ */

    IPrtStakingPool public prtStakingPool;

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
     * @notice ONLY OPERATOR: Updates PRT staking pool. PRT staking pool must have this extension set as the feeSplitExtension.
     * @param _prtStakingPool Address of the new PRT staking pool
     */
    function updatePrtStakingPool(IPrtStakingPool _prtStakingPool) external onlyOperator {
        require(address(_prtStakingPool) != address(0), "Zero address not valid");
        require(_prtStakingPool.feeSplitExtension() == address(this), "PrtFeeSplitExtension must be set");
        prtStakingPool = _prtStakingPool;
    }

    /**
     * @notice ONLY OPERATOR: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * operator and PRT staking pool, and sends to operator fee recipient and PRT Staking Pool respectively. NOTE: mint/redeem fees
     * will automatically be sent to this address so reading the balance of the SetToken in the contract after accrual is
     * sufficient for accounting for all collected fees. If the PRT take is greater than 0, the PRT Staking Pool will accrue the fees
     * and update the snapshot.
     */
    function accrueFeesAndDistribute() public override onlyOperator {
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
     * @notice Updates fee split between operator and PRT Staking Pool. Split defined in precise units (1% = 10^16).
     * Does not accrue fees and snapshot PRT Staking Pool.
     * @param _newFeeSplit Percent of fees in precise units (10^16 = 1%) sent to operator, (rest go to the PRT Staking Pool).
     */
    function updateFeeSplit(uint256 _newFeeSplit)
        external
        override
        onlyOperator
    {
        require(_newFeeSplit <= PreciseUnitMath.preciseUnit(), "Fee must be less than 100%");
        operatorFeeSplit = _newFeeSplit;
    }
}
