/*
    Copyright 2021 Index Cooperative.

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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
// KeeperCompatible.sol imports the functions from both ./KeeperBase.sol and
// ./interfaces/KeeperCompatibleInterface.sol
import "@chainlink/contracts/src/v0.7/KeeperCompatible.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title RebalanceKeeper
 * @author Index Cooperative
 * 
 * Chainlink Keeper which automatically rebalances SetTokens.
 */
contract RebalanceKeeper is Ownable, KeeperCompatibleInterface {
    using Address for address;

    /* ============ State Variables ============ */
    bool internal paused;

    /* ============ Constructor ============ */

    address internal extension;

    /**
     * @param extension         The adapter address
     */
    constructor(address _extension) public {
        paused = true;
        extension = _extension;
    }    

    function checkUpkeep(bytes calldata /* checkData */) external override returns (bool upkeepNeeded, bytes memory /* performData */) {
        if (isPaused()) {
            return (false,);
        }
        bytes memory shouldRebalanceCalldata = abi.encodeWithSignature("shouldRebalance()", []);
        (string[] memory exchangeNames, int[] memory shouldRebalance) = extension.functionCallWithValue(shouldRebelanceCalldata, 0);
    }

    function performUpkeep(bytes calldata performData) external override {
        if (isPaused()) {
            return;
        }
        extension.functionCallWithValue(performData, 0);
    }

    function pause() onlyOwner {
        paused = true;
    }

    function unpause() onlyOwner {
        paused = false;
    }

    function isPaused() onlyOwner returns (bool paused) {
        return paused;
    }
}