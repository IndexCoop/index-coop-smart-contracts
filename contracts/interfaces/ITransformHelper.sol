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

import { ISetToken } from "./ISetToken.sol";

interface ITransformHelper {

    function getExchangeRate(address _underlyingComponent, address _transformComponent) external view returns (uint256);

    function getTransformData(
        ISetToken _setToken,
        address _underlyingComponent,
        address _transformComponent,
        uint256 _units
    ) external view returns (bytes memory);

    function getUntransformData(
        ISetToken _setToken,
        address _underlyingComponent,
        address _transformComponent,
        uint256 _units
    ) external view returns (bytes memory);

    function getTransformCall(
        ISetToken _setToken,
        address _underlyingComponent,
        address _transformComponent,
        uint256 _units,
        bytes memory _transformData
    ) external view returns (address, bytes memory);

    function getUntransformCall(
        ISetToken _setToken,
        address _underlyingComponent,
        address _transformComponent,
        uint256 _units,
        bytes memory _untransformData
    ) external view returns (address, bytes memory);

    function shouldTransform(address _underlyingComponent, address _transformComponent) external view returns (bool);

    function shouldUntransform(address _underlyingComponent, address _untransformComponent) external view returns (bool);
}