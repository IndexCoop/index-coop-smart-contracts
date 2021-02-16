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

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { BaseAdapter } from "./BaseAdapter.sol";
import { IICManagerV2 } from "../interfaces/IICManagerV2.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


/**
 * @title FeeSplitAdapter
 * @author Set Protocol
 *
 * Smart contract adapter that allows for splitting and setting streaming and mint/redeem fees. 
 */
contract FeeSplitAdapter is MutualUpgrade, BaseAdapter {
    using Address for address;
    using PreciseUnitMath for uint256;

    /* ============ Events ============ */

    event FeesAccrued(address indexed _operator, address indexed _methodologist, uint256 _operatorTake, uint256 _methodologistTake);
    
    /* ============ State Variables ============ */

    // Streaming fee module address
    IStreamingFeeModule public streamingFeeModule;

    // Debt issuance module address
    IDebtIssuanceModule public debtIssuanceModule;

    // Percent of fees in precise units (10^16 = 1%) sent to operator, rest to methodologist
    uint256 public operatorFeeSplit;

    /* ============ Constructor ============ */

    constructor(
        IICManagerV2 _manager,
        address _streamingFeeModule,
        address _debtIssuanceModule,
        uint256 _operatorFeeSplit
    )
        public
        BaseAdapter(_manager)
    {
        streamingFeeModule = _streamingFeeModule;
        debtIssuanceModule = _debtIssuanceModule;
        operatorFeeSplit = _operatorFeeSplit;
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * operator and methodologist, and sends to each. NOTE: mint/redeem fees will automatically be sent to this address so reading
     * the balance of the SetToken in the contract after accrual is sufficient for accounting for all collected fees.
     */
    function accrueFeesAndDistribute() external {
        ISetToken setToken = manager.setToken();

        streamingFeeModule.accrueFee(setToken);
        
        uint256 totalFees = setToken.balanceOf(address(this));
        
        uint256 operatorTake = totalFees.preciseMul(operatorFeeSplit);
        uint256 methodologistTake = totalFees.sub(operatorTake);

        setToken.transfer(operator, operatorTake);
        setToken.transfer(methodologist, methodologistTake);

        emit FeesAccrued(operator, methodologist, operatorTake, methodologistTake);
    }
}