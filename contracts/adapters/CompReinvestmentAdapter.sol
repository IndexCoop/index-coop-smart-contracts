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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { BaseAdapter } from "../lib/BaseAdapter.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title CompReinvestmentAdapter
 * @author bronco.eth
 *
 * When SetToken is receiving Comp tokens as rewards from the Compound protocol,
 * this adapter is enabling claiming and using accumulated Comp to increase the collateral position.
 * Paired with the CompoundLeverageModule from Set protocol this contract can be used
 * as long as the collateral asset is available on Compound.
 *
 * Flow:
 *   claim COMP via ClaimAdapter
 *   absorb COMP via AirdropModule
 *   trade COMP for collateral asset via TradeModule
 *   wrap in cToken via WrapModule
 * 
 * Implementation spec: https://docs.google.com/document/d/1_ZAj50JaimkvoOUGfOb60o2hTKLigsnTC_JknOqTdVk/edit#
 */
contract CompReinvestmentAdapter is BaseAdapter {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Structs ============ */

    struct ModuleSettings {
        address claimModule;
        string claimAdapterName; // CompClaimAdapter
        address airdropModule;
        address wrapModule;
        string wrapAdapterName;  // CompWrapAdapter?
        address tradeModule;
        string exchangeAdapterName;
        bytes exchangeData;
    }

    /* ============ Events ============ */

    event CompReaped(
        uint256 _claimedCompAmount,
        uint256 _absorbedCompAmount,
        address _caller
    );

    event ExchangeNameUpdated(
        string _oldExchangeName,
        string _newExchangeName
    );

    event ExchangeDataUpdated(
        bytes _oldExchangeData,
        bytes _newExchangeData
    );

    /* ============ State Variables ============ */

    ISetToken internal setToken;

    address internal collateralAsset; // would it make sense to get it from CompoundLeverageModule.getEnabledAssets()[1] or .find?
    address internal collateralCToken; // would it make sense to get it from CompoundLeverageModule.underlyingToCToken(collateralAsset)?
    address internal comptroller;
    address internal compToken; // Potentially can get it from the comptroller

    ModuleSettings internal moduleSettings;

    address public weth; // isn't this optional, only when we are using ETH collaterialized position?

    /* ============ Constructor ============ */

    /**
     * Instantiate state of the reinvestment adapter
     * 
     * @param _manager                  Address of IBaseManager contract, owner of the FLI contract
     * @param _setToken                 Address of the set token contract
     * @param _collateralAsset          Address of the collateral asset
     * @param _collateralCToken         Address of compound wrapped token of the collateral asset
     * @param _comptroller              Address of the comptroller proxy contract
     * @param _compToken                Address of the COMP token
     * @param _moduleSettings           Addresses of modules and names of adapters used in the reaping flow
     */

    constructor(
        IBaseManager _manager,
        ISetToken _setToken,
        address _collateralAsset,
        address _collateralCToken,
        address _comptroller,
        address _compToken,
        ModuleSettings memory _moduleSettings
    )
        public
        BaseAdapter(_manager)
    {
        setToken = _setToken;
        collateralAsset = _collateralAsset;
        collateralCToken = _collateralCToken;
        comptroller = _comptroller;
        compToken = _compToken;
        moduleSettings = _moduleSettings;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY EOA AND ALLOWED CALLER: Use accured COMP to increase collateral position in the flexible leverage token.
     */
     function reap() external onlyEOA {
        address caller = msg.sender;
        uint claimedCompUnits = _claim();
        uint absorbedCompUnits = _absorb();
        uint postTradeCollateralUnits = _trade(absorbedCompUnits);
        _wrap(postTradeCollateralUnits);

        emit CompReaped(
            claimedCompUnits,
            absorbedCompUnits,
            caller
        );
    }

    function _claim() internal returns(uint) {
        uint preClaimCompUnits = ERC20(compToken).balanceOf(address(setToken));
        bytes memory claimCallData = abi.encodeWithSignature("claim(address,address,string)", address(setToken), comptroller, moduleSettings.claimAdapterName);
        invokeManager(moduleSettings.claimModule, claimCallData);
        uint postClaimCompUnits = ERC20(compToken).balanceOf(address(setToken));

        return postClaimCompUnits - preClaimCompUnits;
    }

    function _absorb() internal returns(uint) {
        bytes memory absorbCallData = abi.encodeWithSignature("absorb(address,address)", address(setToken), compToken);
        invokeManager(moduleSettings.airdropModule, absorbCallData);

        // Get the amount of comp tokens sitting in the contract after the claim and absorb.
        return ERC20(compToken).balanceOf(address(setToken));
    }

    function _trade(uint preTradeCompUnits) internal returns(uint) {
        uint postTradeCollateralUnits;

        if (collateralAsset == compToken) { // In case our collateral is COMP, then we skip the trade
            postTradeCollateralUnits = preTradeCompUnits;
        } else { // Otherwise we convert it to the contract collateral
            // Trade
            bytes memory tradeCallData = abi.encodeWithSignature("trade(address,string,address,uint256,address,uint256,bytes)", address(setToken), moduleSettings.exchangeAdapterName, compToken, preTradeCompUnits, collateralAsset, 0, moduleSettings.exchangeData);
            invokeManager(moduleSettings.tradeModule, tradeCallData);
            postTradeCollateralUnits = ERC20(collateralCToken).balanceOf(address(setToken));
        }

        return postTradeCollateralUnits;
    }

    function _wrap(uint postTradeCollateralUnits) internal {
        bytes memory wrapCallData;

        if (collateralAsset == weth) {
            wrapCallData = abi.encodeWithSignature("wrapWithEther(address,address,uint256,string)", address(setToken), collateralCToken, postTradeCollateralUnits, moduleSettings.wrapAdapterName);
        } else {
            wrapCallData = abi.encodeWithSignature("wrap(address,address,address,uint256,string)", address(setToken), collateralCToken, collateralAsset, postTradeCollateralUnits, moduleSettings.wrapAdapterName);
        }

        invokeManager(moduleSettings.wrapModule, wrapCallData);
    }

    /**
     * OPERATOR ONLY: Set exchage used to swap COMP for collateral.
     *
     * @param _newExchangeAdapterName  String
     */
    function setExchangeAdapterName(string memory _newExchangeAdapterName) external onlyOperator {
        // Do we need a list of whitelisted exchanges?
        // eg: _validateExchange(exchangeAdapterName);

        string memory oldExchangeAdapterName = moduleSettings.exchangeAdapterName;
        moduleSettings.exchangeAdapterName = _newExchangeAdapterName;

        emit ExchangeNameUpdated(
            oldExchangeAdapterName,
            moduleSettings.exchangeAdapterName
        );
    }

    /**
     * OPERATOR ONLY: Set the exchange data if needed to sell COMP
     *
     * @param _newExchangeData  bytes
     */
    function setExchangeData(bytes memory _newExchangeData) external onlyOperator {
        // Do we need to validate input?
        // eg: require(exchangeName.length == 0, "Exchange data has to be non-empty");

        bytes memory oldExchangeData = moduleSettings.exchangeData;
        moduleSettings.exchangeData = _newExchangeData;

        emit ExchangeDataUpdated(
            oldExchangeData,
            moduleSettings.exchangeData
        );
    }

    function updateAirdropFeeRecipient(address _newFeeRecipient) external onlyOperator {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,address)", address(setToken), _newFeeRecipient);
        invokeManager(moduleSettings.airdropModule, callData);
    }

    function updateAirdropFee(uint256 _newAirdropFee) external onlyOperator {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,uint256)", address(setToken), _newAirdropFee);
        invokeManager(moduleSettings.airdropModule, callData);
    }
}
