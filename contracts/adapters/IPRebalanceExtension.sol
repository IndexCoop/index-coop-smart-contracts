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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IGeneralIndexModule } from "../interfaces/IGeneralIndexModule.sol";
import { ITransformHelper } from "../interfaces/ITransformHelper.sol";

contract IPRebalanceModule is BaseExtension {

    /* ============ Structs =========== */

    struct TransformInfo {
        address _underlyingComponent;
        ITransformHelper _transformHelper;
    }

    struct RebalanceParam {
        uint256 _targetUnderlyingUnits;
        uint256 _transformPercentage;
    }

    /* ========== State Variables ========= */

    IGeneralIndexModule public generalIndexModule;
    
    uint256 public untransforms;
    uint256 public transforms;

    mapping(address => uint256) public untransformUnits;
    mapping(address => uint256) public transformUnits;

    mapping(address => RebalanceParam) public rebalanceParams;
    address[] public setComponentList;

    mapping(address => uint256) public startingUnderlyingComponentUnits;

    bool public tradesComplete;

    /* ========== Constructor ========== */

    constructor(IBaseManager _manager, IGeneralIndexModule _generalIndexModule) public BaseExtension(_manager) {
        generalIndexModule = _generalIndexModule;
    }

}