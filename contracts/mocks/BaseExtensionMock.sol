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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";

contract BaseExtensionMock is BaseExtension {

    constructor(IBaseManager _manager) public BaseExtension(_manager) {}

    /* ============ External Functions ============ */

    function testInvokeManager(address _module, bytes calldata _encoded) external {
        invokeManager(_module, _encoded);
    }

    function testOnlyOperator()
        external
        onlyOperator
    {}

    function testOnlyMethodologist()
        external
        onlyMethodologist
    {}

    function testOnlyEOA()
        external
        onlyEOA
    {}

    function testOnlyAllowedCaller(address _caller)
        external
        onlyAllowedCaller(_caller)
    {}

    function interactManager(address _target, bytes calldata _data) external {
        invokeManager(_target, _data);
    }
}