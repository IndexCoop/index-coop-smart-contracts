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

import { IPrt } from "../interfaces/IPrt.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

contract PrtStakingPoolMock {
    ISetToken public immutable setToken;
    IPrt public immutable prt;
    address public feeSplitExtension;

    constructor(ISetToken _setToken, IPrt _prt, address _feeSplitExtension) public {
        prt = _prt;
        setToken = _setToken;
        feeSplitExtension = _feeSplitExtension;
    }

    function accrue(uint256 _amount) external {
        setToken.transferFrom(msg.sender, address(this), _amount);
    }
}
