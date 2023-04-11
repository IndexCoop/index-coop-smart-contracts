/*
    Copyright 2021 Set Labs Inc.

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
import { AaveLeverageStrategyExtension } from "./AaveLeverageStrategyExtension.sol";

import { IBaseManager } from "../interfaces/IBaseManager.sol";


/**
 * @title AaveV3LeverageStrategyExtension
 * @author Set Protocol
 *
 * Smart contract that enables trustless leverage tokens. This extension is paired with the AaveV3LeverageModule from Set protocol where module 
 * interactions are invoked via the IBaseManager contract. Any leveraged token can be constructed as long as the collateral and borrow asset 
 * is available on AaveV3. This extension contract also allows the operator to set an ETH reward to incentivize keepers calling the rebalance
 * function at different leverage thresholds.
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
    { }
}
