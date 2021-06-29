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
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BaseAdapter } from "../lib/BaseAdapter.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title COMPReinvestmentExtension
 * @author bronco.eth
 *
 * If a SetToken receives COMP tokens as rewards from depositing assets in the Compound protocol, this adapter enables claiming and trading 
 * accumulated COMP for a target collateral asset. If the the target cToken asset does not exist in Compound, this will fail.
 * 
 * Flow:
 *   claim COMP via ClaimAdapter
 *   absorb COMP via AirdropModule
 *   trade COMP for collateral asset via TradeModule
 *   wrap in cToken via WrapModule
 * 
 * Implementation spec: https://docs.google.com/document/d/1_ZAj50JaimkvoOUGfOb60o2hTKLigsnTC_JknOqTdVk/edit#
 */
contract COMPReinvestmentExtension is BaseAdapter {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeCast for int256;
    using SafeMath for uint256;

    /* ============ Structs ============ */

    struct ModuleSettings {
        address claimModule;        // Address of the Set V2 ClaimModule to claim COMP from the Comptroller
        string claimAdapterName;    // String used to identify the CompClaimAdapter in the IntegrationRegistry
        address airdropModule;      // Address of the Set V2 AirdropModule to absorb COMP into a position
        address wrapModule;         // Address of the Set V2 WrapModule to mint collateral cToken
        string wrapAdapterName;     // String used to identify the CompoundWrapAdapter in the IntegrationRegistry
        address tradeModule;        // Address of the Set V2 TradeModule to trade COMP for collateral cToken
        string exchangeAdapterName; // String used to identify the exchange adapter in the IntegrationRegistry
        bytes exchangeData;         // Arbitrary exchange data passed into trade() function to exchange COMP
    }

    /* ============ Events ============ */

    event COMPReaped(
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

    ISetToken public setToken;

    // Address of the target collateral underlying asset. Must match the underlying in the collateral cToken
    address public collateralAsset;
    // Address of the target collateral cToken to transform accumulated COMP into
    address public collateralCToken;
    // Address of the Compound Comptroller
    address public comptroller;
    // Address of the COMP token
    address public compToken;

    ModuleSettings public moduleSettings;

    address public cEther;

    /* ============ Constructor ============ */

    /**
     * Instantiate state of the reinvestment adapter
     * 
     * @param _manager                  Address of IBaseManager contract, owner of the FLI contract
     * @param _collateralAsset          Address of the collateral asset
     * @param _collateralCToken         Address of compound wrapped token of the collateral asset
     * @param _comptroller              Address of the comptroller proxy contract
     * @param _compToken                Address of the COMP token
     * @param _moduleSettings           Addresses of modules and names of adapters used in the reap flow
     */
    constructor(
        IBaseManager _manager,
        address _collateralAsset,
        address _collateralCToken,
        address _comptroller,
        address _compToken,
        address _cEther,
        ModuleSettings memory _moduleSettings
    )
        public
        BaseAdapter(_manager)
    {
        setToken = manager.setToken();
        collateralAsset = _collateralAsset;
        collateralCToken = _collateralCToken;
        cEther = _cEther;
        comptroller = _comptroller;
        compToken = _compToken;
        moduleSettings = _moduleSettings;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY EOA AND ALLOWED CALLER: Use accured COMP to increase collateral position in the flexible leverage token.
     */
     function reap() external onlyEOA {
        _claim();

        _absorb();

        _trade();

        _wrap();

        emit COMPReaped(msg.sender);
    }

    function _claim() internal {       
        bytes memory claimCallData = abi.encodeWithSignature(
            "claim(address,address,string)",
            address(setToken),
            comptroller,
            moduleSettings.claimAdapterName
        );
       
        invokeManager(moduleSettings.claimModule, claimCallData);
    }

    function _absorb() internal {
        bytes memory absorbCallData = abi.encodeWithSignature(
            "absorb(address,address)",
            address(setToken),
            compToken
        );

        invokeManager(moduleSettings.airdropModule, absorbCallData);
    }

    function _trade() internal {
        // Get default units for COMP in SetToken to pass into trade function
        uint256 compDefaultUnits = setToken.getDefaultPositionRealUnit(compToken).toUint256();

        // If collateral asset is not COMP and manager has not collected 100% of the airdrop, then continue executing trade
        if (collateralAsset != compToken && compDefaultUnits > 0) {
            bytes memory tradeCallData = abi.encodeWithSignature(
                "trade(address,string,address,uint256256,address,uint256256,bytes)",
                address(setToken),
                moduleSettings.exchangeAdapterName,
                compToken,
                compDefaultUnits,
                collateralAsset,
                0, // Set min receive amount to 0 as trades sizes are typically very small
                moduleSettings.exchangeData
            );
            invokeManager(moduleSettings.tradeModule, tradeCallData);
        }
    }

    function _wrap() internal {
        bytes memory wrapCallData;

        uint256 collateralDefaultUnits = setToken.getDefaultPositionRealUnit(collateralAsset).toUint256();

        if (collateralCToken == cEther) {
            wrapCallData = abi.encodeWithSignature(
                "wrapWithEther(address,address,uint256,string)",
                address(setToken),
                collateralCToken,
                collateralDefaultUnits,
                moduleSettings.wrapAdapterName
            );
        } else {
            wrapCallData = abi.encodeWithSignature(
                "wrap(address,address,address,uint256,string)",
                address(setToken),
                collateralCToken,
                collateralAsset,
                collateralDefaultUnits,
                moduleSettings.wrapAdapterName
            );
        }

        invokeManager(moduleSettings.wrapModule, wrapCallData);

        // Compound does not revert on errors, so we must ensure here that a mint was successful
        require(collateralDefaultUnits == 0, "Wrap failed on Compound");
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