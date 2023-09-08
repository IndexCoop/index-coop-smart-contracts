/*
    Copyright 2022 Set Labs Inc.

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
pragma experimental "ABIEncoderV2";

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ISetToken } from "../interfaces/ISetToken.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";

/**
 * @title GlobalStreamingFeeSplitExtension
 * @author Set Protocol
 *
 * Smart contract global extension which provides DelegatedManager owner and methodologist the ability to accrue and split
 * streaming fees. Owner may configure the fee split percentages.
 *
 * Notes
 * - the fee split is set on the Delegated Manager contract
 * - when fees distributed via this contract will be inclusive of all fee types
 */
contract GlobalStreamingFeeSplitExtension is BaseGlobalExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Events ============ */

    event StreamingFeeSplitExtensionInitialized(
        address indexed _setToken,
        address indexed _delegatedManager
    );

    event FeesDistributed(
        address _setToken,
        address indexed _ownerFeeRecipient,
        address indexed _methodologist,
        uint256 _ownerTake,
        uint256 _methodologistTake
    );

    /* ============ State Variables ============ */

    // Instance of StreamingFeeModule
    IStreamingFeeModule public immutable streamingFeeModule;

    /* ============ Constructor ============ */

    constructor(
        IManagerCore _managerCore,
        IStreamingFeeModule _streamingFeeModule
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        streamingFeeModule = _streamingFeeModule;
    }

    /* ============ External Functions ============ */

    /**
     * ANYONE CALLABLE: Accrues fees from streaming fee module. Gets resulting balance after fee accrual, calculates fees for
     * owner and methodologist, and sends to owner fee recipient and methodologist respectively.
     */
    function accrueFeesAndDistribute(ISetToken _setToken) public {
        // Emits a FeeActualized event
        streamingFeeModule.accrueFee(_setToken);

        IDelegatedManager delegatedManager = _manager(_setToken);

        uint256 totalFees = _setToken.balanceOf(address(delegatedManager));

        address methodologist = delegatedManager.methodologist();
        address ownerFeeRecipient = delegatedManager.ownerFeeRecipient();

        uint256 ownerTake = totalFees.preciseMul(delegatedManager.ownerFeeSplit());
        uint256 methodologistTake = totalFees.sub(ownerTake);

        if (ownerTake > 0) {
            delegatedManager.transferTokens(address(_setToken), ownerFeeRecipient, ownerTake);
        }

        if (methodologistTake > 0) {
            delegatedManager.transferTokens(address(_setToken), methodologist, methodologistTake);
        }

        emit FeesDistributed(address(_setToken), ownerFeeRecipient, methodologist, ownerTake, methodologistTake);
    }

    /**
     * ONLY OWNER: Initializes StreamingFeeModule on the SetToken associated with the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the StreamingFeeModule for
     * @param _settings             FeeState struct defining fee parameters for StreamingFeeModule initialization
     */
    function initializeModule(
        IDelegatedManager _delegatedManager,
        IStreamingFeeModule.FeeState memory _settings
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        require(_delegatedManager.isInitializedExtension(address(this)), "Extension must be initialized");

        _initializeModule(_delegatedManager.setToken(), _delegatedManager, _settings);
    }

    /**
     * ONLY OWNER: Initializes StreamingFeeSplitExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);

        emit StreamingFeeSplitExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes StreamingFeeSplitExtension to the DelegatedManager and StreamingFeeModule to the SetToken
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     * @param _settings             FeeState struct defining fee parameters for StreamingFeeModule initialization
     */
    function initializeModuleAndExtension(
        IDelegatedManager _delegatedManager,
        IStreamingFeeModule.FeeState memory _settings
    )
        external
        onlyOwnerAndValidManager(_delegatedManager)
    {
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");

        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);
        _initializeModule(setToken, _delegatedManager, _settings);

        emit StreamingFeeSplitExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the StreamingFeeSplitExtension
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        _removeExtension(setToken, delegatedManager);
    }

    /**
     * ONLY OWNER: Updates streaming fee on StreamingFeeModule.
     *
     * NOTE: This will accrue streaming fees though not send to owner fee recipient and methodologist.
     *
     * @param _setToken     Instance of the SetToken to update streaming fee for
     * @param _newFee       Percent of Set accruing to fee extension annually (1% = 1e16, 100% = 1e18)
     */
    function updateStreamingFee(ISetToken _setToken, uint256 _newFee)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateStreamingFee(address,uint256)", _setToken, _newFee);
        _invokeManager(_manager(_setToken), address(streamingFeeModule), callData);
    }

    /**
     * ONLY OWNER: Updates fee recipient on StreamingFeeModule
     *
     * @param _setToken         Instance of the SetToken to update fee recipient for
     * @param _newFeeRecipient  Address of new fee recipient. This should be the address of the DelegatedManager
     */
    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient)
        external
        onlyOwner(_setToken)
    {
        bytes memory callData = abi.encodeWithSignature("updateFeeRecipient(address,address)", _setToken, _newFeeRecipient);
        _invokeManager(_manager(_setToken), address(streamingFeeModule), callData);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to initialize StreamingFeeModule on the SetToken associated with the DelegatedManager.
     *
     * @param _setToken                     Instance of the SetToken corresponding to the DelegatedManager
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the TradeModule for
     * @param _settings             FeeState struct defining fee parameters for StreamingFeeModule initialization
     */
    function _initializeModule(
        ISetToken _setToken,
        IDelegatedManager _delegatedManager,
        IStreamingFeeModule.FeeState memory _settings
    )
        internal
    {
        bytes memory callData = abi.encodeWithSignature(
            "initialize(address,(address,uint256,uint256,uint256))",
            _setToken,
            _settings);
        _invokeManager(_delegatedManager, address(streamingFeeModule), callData);
    }
}
