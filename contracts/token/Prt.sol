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

pragma solidity 0.6.10;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Prt
 * @author Index Cooperative
 * @notice Standard ERC20 token with a fixed supply allocated to a distributor. Associated with a SetToken.
 */
contract Prt is ERC20 {
    /// @notice Address of the SetToken associated with this Prt token.
    address public immutable setToken;
    
    /**
     * @notice Constructor for the Prt token.
     * @dev Mints the total supply of tokens and assigns them to the distributor.
     * @param _name The name of the Prt token.
     * @param _symbol The symbol of the Prt token.
     * @param _setToken The address of the SetToken associated with this Prt token.
     * @param _distributor The address that will receive and distribute the total supply of Prt tokens.
     * @param _totalSupply The total supply of Prt tokens to be minted and distributed.
     */
    constructor(
        string memory _name,
        string memory _symbol,
        address _setToken,
        address _distributor,
        uint256 _totalSupply
    ) public
        ERC20(_name, _symbol)
    {
        setToken = _setToken;
        _mint(_distributor, _totalSupply);
    }
}
