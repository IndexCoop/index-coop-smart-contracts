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

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { TimeLockUpgrade } from "../lib/TimeLockUpgrade.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";


/**
 * @title StreamingFeeSplitExtension
 * @author Set Protocol
 *
 * Smart contract manager extension that allows for splitting and setting streaming fees. Fee splits are updated by operator.
 * Any fee updates are timelocked.
 */
contract StreamingFeeSplitExtension is BaseExtension, TimeLockUpgrade, MutualUpgrade {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event FeesDistributed(
        address indexed _operatorFeeRecipient,
        address indexed _methodologist,
        uint256 _operatorTake,
        uint256 _methodologistTake
    );

    /* ============ State Variables ============ */

    ISetToken public setToken;
    IStreamingFeeModule public streamingFeeModule;

    // Percent of fees in precise units (10^16 = 1%) sent to operator, rest to methodologist
    uint256 public operatorFeeSplit;

    // Address which receives operator's share of fees when they're distributed. (See IIP-72)
    address public operatorFeeRecipient;

    /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        IStreamingFeeModule _streamingFeeModule,
        uint256 _operatorFeeSplit,
        address _operatorFeeRecipient
    )
        public
        BaseExtension(_manager)
    {
        streamingFeeModule = _streamingFeeModule;
        operatorFeeSplit = _operatorFeeSplit;
        operatorFeeRecipient = _operatorFeeRecipient;
        setToken = manager.setToken();
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual,
     * calculates fees for operator and methodologist, and sends to operatorFeeRecipient and methodologist
     * respectively.
     */
    function accrueFeesAndDistribute() public {
        // Emits a FeeActualized event
        streamingFeeModule.accrueFee(setToken);

        uint256 totalFees = setToken.balanceOf(address(this));

        address methodologist = manager.methodologist();

        uint256 operatorTake = totalFees.preciseMul(operatorFeeSplit);
        uint256 methodologistTake = totalFees.sub(operatorTake);

        if (operatorTake > 0) {
            setToken.transfer(operatorFeeRecipient, operatorTake);
        }

        if (methodologistTake > 0) {
            setToken.transfer(methodologist, methodologistTake);
        }

        emit FeesDistributed(operatorFeeRecipient, methodologist, operatorTake, methodologistTake);
    }

    /**
     * MUTUAL UPGRADE: Initializes the streaming fee module. Operator and Methodologist must each call
     * this function to execute the update.
     *
     * This method is called after invoking `replaceProtectedModule` or `emergencyReplaceProtectedModule`
     * to configure the replacement streaming fee module's fee settings.
     *
     * @dev FeeState settings encode the following struct
     * ```
     * struct FeeState {
     *   address feeRecipient;                // Address to accrue fees to
     *   uint256 maxStreamingFeePercentage;   // Max streaming fee maanager commits to using (1% = 1e16, 100% = 1e18)
     *   uint256 streamingFeePercentage;      // Percent of Set accruing to manager annually (1% = 1e16, 100% = 1e18)
     *   uint256 lastStreamingFeeTimestamp;   // Timestamp last streaming fee was accrued
     *}
     *```
     * @param _settings     FeeModule.FeeState settings
     */
    function initializeModule(IStreamingFeeModule.FeeState memory _settings)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
    {
        bytes memory callData = abi.encodeWithSelector(
            IStreamingFeeModule.initialize.selector,
            manager.setToken(),
            _settings
        );

        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates streaming fee on StreamingFeeModule. Operator and Methodologist must
     * each call this function to execute the update. Because the method is timelocked, each party
     * must call it twice: once to set the lock and once to execute.
     *
     * Method is timelocked to protect token owners from sudden changes in fee structure which
     * they would rather not bear. The delay gives them a chance to exit their positions without penalty.
     *
     * NOTE: This will accrue streaming fees though not send to operator fee recipient and methodologist.
     *
     * @param _newFee       Percent of Set accruing to fee extension annually (1% = 1e16, 100% = 1e18)
     */
    function updateStreamingFee(uint256 _newFee)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
        timeLockUpgrade
    {
        bytes memory callData = abi.encodeWithSelector(
            IStreamingFeeModule.updateStreamingFee.selector,
            manager.setToken(),
            _newFee
        );

        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates fee recipient on streaming fee module.
     *
     * @param _newFeeRecipient  Address of new fee recipient. This should be the address of the fee extension itself.
     */
    function updateFeeRecipient(address _newFeeRecipient)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
    {
        bytes memory callData = abi.encodeWithSelector(
            IStreamingFeeModule.updateFeeRecipient.selector,
            manager.setToken(),
            _newFeeRecipient
        );

        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates fee split between operator and methodologist. Split defined in precise units (1% = 10^16).
     * Fees will be accrued and distributed before the new split goes into effect.
     *
     * @param _newFeeSplit      Percent of fees in precise units (10^16 = 1%) sent to operator, (rest go to the methodologist).
     */
    function updateFeeSplit(uint256 _newFeeSplit)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
    {
        require(_newFeeSplit <= PreciseUnitMath.preciseUnit(), "Fee must be less than 100%");
        accrueFeesAndDistribute();
        operatorFeeSplit = _newFeeSplit;
    }

    /**
     * OPERATOR ONLY: Updates the address that receives the operator's share of the fees (see IIP-72)
     *
     * @param _newOperatorFeeRecipient  Address to send operator's fees to.
     */
    function updateOperatorFeeRecipient(address _newOperatorFeeRecipient)
        external
        onlyOperator
    {
        require(_newOperatorFeeRecipient != address(0), "Zero address not valid");
        operatorFeeRecipient = _newOperatorFeeRecipient;
    }
}