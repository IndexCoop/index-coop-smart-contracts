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
import { IGovernanceModule } from "../interfaces/IGovernanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title GovernanceAdapter
 * @author Set Protocol
 *
 * Smart contract adapter that acts as a manager interface for interacting with the Set Protocol
 * GovernanceModule to perform meta-governance actions. All governance functions are callable only
 * by a subset of allowed callers. The operator has the power to add/remove callers from the allowed
 * callers mapping.
 */
contract GovernanceAdapter is BaseAdapter {

    /* ============ State Variables ============ */
    IGovernanceModule public governanaceModule;
    
    /* ============ Constructor ============ */

    constructor(IBaseManager _manager, IGovernanceModule _governanceModule) public BaseManager(_manager) {
        governanceModule = _governanceModule;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY APPROVED CALLER: Updates streaming fee on StreamingFeeModule. NOTE: This will accrue streaming fees though not send to operator
     * and methodologist.
     */
    function delegate(
        string memory _governanceName,
        address _delegatee
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        
    }

    function propose(
        string memory _governanceName,
        bytes memory _proposalData
    )
        external
        onlyAllowedCaller(msg.sender)
    {

    }

    function register(string memory _governanceName) external onlyAllowedCaller(msg.sender) {

    }

    function revoke(string memory _governanceName) external onlyAllowedCaller(msg.sender) {

    }

    function vote(
        string memory _governanceName,
        uint256 _proposalId,
        bool _support,
        bytes memory _data
    )
        external
        onlyAllowedCaller(msg.sender)
    {

    }

    function initialize() external onlyOperator {

    }
}