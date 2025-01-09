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

    struct ExchangeSettings {
        string exchangeName;
        bytes exchangeCallData;
    }

    /* ========== State Variables ========= */

    address public immutable WETH;
    ISetToken public immutable setToken;
    IAirdropModule public immutable airdropModule;
    ITradeModule public immutable tradeModule;
    IWrapModuleV2 public immutable wrapModule;

    mapping(address => ExchangeSettings) public exchangeSettings;
    mapping(address => mapping(address => bool)) public approvedWrapPairs;

    /* ============  Constructor ============ */ 

    constructor(
        IBaseManager _manager,
        address _weth,
        IAirdropModule _airdropModule,
        ITradeModule _tradeModule,
        IWrapModuleV2 _wrapModule,
        address[] memory _initialRewardTokens,
        ExchangeSettings[] memory _initialExchangeSettings,
        address[][] memory _initialWrapPairs
    ) public BaseExtension(_manager) {
        require(_weth != address(0), "Invalid WETH address");
        
        setToken = _manager.setToken();
        WETH = _weth;
        airdropModule = _airdropModule;
        tradeModule = _tradeModule;
        wrapModule = _wrapModule;

        require(_initialRewardTokens.length == _initialExchangeSettings.length, "Arrays length mismatch");
        
        for (uint256 i = 0; i < _initialRewardTokens.length; i++) {
            require(_initialRewardTokens[i] != address(0), "Invalid reward token");
            exchangeSettings[_initialRewardTokens[i]] = _initialExchangeSettings[i];
        }

        for (uint256 i = 0; i < _initialWrapPairs.length; i++) {
            address underlyingToken = _initialWrapPairs[i][0];
            address wrappedToken = _initialWrapPairs[i][1];
            require(underlyingToken != address(0) && wrappedToken != address(0), "Invalid token address");
            approvedWrapPairs[underlyingToken][wrappedToken] = true;
        }
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
            exchangeSettings[_rewardToken].exchangeName,
            _rewardToken,
            rewardUnits,
            WETH,
            _minReceiveQuantity,
            exchangeSettings[_rewardToken].exchangeCallData
        );
        invokeManager(address(tradeModule), tradeCallData);
    }

    /**
     * OPERATOR ONLY: Wraps underlying token into target wrapped token
     * 
     * @param _underlyingToken      Address of underlying token
     * @param _wrappedToken         Address of wrapped token
     * @param _underlyingUnits      Units of underlying token to wrap
     * @param _integrationName      Name of wrap module integration
     * @param _wrapData            Encoded wrap data
     */
    function wrap(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits,
        string calldata _integrationName,
        bytes memory _wrapData
    ) external onlyAllowedCaller(msg.sender) {
        require(_underlyingUnits > 0, "Invalid units");
        require(approvedWrapPairs[_underlyingToken][_wrappedToken], "Unapproved wrap pair");
        
        bytes memory wrapCallData = abi.encodeWithSelector(
            wrapModule.wrap.selector,
            setToken,
            _underlyingToken,
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
     * OPERATOR ONLY: Updates exchange settings for a reward token
     */
    function updateExchangeSettings(
        address _rewardToken,
        ExchangeSettings memory _settings
    ) external onlyOperator {
        require(_rewardToken != address(0), "Invalid reward token");
        exchangeSettings[_rewardToken] = _settings;
    }

    /**
     * OPERATOR ONLY: Adds an approved wrap pair
     * 
     * @param _underlyingToken    Address of underlying token
     * @param _wrappedToken       Address of wrapped token
     */
    function addWrapPair(address _underlyingToken, address _wrappedToken) external onlyOperator {
        require(_underlyingToken != address(0) && _wrappedToken != address(0), "Invalid token address");
        require(!approvedWrapPairs[_underlyingToken][_wrappedToken], "Pair already exists");
        approvedWrapPairs[_underlyingToken][_wrappedToken] = true;
    }

    /**
     * OPERATOR ONLY: Removes an approved wrap pair
     * 
     * @param _underlyingToken    Address of underlying token
     * @param _wrappedToken       Address of wrapped token
     */
    function removeWrapPair(address _underlyingToken, address _wrappedToken) external onlyOperator {
        require(_underlyingToken != address(0) && _wrappedToken != address(0), "Invalid token address");
        require(approvedWrapPairs[_underlyingToken][_wrappedToken], "Pair does not exist");
        delete approvedWrapPairs[_underlyingToken][_wrappedToken];
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