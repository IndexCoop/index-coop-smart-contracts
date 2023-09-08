/*
    Copyright 2022 Set Labs Inc.

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

import { ISetToken } from "../interfaces/ISetToken.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";
import { ModuleMock } from "./ModuleMock.sol";

contract BaseGlobalExtensionMock is BaseGlobalExtension {

    /* ============ State Variables ============ */

    ModuleMock public immutable module;

    /* ============ Constructor ============ */

    constructor(
        IManagerCore _managerCore,
        ModuleMock _module
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        module = _module;
    }

    /* ============ External Functions ============ */

    function initializeExtension(
        IDelegatedManager _delegatedManager
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        _initializeExtension(_delegatedManager.setToken(), _delegatedManager);
    }

    function initializeModuleAndExtension(
        IDelegatedManager _delegatedManager
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);

        bytes memory callData = abi.encodeWithSignature("initialize(address)", setToken);
        _invokeManager(_delegatedManager, address(module), callData);
    }

    function testInvokeManager(ISetToken _setToken, address _module, bytes calldata _encoded) external {
        _invokeManager(_manager(_setToken), _module, _encoded);
    }

    function testOnlyOwner(ISetToken _setToken)
        external
        onlyOwner(_setToken)
    {}

    function testOnlyMethodologist(ISetToken _setToken)
        external
        onlyMethodologist(_setToken)
    {}

    function testOnlyOperator(ISetToken _setToken)
        external
        onlyOperator(_setToken)
    {}

    function testOnlyOwnerAndValidManager(IDelegatedManager _delegatedManager)
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {}

    function testOnlyAllowedAsset(ISetToken _setToken, address _asset)
        external
        onlyAllowedAsset(_setToken, _asset)
    {}

    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        _removeExtension(setToken, delegatedManager);
    }
}
