/*
    Copyright 2021 Index Coop.

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

contract TransformHelperMock {

    uint256 public exchangeRate;
    address public wrapModuleV2;
    string public integrationName;
    bool public shouldTransformUntransform;

    constructor(uint256 _exchangeRate, address _wrapModuleV2, string memory _integrationName) public {
        exchangeRate = _exchangeRate;
        wrapModuleV2 = _wrapModuleV2;
        integrationName = _integrationName;
        shouldTransformUntransform = true;
    }

    /* =========== Setter Functions ========== */

    function setExchangeRate(uint256 _newExchangeRate) external {
        exchangeRate = _newExchangeRate;
    }

    function setShouldTransformUntransform(bool _newShouldTransformUntransform) external {
        shouldTransformUntransform = _newShouldTransformUntransform;
    }

    /* ========== Mock Functions ========= */

    function getExchangeRate(address /* _underlyingComponent */, address /* _transformComponent */) external view returns (uint256) {
        return exchangeRate;
    }

    function shouldUntransform(address /* _underlyingComponent */, address /* _untransformComponent */) external view returns (bool) {
        return shouldTransformUntransform;
    }

    function shouldTransform(address /* _underlyingComponent */, address /* _untransformComponent */) external view returns (bool) {
        return shouldTransformUntransform;
    }

    function getUntransformCall(
        ISetToken _setToken,
        address _underlyingComponent,
        address _transformComponent,
        uint256 _units,
        bytes memory /* _untransformData */
    )
        external
        view
        returns (address, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "unwrap(address,address,address,uint256,string,bytes)",
            _setToken,
            _underlyingComponent,
            _transformComponent,
            _units,
            integrationName,
            ""
        );

        return (wrapModuleV2, callData);
    }

    function getTransformCall(
        ISetToken _setToken,
        address _underlyingComponent,
        address _transformComponent,
        uint256 _units,
        bytes memory /* _transformData */
    )
        external
        view
        returns (address, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "wrap(address,address,address,uint256,string,bytes)",
            _setToken,
            _underlyingComponent,
            _transformComponent,
            _units,
            integrationName,
            ""
        );

        return (wrapModuleV2, callData);
    }
}