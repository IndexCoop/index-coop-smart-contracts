/*
    Copyright 2021 Index Coop.

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

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

contract WrapTokenMock is ERC20 {
    using PreciseUnitMath for uint256;

    IERC20 public underlying;
    uint256 public exchangeRate;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        IERC20 _underlying,
        uint256 _exchangeRate
    )
        public
        ERC20(_name, _symbol)
    {
        underlying = _underlying;
        exchangeRate = _exchangeRate;
        _setupDecimals(_decimals);
    }

    function mint(uint256 _amount) external {
        underlying.transferFrom(msg.sender, address(this), _amount);
        _mint(msg.sender, _amount.preciseMul(exchangeRate));
    }

    function redeem(uint256 _amount) external {
        _burn(msg.sender, _amount);
        underlying.transfer(msg.sender, _amount.preciseDiv(exchangeRate));
    }
}
