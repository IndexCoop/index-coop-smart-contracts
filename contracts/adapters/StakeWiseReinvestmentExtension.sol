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
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

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
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;

    /* ============ Structs ============ */

    struct Settings {
        string exchangeName;
        address sETH2;
        address rETH2;
        bytes exchangeCallData;
    }

    /* ========== State Variables ========= */

    ISetToken public immutable setToken;                // The set token 
    IAirdropModule public immutable airdropModule;      // The airdrop module
    ITradeModule public immutable tradeModule;          // The trade module
    Settings internal settings;                         // The reinvestment settings

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
        Settings _settings
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
     * Passes in a _minReceivedQuantity. Typically, this value is calculated by getting an expected amount
     * from the supplied exchange.
     */
    function reinvest(uint256 _minReceiveQuantity) external onlyAllowedCaller(msg.sender) {
        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            setToken,
            settings.rETH2
        );
        invokeManager(airdropModule, absorbCallData);

        bytes memory tradeCallData = abi.encodeWithSelector(
            ITradeModule.trade.selector,
            settings.exchangeName,
            settings.rETH2,
            setToken.getTotalComponentRealUnits(settings.rETH2),
            settings.sETH2,
            _minReceiveQuantity,
            settings.exchangeCallData
        );
        invokeManager(tradeModule, tradeCallData);
    }

    function updateSettings(Settings _settings) external onlyAllowedCaller(msg.sender) {
        settings = _settings;
    }
}
