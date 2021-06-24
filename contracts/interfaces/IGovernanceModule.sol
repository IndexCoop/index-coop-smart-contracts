/*
    Copyright 2020 Set Labs Inc.
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

import { ISetToken } from "./ISetToken.sol";

interface IGovernanceModule {
    function delegate(ISetToken _setToken, string memory _governanceName, address _delegatee) external;
    function propose(ISetToken _setToken, string memory _governanceName, bytes memory _proposalData) external;
    function register(ISetToken _setToken, string memory _governanceName) external;
    function revoke(ISetToken _setToken, string memory _governanceName) external;
    function vote(
        ISetToken _setToken,
        string memory _governanceName,
        uint256 _proposalId,
        bool _support,
        bytes memory _data
    )
        external;
    function initialize(ISetToken _setToken) external;
}