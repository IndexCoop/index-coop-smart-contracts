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
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
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
        // Name of the exchange adapter stored in the IntegrationRegistry. Typically the name of the contract
        // such as UniswapV3ExchangeAdapterV2.
        string exchangeName;
        // The callData that needs to be passed along to the exchange adapter. This is usually generated with
        // a external view call on the adapter contract using the function generateDataParam.
        bytes exchangeCallData;
    }

    /* ========== State Variables ========= */

    ISetToken public immutable setToken;
    IAirdropModule public immutable airdropModule;
    ITradeModule public immutable tradeModule;
    ExecutionSettings public settings;

    /* ============  Constructor ============ */ 
    /**
     * Sets state variables
     * 
     * @param _manager // The manager contract. Used to invoke calls on the underlying SetToken.
     * @param _airdropModule // The airdropModule contract. Used to absorb tokens into the SetToken so that it's part of SetToken's accounting.
     * @param _tradeModule // The tradeModule contract. Used to trade the absorbed rETH2 into sETH2.
     * @param _settings // Determines which exchange adapter is used to execute the trade through the TradeModule contract.
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
     * Initializes the extension by:
     * 1. Calling initialize on the AirdropModule for the SetToken with required airdrop settings.
     * 2. Initializing the TradeModule for the SetToken to allow trading trading with the SetToken.
     */
    function initialize() external onlyOperator {
        address[] memory tokens = new address[](1);
        tokens[0] = R_ETH2;
        IAirdropModule.AirdropSettings memory airdropSettings = IAirdropModule.AirdropSettings ({
            airdrops: tokens,
            feeRecipient: address(setToken),
            airdropFee: 0,
            anyoneAbsorb: false
        });
        bytes memory airdropModuleData = abi.encodeWithSelector(airdropModule.initialize.selector, setToken, airdropSettings);
        invokeManager(address(airdropModule), airdropModuleData);

        bytes memory tradeModuleData = abi.encodeWithSelector(tradeModule.initialize.selector, setToken);
        invokeManager(address(tradeModule), tradeModuleData);
    }

    /**
     * 
     * 1. Absorbs rETH2 into the SetToken
     * 2. Trades rETH2 into sETH2 with _minReceivedQuantity
     * 
     * We considered removing the _minReceivedQuantity parameter and storing the slippage parameter as part of
     * ExecutionSettings. However, in the event of a black swan event where rETH2 de-pegs, we'd need to updateExecutionSettings
     * which would involve a multi-sig txn. Once rETH2 can be redeemed for sETH2 directly, the exchange rate is guaranteed to be at least 1:1.
     * Therefore, _minReceiveQuantity can be removed and this function can be made public.
     */
    function reinvest(uint256 _minReceiveQuantity) external onlyAllowedCaller(msg.sender) {
        bytes memory absorbCallData = abi.encodeWithSelector(
            IAirdropModule.absorb.selector,
            setToken,
            R_ETH2 
        );
        invokeManager(address(airdropModule), absorbCallData);

        uint256 rEthUnits = uint256(setToken.getTotalComponentRealUnits(R_ETH2));
        require(rEthUnits > 0, "rETH2 units must be greater than zero");
        bytes memory tradeCallData = abi.encodeWithSelector(
            ITradeModule.trade.selector,
            setToken,
            settings.exchangeName,
            R_ETH2,
            rEthUnits,
            S_ETH2,
            _minReceiveQuantity,
            settings.exchangeCallData
        );
        invokeManager(address(tradeModule), tradeCallData);
    }

    function updateExecutionSettings(ExecutionSettings memory _settings) external onlyAllowedCaller(msg.sender) {
        settings = _settings;
    }
}
