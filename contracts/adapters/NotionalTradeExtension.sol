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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { INotionalTradeModule } from "../interfaces/INotionalTradeModule.sol";

/**
 * @title NotionalTradeExtension
 * @author Index Coop
 *
 * Manager extension for interacting with NotionalTradeModule
 */
contract NotionalTradeExtension is BaseExtension {

    /* ========== State Variables ========= */

    // Address of Set Token
    ISetToken public immutable setToken;

    // Address of NotionalTradeModule
    INotionalTradeModule public immutable notionalTradeModule;

    /* ============ Constructor ============ */

    /**
     * Sets state variables
     *
     * @param _manager                  Manager contract
     * @param _notionalTradeModule      Set Protocol NotionalTradeModule
     */
    constructor(IBaseManager _manager, INotionalTradeModule _notionalTradeModule) public BaseExtension(_manager) {
        manager = _manager;
        setToken = manager.setToken();
        notionalTradeModule = _notionalTradeModule;
    }

    /* ========== External Functions ========== */

    /**
     * OPERATOR ONLY: Initializes the Set Token on the NotionalTradeModule.
     */
    function initialize() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.initialize.selector, setToken);
        invokeManager(address(notionalTradeModule), data);
    }

    function redeemMaturedPositions() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.redeemMaturedPositions.selector, setToken);
        invokeManager(address(notionalTradeModule), data);
    }

    function setRedeemToUnderlying(bool _toUnderlying) external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.setRedeemToUnderlying.selector, setToken, _toUnderlying);
        invokeManager(address(notionalTradeModule), data);
    }

    function mintFixedFCashForToken(uint16 _currencyId, uint40 _maturity, uint256 _mintAmount, address _sendToken, uint256 _maxSendAmount) external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.mintFixedFCashForToken.selector, setToken, _currencyId, _maturity, _mintAmount, _sendToken, _maxSendAmount);
        invokeManager(address(notionalTradeModule), data);
    }

    function redeemFixedFCashForToken(uint16 _currencyId, uint40 _maturity, uint256 _redeemAmount, address _receiveToken, uint256 _minReceiveAmount) external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.redeemFixedFCashForToken.selector, setToken, _currencyId, _maturity, _redeemAmount, _receiveToken, _minReceiveAmount);
        invokeManager(address(notionalTradeModule), data);
    }

    function mintFCashForFixedToken(uint16 _currencyId, uint40 _maturity, uint256 _minMintAmount, address _sendToken, uint256 _sendAmount) external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.mintFCashForFixedToken.selector, setToken, _currencyId, _maturity, _minMintAmount, _sendToken, _sendAmount);
        invokeManager(address(notionalTradeModule), data);
    }

    function redeemFCashForFixedToken(uint16 _currencyId, uint40 _maturity, uint256 _maxRedeemAmount, address _receiveToken, uint256 _receiveAmount, uint256 _maxReceiveAmountDeviation) external onlyOperator {
        bytes memory data = abi.encodeWithSelector(notionalTradeModule.redeemFCashForFixedToken.selector, setToken, _currencyId, _maturity, _maxRedeemAmount, _receiveToken, _receiveAmount, _maxReceiveAmountDeviation);
        invokeManager(address(notionalTradeModule), data);
    }
}