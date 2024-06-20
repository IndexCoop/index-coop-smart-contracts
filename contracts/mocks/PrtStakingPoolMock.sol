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

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity ^0.6.10;
pragma experimental ABIEncoderV2;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PrtStakingPoolMock {
    IERC20 public immutable rewardToken;
    IERC20 public immutable stakeToken;
    address public distributor;

    constructor(IERC20 _rewardToken, IERC20 _stakeToken, address _distributor) public {
        rewardToken = _rewardToken;
        stakeToken = _stakeToken;
        distributor = _distributor;
    }

    function accrue(uint256 _amount) external {
        rewardToken.transferFrom(msg.sender, address(this), _amount);
    }
}
