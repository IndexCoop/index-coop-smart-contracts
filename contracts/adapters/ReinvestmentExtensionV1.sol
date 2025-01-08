/*
    Copyright 2024 Index Cooperative.

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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { ITradeModule } from "../interfaces/ITradeModule.sol";
import { IWrapModuleV2 } from "../interfaces/IWrapModuleV2.sol";

/**
 * @title ReinvestmentExtensionV1
 * @author Index Cooperative
 */
contract ReinvestmentExtensionV1 is BaseExtension {
    
    using Address for address;
    using SafeCast for int256;

    /* ========== Structs ================= */

    struct ExecutionSettings {
        string exchangeName;
        bytes exchangeCallData;
    }

    /* ========== State Variables ========= */

    address public immutable WETH;
    ISetToken public immutable setToken;
    IAirdropModule public immutable airdropModule;
    ITradeModule public immutable tradeModule;
    IWrapModuleV2 public immutable wrapModule;

    mapping(address => ExecutionSettings) public settings;

    /* ============  Constructor ============ */ 

    constructor(
        IBaseManager _manager,
        address _weth,
        IAirdropModule _airdropModule,
        ITradeModule _tradeModule,
        IWrapModuleV2 _wrapModule
    ) public BaseExtension(_manager) {
        setToken = _manager.setToken();
        WETH = _weth;
        airdropModule = _airdropModule;
        tradeModule = _tradeModule;
        wrapModule = _wrapModule;
    }

    /* ============ External Functions ============ */

    /**
     * APPROVED_CALLER ONLY: Absorbs airdropped tokens and trades them for WETH
     * 
     * @param _rewardToken          Address of reward token to reinvest
     * @param _minReceiveQuantity   Minimum amount of WETH to receive
     */
    function reinvest(
        address _rewardToken,
        uint256 _minReceiveQuantity
    ) external onlyAllowedCaller(msg.sender) {
        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            setToken,
            _rewardToken 
        );
        invokeManager(address(airdropModule), absorbCallData);

        uint256 rewardUnits = uint256(setToken.getTotalComponentRealUnits(_rewardToken));
        require(rewardUnits > 0, "Reward units must be greater than zero");
        bytes memory tradeCallData = abi.encodeWithSelector(
            ITradeModule.trade.selector,
            setToken,
            settings[_rewardToken].exchangeName,
            _rewardToken,
            rewardUnits,
            WETH,
            _minReceiveQuantity,
            settings[_rewardToken].exchangeCallData
        );
        invokeManager(address(tradeModule), tradeCallData);
    }

    /**
     * OPERATOR ONLY: Wraps WETH into target wrapped token
     * 
     * @param _wrappedToken         Address of wrapped token
     * @param _underlyingUnits      Units of WETH to wrap
     * @param _integrationName      Name of wrap module integration
     * @param _wrapData            Encoded wrap data
     */
    function wrap(
        address _wrappedToken,
        uint256 _underlyingUnits,
        string calldata _integrationName,
        bytes memory _wrapData
    ) external onlyOperator {
        bytes memory wrapCallData = abi.encodeWithSelector(
            wrapModule.wrap.selector,
            setToken,
            WETH,
            _wrappedToken,
            _underlyingUnits,
            _integrationName,
            _wrapData
        );
        invokeManager(address(wrapModule), wrapCallData);
    }

    /**
     * OPERATOR ONLY: Adds new token to airdrop list
     * 
     * @param _token    Address of token to add to airdrop list
     */
    function addAirdrop(address _token) external onlyOperator {
        invokeManager(
            address(airdropModule),
            abi.encodeWithSignature("addAirdrop(address,address)", setToken, _token)
        );
    }

    /**
     * APPROVED_CALLER ONLY: Updates execution settings for a reward token
     * 
     * @param _rewardToken    Address of reward token
     * @param _settings       New execution settings
     */
    function updateExecutionSettings(
        address _rewardToken,
        ExecutionSettings memory _settings
    ) external onlyAllowedCaller(msg.sender) {
        settings[_rewardToken] = _settings;
    }

    /**
     * OPERATOR ONLY: Initializes the AirdropModule
     * 
     * @param _airdropSettings    Airdrop module initialization settings
     */
    function initializeAirdropModule(IAirdropModule.AirdropSettings memory _airdropSettings) external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            airdropModule.initialize.selector,
            setToken,
            _airdropSettings
        );
        invokeManager(address(airdropModule), callData);
    }

    /**
     * OPERATOR ONLY: Initializes the TradeModule
     */
    function initializeTradeModule() external onlyOperator {
        bytes memory tradeModuleData = abi.encodeWithSelector(tradeModule.initialize.selector, setToken);
        invokeManager(address(tradeModule), tradeModuleData);
    }

    /**
     * OPERATOR ONLY: Initializes the WrapModule
     */
    function initializeWrapModule() external onlyOperator {
        bytes memory wrapModuleData = abi.encodeWithSelector(wrapModule.initialize.selector, setToken);
        invokeManager(address(wrapModule), wrapModuleData);
    }
}