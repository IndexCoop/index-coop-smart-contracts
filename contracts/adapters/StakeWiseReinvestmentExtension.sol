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

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { ITradeModule } from "../interfaces/ITradeModule.sol";

/**
 * @title StakeWiseReinvestmentExtension
 * @author FlattestWhite
 * 
 * Smart contract that enables reinvesting the accrued rETH2 into a SetToken into sETH2.
 */
contract StakeWiseReinvestmentExtension is BaseExtension {
    
    using Address for address;
    using SafeCast for int256;

    /* ============ Constants ============= */

    address public constant S_ETH2 = 0xFe2e637202056d30016725477c5da089Ab0A043A;
    address public constant R_ETH2 = 0x20BC832ca081b91433ff6c17f85701B6e92486c5;

    /* ========== Structs ================= */

    struct ExecutionSettings {
        string exchangeName;
        string exchangeCallData;
    }

    /* ========== State Variables ========= */

    ISetToken public immutable setToken;                // The set token 
    IAirdropModule public immutable airdropModule;      // The airdrop module
    ITradeModule public immutable tradeModule;          // The trade module
    ExecutionSettings public settings;         // The execution settings

    /* ============  Constructor ============ */ 
    /**
     * Sets state variables
     * 
     * @param _manager Manager contract
     * @param _airdropModule Airdrop module contract
     * @param _tradeModule Trade module contract
     * @param _settings Reinvestment settings
     */
    constructor(
        IBaseManager _manager,
        IAirdropModule _airdropModule,
        ITradeModule _tradeModule,
        ExecutionSettings memory _settings
    ) public BaseExtension(_manager) {
        setToken = _manager.setToken();
        airdropModule = _airdropModule;
        tradeModule = _tradeModule;
        settings = _settings;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY ALLOWED CALLER:
     * 
     */
    function reinvest() external onlyAllowedCaller(msg.sender) {
        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            setToken,
            R_ETH2 
        );
        invokeManager(address(airdropModule), absorbCallData);

        uint256 rEthUnits = uint256(setToken.getTotalComponentRealUnits(R_ETH2));
        bytes memory tradeCallData = abi.encodeWithSelector(
            ITradeModule.trade.selector,
            settings.exchangeName,
            R_ETH2,
            rEthUnits,
            S_ETH2,
            rEthUnits, // Assume 1:1 exchange
            settings.exchangeCallData
        );
        invokeManager(address(tradeModule), tradeCallData);
    }

    function updateExecutionSettings(ExecutionSettings memory _settings) external onlyAllowedCaller(msg.sender) {
        settings = _settings;
    }
}
