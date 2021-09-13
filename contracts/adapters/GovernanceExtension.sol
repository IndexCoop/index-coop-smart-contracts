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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IGovernanceModule } from "../interfaces/IGovernanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title GovernanceExtension
 * @author Set Protocol
 *
 * Smart contract extension that acts as a manager interface for interacting with the Set Protocol
 * GovernanceModule to perform meta-governance actions. All governance functions are callable only
 * by a subset of allowed callers. The operator has the power to add/remove callers from the allowed
 * callers mapping.
 */
contract GovernanceExtension is BaseExtension {

    /* ============ State Variables ============ */

    ISetToken public setToken;
    IGovernanceModule public governanceModule;

    /* ============ Constructor ============ */

    constructor(IBaseManager _manager, IGovernanceModule _governanceModule) public BaseExtension(_manager) {
        governanceModule = _governanceModule;
        setToken = manager.setToken();
    }

    /* ============ External Functions ============ */

    /**
     * ONLY APPROVED CALLER: Submits a delegate call to the GovernanceModule. Approved caller mapping
     * is part of BaseExtension.
     *
     * @param _governanceName       Name of governance extension being used
     */
    function delegate(
        string memory _governanceName,
        address _delegatee
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        bytes memory callData = abi.encodeWithSelector(
            IGovernanceModule.delegate.selector,
            setToken,
            _governanceName,
            _delegatee
        );

        invokeManager(address(governanceModule), callData);
    }

    /**
     * ONLY APPROVED CALLER: Submits a proposal call to the GovernanceModule. Approved caller mapping
     * is part of BaseExtension.
     *
     * @param _governanceName       Name of governance extension being used
     * @param _proposalData         Byte data of proposal
     */
    function propose(
        string memory _governanceName,
        bytes memory _proposalData
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        bytes memory callData = abi.encodeWithSelector(
            IGovernanceModule.propose.selector,
            setToken,
            _governanceName,
            _proposalData
        );

        invokeManager(address(governanceModule), callData);
    }

    /**
     * ONLY APPROVED CALLER: Submits a register call to the GovernanceModule. Approved caller mapping
     * is part of BaseExtension.
     *
     * @param _governanceName       Name of governance extension being used
     */
    function register(string memory _governanceName) external onlyAllowedCaller(msg.sender) {
        bytes memory callData = abi.encodeWithSelector(
            IGovernanceModule.register.selector,
            setToken,
            _governanceName
        );

        invokeManager(address(governanceModule), callData);
    }

    /**
     * ONLY APPROVED CALLER: Submits a revoke call to the GovernanceModule. Approved caller mapping
     * is part of BaseExtension.
     *
     * @param _governanceName       Name of governance extension being used
     */
    function revoke(string memory _governanceName) external onlyAllowedCaller(msg.sender) {
        bytes memory callData = abi.encodeWithSelector(
            IGovernanceModule.revoke.selector,
            setToken,
            _governanceName
        );

        invokeManager(address(governanceModule), callData);
    }

    /**
     * ONLY APPROVED CALLER: Submits a vote call to the GovernanceModule. Approved caller mapping
     * is part of BaseExtension.
     *
     * @param _governanceName       Name of governance extension being used
     * @param _proposalId           Id of proposal being voted on
     * @param _support              Boolean indicating if supporting proposal
     * @param _data                 Arbitrary bytes to be used to construct vote call data
     */
    function vote(
        string memory _governanceName,
        uint256 _proposalId,
        bool _support,
        bytes memory _data
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        bytes memory callData = abi.encodeWithSelector(
            IGovernanceModule.vote.selector,
            setToken,
            _governanceName,
            _proposalId,
            _support,
            _data
        );

        invokeManager(address(governanceModule), callData);
    }

    /**
     * ONLY OPERATOR: Initialize GovernanceModule for Set
     */
    function initialize() external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IGovernanceModule.initialize.selector,
            setToken
        );

        invokeManager(address(governanceModule), callData);
    }
}