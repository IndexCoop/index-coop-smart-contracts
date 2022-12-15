/*
    Copyright 2022 Set Labs Inc.

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
import {INotionalTradeModule} from "../interfaces/INotionalTradeModule.sol";
import {ISetToken} from "../interfaces/ISetToken.sol";

// mock class using BasicToken
contract NotionalTradeModuleMock is INotionalTradeModule{

    function redeemMaturedPositions(ISetToken) external override {
    }

    function initialize(ISetToken) external override {
    }

    function updateAllowedSetToken(ISetToken, bool) external override {
    }

    function setRedeemToUnderlying(ISetToken, bool) external override {
    }
    
    function owner() external view override returns(address owner) {
    }

    function settleAccount(address) external override {
    }

    function getFCashComponents(ISetToken _setToken) external view override returns(address[] memory fCashComponents) {
    }

    function mintFixedFCashForToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _mintAmount,
        address _sendToken,
        uint256 _maxSendAmount
    ) external override returns(uint256 spentAmount) {
    }
    function redeemFixedFCashForToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _redeemAmount,
        address _receiveToken,
        uint256 _minReceiveAmount
    ) external override returns(uint256 receivedAmount) {
    }

    function mintFCashForFixedToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _minMintAmount,
        address _sendToken,
        uint256 _sendAmount
    ) external override returns(uint256) {}

    function redeemFCashForFixedToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _maxRedeemAmount,
        address _receiveToken,
        uint256 _receiveAmount,
        uint256 _maxReceiveAmountDeviation
    ) external override returns(uint256) {}


}
