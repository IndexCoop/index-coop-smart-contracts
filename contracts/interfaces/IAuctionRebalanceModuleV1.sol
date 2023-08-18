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
pragma experimental "ABIEncoderV2";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISetToken } from "./ISetToken.sol";

interface IAuctionRebalanceModuleV1 {
    
    struct AuctionExecutionParams {
        uint256 targetUnit;
        string priceAdapterName;
        bytes priceAdapterConfigData;
    }

    function startRebalance(
        ISetToken _setToken,
        IERC20 _quoteAsset,
        address[] calldata _newComponents,
        AuctionExecutionParams[] memory _newComponentsAuctionParams,
        AuctionExecutionParams[] memory _oldComponentsAuctionParams,
        bool _shouldLockSetToken,
        uint256 _rebalanceDuration,
        uint256 _initialPositionMultiplier
    ) external;

    function bid(
        ISetToken _setToken,
        IERC20 _component,
        uint256 _componentAmount,
        uint256 _quoteAssetLimit
    ) external;

    function raiseAssetTargets(ISetToken _setToken) external;

    function unlock(ISetToken _setToken) external;

    function setRaiseTargetPercentage(
        ISetToken _setToken, 
        uint256 _raiseTargetPercentage
    ) external;

    function setBidderStatus(
        ISetToken _setToken,
        address[] memory _bidders,
        bool[] memory _statuses
    ) external;

    function setAnyoneBid(ISetToken _setToken, bool _status) external;
    
    function initialize(ISetToken _setToken) external;
}
