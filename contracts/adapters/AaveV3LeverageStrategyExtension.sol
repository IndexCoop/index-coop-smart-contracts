/*
    Copyright 2023 Index Coop

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

import {AaveLeverageStrategyExtension} from "./AaveLeverageStrategyExtension.sol";

import {IBaseManager} from "../interfaces/IBaseManager.sol";

/**
 * @title AaveV3LeverageStrategyExtension
 * @author Index Coop
 *
 * Extension of AaveLeverageStrategyExtension to add endpoint for setting the eMode categoryId
 *
 */
contract AaveV3LeverageStrategyExtension is AaveLeverageStrategyExtension {
    constructor(
        IBaseManager _manager,
        ContractSettings memory _strategy,
        MethodologySettings memory _methodology,
        ExecutionSettings memory _execution,
        IncentiveSettings memory _incentive,
        string[] memory _exchangeNames,
        ExchangeSettings[] memory _exchangeSettings
    )
        public
        AaveLeverageStrategyExtension(
            _manager,
            _strategy,
            _methodology,
            _execution,
            _incentive,
            _exchangeNames,
            _exchangeSettings
        )
    {}

    /**
     * OPERATOR ONLY: Set eMode categoryId to new value
     *
     * @param _categoryId    eMode categoryId as defined on aaveV3
     */
    function setEModeCategory(uint8 _categoryId) external onlyOperator {
        _setEModeCategory(_categoryId);
    }

    function _setEModeCategory(uint8 _categoryId) internal {
        bytes memory setEmodeCallData =
            abi.encodeWithSignature("setEModeCategory(address,uint8)", address(strategy.setToken), _categoryId);
        invokeManager(address(strategy.leverageModule), setEmodeCallData);
    }
}
