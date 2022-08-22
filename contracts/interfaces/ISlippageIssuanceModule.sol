/*
    Copyright 2020 Set Labs Inc.
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
pragma solidity >=0.6.10;

import { IDebtIssuanceModule, ISetToken } from "./IDebtIssuanceModule.sol";

interface ISlippageIssuanceModule is IDebtIssuanceModule {

    function issueWithSlippage(
        ISetToken _setToken,
        uint256 _setQuantity,
        address[] memory _checkedComponents,
        uint256[] memory _maxTokenAmountsIn,
        address _to
    ) external;

    function redeemWithSlippage(
        ISetToken _setToken,
        uint256 _setQuantity,
        address[] memory _checkedComponents,
        uint256[] memory _minTokenAmountsOut,
        address _to
    ) external;

    function getRequiredComponentIssuanceUnitsOffChain(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        returns (address[] memory, uint256[] memory, uint256[] memory);

    function getRequiredComponentRedemptionUnitsOffChain(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        returns (address[] memory, uint256[] memory, uint256[] memory);
}