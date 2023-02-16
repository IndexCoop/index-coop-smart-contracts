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

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// mock class using BasicToken
contract ERC4626Mock is ERC20 {
    address public underlying_asset;

    constructor(
        string memory _name,
        string memory _symbol,
        address _asset
    ) 
        public 
        ERC20(_name, _symbol)
    {
        underlying_asset = _asset;
    }

    function asset() external view returns (address assetTokenAddress) {
        return underlying_asset;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        uint256 shares = assets;
        
        IERC20(underlying_asset).transferFrom(receiver, address(this), assets);
        _mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        uint256 shares = assets;

        _burn(receiver, shares);
        IERC20(underlying_asset).transfer(receiver, assets);
    }
}
