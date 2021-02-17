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
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ISetToken } from "../interfaces/ISetToken.sol";


/**
 * @title FLIIssuanceHook
 * @author Set Protocol
 *
 * Issuance hook for FLI product that allows IndexCoop to set limit on amount of Sets that can be minted.
 */
contract FLIIssuanceHook is Ownable {
    using SafeMath for uint256;

    /* ============ Events ============ */

    event SupplyCapUpdated(uint256 _newCap);
    
    /* ============ State Variables ============ */

    // Cap on totalSupply of FLI Sets
    uint256 public fliSupplyCap;

    constructor(uint256 _supplyCap) public { fliSupplyCap = _supplyCap; }

    function invokePreIssueHook(
        ISetToken _setToken,
        uint256 _issueQuantity,
        address /*_sender*/,
        address /*_to*/
    )
        external
        view
    {
        uint256 totalSupply = _setToken.totalSupply();

        require(totalSupply.add(_issueQuantity) <= fliSupplyCap, "Supply cap exceeded");
    }

    function updateSupplyCap(uint256 _newCap) external onlyOwner {
        fliSupplyCap = _newCap;
    }
}