/*
    Copyright 2024 Index Coop

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

import { ISetToken } from "./ISetToken.sol";

interface INAVIssuanceModule {
    function issue(
        ISetToken _setToken,
        address _reserveAsset,
        uint256 _reserveAssetQuantity,
        uint256 _minSetTokenReceiveQuantity,
        address _to
    ) external;
    
    function redeem(
        ISetToken _setToken,
        address _reserveAsset,
        uint256 _setTokenQuantity,
        uint256 _minReserveReceiveQuantity,
        address _to
    ) external;

    function isReserveAsset(
        ISetToken _setToken,
        address _asset
    ) external view returns(bool);

    function getReserveAssets(address _setToken) external view returns (address[] memory);

    function getExpectedSetTokenIssueQuantity(
        ISetToken _setToken,
        address _reserveAsset,
        uint256 _reserveAssetQuantity
    ) external view returns (uint256);

    function getExpectedReserveRedeemQuantity(
        ISetToken _setToken,
        address _reserveAsset,
        uint256 _setTokenQuantity
    ) external view returns (uint256);
}
