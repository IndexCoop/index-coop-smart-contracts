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
pragma experimental ABIEncoderV2;

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IGeneralIndexModule } from "../interfaces/IGeneralIndexModule.sol";
import { ITransformHelper } from "../interfaces/ITransformHelper.sol";

contract IPRebalanceExtension is BaseExtension {

    /* ============ Structs =========== */

    struct TransformInfo {
        address underlyingComponent;
        ITransformHelper transformHelper;
    }

    struct RebalanceParam {
        uint256 targetUnderlyingUnits;
        uint256 transformPercentage;
    }

    /* ========== State Variables ========= */

    IGeneralIndexModule public generalIndexModule;
    
    uint256 public untransforms;
    uint256 public transforms;

    mapping(address => uint256) public untransformUnits;
    mapping(address => uint256) public transformUnits;

    mapping(address => TransformInfo) public transformComponentInfo;

    mapping(address => RebalanceParam) public rebalanceParams;
    address[] public setComponentList;

    mapping(address => uint256) public startingUnderlyingComponentUnits;

    bool public tradesComplete;

    /* ========== Constructor ========== */

    constructor(IBaseManager _manager, IGeneralIndexModule _generalIndexModule) public BaseExtension(_manager) {
        generalIndexModule = _generalIndexModule;
    }

    /* ======== External Functions ======== */

    function setTransformInfo(address _transformComponent, TransformInfo memory _transformInfo) external onlyOperator {
        require(
            transformComponentInfo[_transformComponent].underlyingComponent == address(0),
            "TransformInfo already set"
        );
        transformComponentInfo[_transformComponent] = _transformInfo;
    }

    function updateTransformInfo(address _transformComponent, TransformInfo memory _transformInfo) external onlyOperator {
        require(
            transformComponentInfo[_transformComponent].underlyingComponent != address(0),
            "TransformInfo not set yet"
        );
        transformComponentInfo[_transformComponent] = _transformInfo;
    }

}