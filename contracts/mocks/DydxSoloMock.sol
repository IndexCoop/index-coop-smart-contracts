/*
    Copyright 2021 Set Labs Inc.

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

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Account, Actions } from "../interfaces/ISoloMargin.sol";
import { ICallee } from "../interfaces/ICallee.sol";

contract DydxSoloMock {
    address public weth;
    bool public shouldOperate;
    ICallee public arbContract;

    constructor(address _weth) public {
        weth = _weth;
    }

    function setShouldOperate(bool _shouldOperate) external {
        shouldOperate = _shouldOperate;
    }

    function addArbContract(ICallee _arbContract) external {
        arbContract = _arbContract;
    }

    function getNumMarkets() external pure returns (uint256) {
        return 1;
    }

    function getMarketTokenAddress(uint256 _marketId) external view returns (address) {
        return weth;
    }
    
    function operate(
        Account.Info[] memory _accounts,
        Actions.ActionArgs[] memory _actions
    )
        external
    {
        if (shouldOperate) {
            arbContract.callFunction(msg.sender, _accounts[0], _actions[1].data);
        }
    }
}