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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { ITradeModule } from "../interfaces/ITradeModule.sol";

/**
 * @title StakeWiseReinvestmentExtension
 * @author FlattestWhite
 * 
 * 
 */
contract StakeWiseReinvestmentExtension is BaseExtension {

    ISetToken setToken;
    IAirdropModule airdropModule;
    ITradeModule tradeModule;

    constructor(
        IBaseManager _manager,
        IAirdropModule _airdropModule,
        ITradeModule _tradeModule
    ) public BaseExtension(_manager) {
        setToken = _manager.setToken();
        airdropModule = _airdropModule;
        tradeModule = _tradeModule;
    }

    function reinvest(address memory _exchangeName, uint256 _minReceiveQuantity) external onlyAllowedCaller(msg.sender) {
        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            setToken,
            "rETH2"
        );
        invokeManager(airdropModule, absorbCallData);

        bytes memory tradeCallData = abi.encodeWithSelector(
            ITradeModule.trade.selector,
            _exchangeName,
            "rETH2",
            setToken.getTotalComponentRealUnits("rETH2"),
            "sETH2",
            _minReceiveQuantity,
            "TODO: add trade callData"
        );
        invokeManager(tradeModule, tradeCallData);
    }
}
