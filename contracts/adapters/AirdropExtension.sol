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

    IAirdropModule public airdropModule;
    ISetToken public setToken;

    constructor(IBaseManager _manager, IAirdropModule _airdropModule) public BaseExtension(_manager) {
        airdropModule = _airdropModule;
        setToken = manager.setToken();
    }

    function initializeAirdropModule(IAirdropModule.AirdropSettings memory _airdropSettings) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("initialize(address,(address[],address,uint256,bool))", setToken, _airdropSettings)
        );
    }

    function absorb(address _token) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("absorb(address,address)", setToken, _token)
        );
    }

    function batchAbsorb(address[] memory _tokens) external {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("batchAbsorb(address,address[])", setToken, _tokens)
        );
    }

    function addAirdrop(address _token) external {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("addAirdrop(address,address)", setToken, _token)
        );
    }

    function removeAirdrop(address _token) external {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("removeAirdrop(address,address)", setToken, _token)
        );
    }

    function updateAnyoneAbsorb(bool _anyoneAbsorb) external {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("updateAnyoneAbsorb(address,bool)", setToken, _anyoneAbsorb)
        );
    }

    function updateFeeRecipient(address _newRecipient) external {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("updateFeeRecipient(address,address)", setToken, _newRecipient)
        );
    }

    function updateAirdropFee(uint256 _newFee) external {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("updateAirdropFee(address,uint256)", setToken, _newFee)
        );
    }
}