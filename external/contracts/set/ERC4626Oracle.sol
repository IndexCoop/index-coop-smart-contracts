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

pragma solidity 0.8.17;

import { IERC4626 } from "../../../interfaces/external/IERC4626.sol";

/**
 * @title ERC4626Oracle
 * @author Index Cooperative
 *
 * Oracle built to retrieve the assets per one share of the ERC-4626 vault
 */
contract ERC4626Oracle {
    IERC4626 public immutable vault;
    uint256 public immutable underlyingFullUnit;
    uint256 public immutable vaultFullUnit;
    string public dataDescription;

    /*
     * @param  _vault               The address of the ERC-4626 vault
     * @param  _underlyingFullUnit  The full unit of the underlying asset
     * @param  _dataDescription     Human readable description of oracle
     */
    constructor(
        IERC4626 _vault,
        uint256 _underlyingFullUnit,
        string memory _dataDescription
    ) {
        vault = _vault;
        dataDescription = _dataDescription;

        underlyingFullUnit = _underlyingFullUnit;
        vaultFullUnit = 10 ** _vault.decimals();
    }

    /**
     * Returns the assets per one share of the vault
     */
    function read() external view returns (uint256) {
        uint256 assetsPerShare = vault.convertToAssets(vaultFullUnit);
        return assetsPerShare * vaultFullUnit / underlyingFullUnit;
    }
}
