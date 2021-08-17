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
import { IIssuanceModule } from "../interfaces/IIssuanceModule.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { TimeLockUpgrade } from "../lib/TimeLockUpgrade.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";


/**
 * @title FeeSplitExtension
 * @author Set Protocol
 *
 * Smart contract extension that allows for splitting and setting streaming and mint/redeem fees.
 */
contract FeeSplitExtension is BaseAdapter, TimeLockUpgrade, MutualUpgrade {
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
    IIssuanceModule public issuanceModule;

    // Percent of fees in precise units (10^16 = 1%) sent to operator, rest to methodologist
    uint256 public operatorFeeSplit;

    // Address which receives operator's share of fees when they're distributed. (See IIP-72)
    address public operatorFeeRecipient;

    /* ============ Constructor ============ */

    constructor(
        IBaseManager _manager,
        IStreamingFeeModule _streamingFeeModule,
        IIssuanceModule _issuanceModule,
        uint256 _operatorFeeSplit,
        address _operatorFeeRecipient
    )
        public
        BaseAdapter(_manager)
    {
        streamingFeeModule = _streamingFeeModule;
        issuanceModule = _issuanceModule;
        operatorFeeSplit = _operatorFeeSplit;
        operatorFeeRecipient = _operatorFeeRecipient;
        setToken = manager.setToken();
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * operator and methodologist, and sends to operator and methodologist, and sends to operatorFeeRecipient and methodlogist
     * respectively. NOTE: mint/redeem fees will automatically be sent to this address so reading the balance of the SetToken
     * in the contract after accrual is sufficient for accounting for all collected fees.
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
     * MUTUAL UPGRADE: Updates streaming fee on StreamingFeeModule. NOTE: This will accrue streaming
     * fees though not send to operator fee recipient and methodologist.
     */
    function updateStreamingFee(uint256 _newFee)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
        timeLockUpgrade
    {
        bytes memory callData = abi.encodeWithSignature("updateStreamingFee(address,uint256)", manager.setToken(), _newFee);
        invokeManager(address(streamingFeeModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates issue fee on IssuanceModule. Only is executed once time lock has passed.
     */
    function updateIssueFee(uint256 _newFee)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
        timeLockUpgrade
    {
        bytes memory callData = abi.encodeWithSignature("updateIssueFee(address,uint256)", manager.setToken(), _newFee);
        invokeManager(address(issuanceModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates redeem fee on IssuanceModule. Only is executed once time lock has passed.
     */
    function updateRedeemFee(uint256 _newFee)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
        timeLockUpgrade
    {
        bytes memory callData = abi.encodeWithSignature("updateRedeemFee(address,uint256)", manager.setToken(), _newFee);
        invokeManager(address(issuanceModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates fee recipient on both streaming fee and issuance modules.
     */
    function updateFeeRecipient(address _newFeeRecipient)
        external
        mutualUpgrade(manager.operator(), manager.methodologist())
    {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,address)", manager.setToken(), _newFeeRecipient);
        invokeManager(address(streamingFeeModule), callData);
        invokeManager(address(issuanceModule), callData);
    }

    /**
     * MUTUAL UPGRADE: Updates fee split between operator and methodologist. Split defined in precise units (1% = 10^16).
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
     */
    function updateOperatorFeeRecipient(address _newOperatorFeeRecipient)
        external
        onlyOperator
    {
        require(_newOperatorFeeRecipient != address(0), "Zero address not valid");
        operatorFeeRecipient = _newOperatorFeeRecipient;
    }
}
