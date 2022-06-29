/*
    Copyright 2021 Index Cooperative.

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
pragma experimental "ABIEncoderV2";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title AirdropExtension
 * @author Index Coop
 *
 * Manager extension for interacting with AirdropModule
 */
contract AirdropExtension is BaseExtension {

    /* ========== State Variables ========= */

    // Address of AirdropModule
    IAirdropModule public immutable airdropModule;

    // Address of Set Token
    ISetToken public immutable setToken;

    /* ============ Constructor ============ */

    /**
     * Sets state variables
     *
     * @param _manager          Manager contract
     * @param _airdropModule    Set Protocol AirdropModule
     */
    constructor(IBaseManager _manager, IAirdropModule _airdropModule) public BaseExtension(_manager) {
        airdropModule = _airdropModule;
        setToken = manager.setToken();
    }

    /* ========== External Functions ========== */

    /**
     * OPERATOR ONLY: initializes the AirdropModule. The recipient is always set to the manager and the fee to 0.
     *
     * @param _airdropSettings  Settings to initially the AirdropModule with
     */
    function initializeAirdropModule(IAirdropModule.AirdropSettings memory _airdropSettings) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("initialize(address,(address[],address,uint256,bool))", setToken, _airdropSettings)
        );
    }

    /**
     * OPERATOR ONLY: absorbs airdropped tokens
     *
     * @param _token    Airdropped token to absorb
     */
    function absorb(address _token) external onlyAllowedCaller(msg.sender) {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("absorb(address,address)", setToken, _token)
        );
    }

    /**
     * OPERATOR ONLY: batch absorbs airdropped tokens
     *
     * @param _tokens   List of airdropped tokens to absorb
     */
    function batchAbsorb(address[] memory _tokens) external onlyAllowedCaller(msg.sender) {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("batchAbsorb(address,address[])", setToken, _tokens)
        );
    }

    /**
     * OPERATOR ONLY: adds a new airdrop token
     *
     * @param _token    Airdropped token to add
     */
    function addAirdrop(address _token) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("addAirdrop(address,address)", setToken, _token)
        );
    }

    /**
     * OPERATOR ONLY: removes a new airdrop token
     *
     * @param _token    Airdropped token to remove
     */
    function removeAirdrop(address _token) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("removeAirdrop(address,address)", setToken, _token)
        );
    }

    /**
     * OPERATOR ONLY: updates the anyoneAbsorb setting
     *
     * @param _anyoneAbsorb     new anyoneAbsorb setting value
     */
    function updateAnyoneAbsorb(bool _anyoneAbsorb) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("updateAnyoneAbsorb(address,bool)", setToken, _anyoneAbsorb)
        );
    }
}