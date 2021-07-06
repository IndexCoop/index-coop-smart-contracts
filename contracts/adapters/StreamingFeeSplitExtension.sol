/*
    Copyright 2021 IndexCooperative

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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BaseAdapter } from "../lib/BaseAdapter.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { TimeLockUpgrade } from "../lib/TimeLockUpgrade.sol";


/**
 * @title StreamingFeeSplitExtension
 * @author Set Protocol
 *
 * Smart contract manager extension that allows for splitting and setting streaming fees. Fee splits are updated by operator.
 * Any fee updates are timelocked.
 */
contract StreamingFeeSplitExtension is BaseAdapter, TimeLockUpgrade {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event FeesAccrued(address indexed _operator, address indexed _methodologist, uint256 _operatorTake, uint256 _methodologistTake);
    
    /* ============ State Variables ============ */

    ISetToken public setToken;
    IStreamingFeeModule public streamingFeeModule;

    // Percent of fees in precise units (10^16 = 1%) sent to operator, rest to methodologist
    uint256 public operatorFeeSplit;

    /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        IStreamingFeeModule _streamingFeeModule,
        uint256 _operatorFeeSplit
    )
        public
        BaseAdapter(_manager)
    {
        streamingFeeModule = _streamingFeeModule;
        operatorFeeSplit = _operatorFeeSplit;
        setToken = manager.setToken();
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * operator and methodologist, and sends to each.
     */
    function accrueFeesAndDistribute() public {
        streamingFeeModule.accrueFee(setToken);
        
        uint256 totalFees = setToken.balanceOf(address(manager));
        
        address operator = manager.operator();
        address methodologist = manager.methodologist();

        uint256 operatorTake = totalFees.preciseMul(operatorFeeSplit);
        uint256 methodologistTake = totalFees.sub(operatorTake);

        if (operatorTake > 0) {
            invokeManagerTransfer(address(setToken), operator, operatorTake);
        }

        if (methodologistTake > 0) {
            invokeManagerTransfer(address(setToken), methodologist, methodologistTake);
        }

        emit FeesAccrued(operator, methodologist, operatorTake, methodologistTake);
    }

    /**
     * ONLY OPERATOR: Updates streaming fee on StreamingFeeModule. NOTE: This will accrue streaming fees to the manager contract
     * but not distribute to the operator and methodologist.
     */
    function updateStreamingFee(uint256 _newFee) external onlyOperator timeLockUpgrade {
        bytes memory callData = abi.encodeWithSelector(
            IStreamingFeeModule.updateStreamingFee.selector,
            manager.setToken(),
            _newFee
        );

        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * ONLY OPERATOR: Updates fee recipient on streaming fee module.
     */
    function updateFeeRecipient(address _newFeeRecipient) external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IStreamingFeeModule.updateFeeRecipient.selector,
            manager.setToken(),
            _newFeeRecipient
        );

        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * ONLY OPERATOR: Updates fee split between operator and methodologist. Split defined in precise units (1% = 10^16). Fees will be
     * accrued and distributed before the new split goes into effect.
     */
    function updateFeeSplit(uint256 _newFeeSplit) external onlyOperator {
        require(_newFeeSplit <= PreciseUnitMath.preciseUnit(), "Fee must be less than 100%");
        accrueFeesAndDistribute();
        operatorFeeSplit = _newFeeSplit;
    }
}