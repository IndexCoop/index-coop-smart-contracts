/*
    Copyright 2024 Index Cooperative

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache-2.0	
*/

pragma solidity 0.6.10;

import { PreciseUnitMath } from "../../../lib/PreciseUnitMath.sol";

/**
 * @title PreciseUnitOracle
 * @author Index Cooperative
 *
 * Oracle built to retrieve the precise unit as price, useful for rebasing tokens like aUSDC and USDC
 */
contract PreciseUnitOracle {
    string public dataDescription;

    /*
     * @param  _dataDescription     Human readable description of oracle
     */
    constructor(string memory _dataDescription) public {
        dataDescription = _dataDescription;
    }

    /**
     * Returns the assets per one share of the vault
     */
    function read() external pure returns (uint256) {
        return PreciseUnitMath.preciseUnit();
    }
}
