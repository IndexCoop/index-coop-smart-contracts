/*
    Copyright 2022 Index Cooperative.

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
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { KeeperCompatibleInterface } from "@chainlink/contracts/src/v0.6/KeeperCompatible.sol";
import { IFlexibleLeverageStrategyExtension } from "../interfaces/IFlexibleLeverageStrategyExtension.sol";

/**
 * @title RebalanceKeeper
 * @author Index Cooperative
 * 
 * Chainlink Keeper which automatically rebalances FLI SetTokens.
 */
contract FliRebalanceKeeper is Ownable, KeeperCompatibleInterface {

    using Address for address;

    /* ============ Structs ============ */

    struct LeverageSettings {
        uint256 customMinLeverageRatio;                             // The minimum leverage ratio
        uint256 customMaxLeverageRatio;                             // The maximum leverage ratio
    }

    /* ============ Modifiers ============ */

    modifier onlyRegistry() {
        require(msg.sender == registryAddress, "Only registry address can call this function");
        _;
    }

    /* ============ State Variables ============ */

    IFlexibleLeverageStrategyExtension public fliExtension;         // Address of the fli extension contract
    address public registryAddress;                                 // Address of the chainlink keeper registry
    uint256 public exchangeIndex;                                   // The index of the exchange to use
    LeverageSettings public leverageSettings;                       // The leverage settings to check whether should rebalance

    /* ============ Constructor ============ */

    constructor(
        IFlexibleLeverageStrategyExtension _fliExtension,
        address _registryAddress,
        uint256 _exchangeIndex,
        LeverageSettings memory _leverageSettings
    ) public {
        fliExtension = _fliExtension;
        registryAddress = _registryAddress;
        exchangeIndex = _exchangeIndex;
        leverageSettings = _leverageSettings;
    }    

    /**
     * As checkUpkeep is not a view function, calling this function will actually consume gas.
     * As such if a keeper calls this function, it will always return true so that performUpkeep will be called.
     */    
    function checkUpkeep(bytes calldata /* checkData */) external override returns (bool, bytes memory) {
        (string[] memory exchangeNames, IFlexibleLeverageStrategyExtension.ShouldRebalance[] memory shouldRebalances) = fliExtension.shouldRebalanceWithBounds(
            leverageSettings.customMinLeverageRatio,
            leverageSettings.customMaxLeverageRatio
        );
        IFlexibleLeverageStrategyExtension.ShouldRebalance shouldRebalance = shouldRebalances[exchangeIndex];
        bytes memory performData = abi.encode(shouldRebalance, exchangeNames[exchangeIndex]);
        return (shouldRebalance != IFlexibleLeverageStrategyExtension.ShouldRebalance.NONE, performData);
    }

    /**
     * performUpkeep checks that a rebalance is required. Otherwise the contract call will revert.
     */
    function performUpkeep(bytes calldata performData) external override onlyRegistry {
        require(performData.length > 0, "Invalid performData");
        (IFlexibleLeverageStrategyExtension.ShouldRebalance shouldRebalance, string memory exchangeName) = abi.decode(
            performData,
            (IFlexibleLeverageStrategyExtension.ShouldRebalance, string)
        );
        if (shouldRebalance == IFlexibleLeverageStrategyExtension.ShouldRebalance.REBALANCE) {
            fliExtension.rebalance(exchangeName);
            return;
        } else if (shouldRebalance == IFlexibleLeverageStrategyExtension.ShouldRebalance.ITERATE_REBALANCE) {
            fliExtension.iterateRebalance(exchangeName);
            return;
        } else if (shouldRebalance == IFlexibleLeverageStrategyExtension.ShouldRebalance.RIPCORD) {
            fliExtension.ripcord(exchangeName);
            return;
        }
        revert("FliRebalanceKeeper: invalid shouldRebalance or no rebalance required");
    }
    function setExchangeIndex(uint256 _exchangeIndex) external onlyOwner {
        exchangeIndex = _exchangeIndex;
    }

    function setLeverageSettings(LeverageSettings memory _leverageSettings) external onlyOwner {
        leverageSettings = _leverageSettings;
    }
}
