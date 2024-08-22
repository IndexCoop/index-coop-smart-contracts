/*
    Copyright 2024 Index Coop

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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IController } from "../../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../../interfaces/IDebtIssuanceModule.sol";
import { IModuleIssuanceHook } from "../../../interfaces/IModuleIssuanceHook.sol";
import { INAVIssuanceHook } from "../../../interfaces/INAVIssuanceHook.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { ModuleBase } from "../../lib/ModuleBase.sol";

/**
 * @title RebasingComponentModule
 * @author Index Coop
 * @notice Module for syncing rebasing components before issuance and redemption via DebtIssuanceModule and NAVIssuanceModule.
 */
contract RebasingComponentModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook, INAVIssuanceHook {

    /* ============ Events ============ */

    /**
     * @dev Emitted when rebasing components are added or removed.
     * @param _setToken       Instance of SetToken whose rebasing components are updated.
     * @param _isAdded        True if components are added, false if removed.
     * @param _components     Array of rebasing components being added/removed.
     */
    event RebasingComponentsUpdated(
        ISetToken indexed _setToken,
        bool indexed _isAdded,
        IERC20[] _components
    );

    /* ============ State Variables ============ */

    // Mapping to efficiently check if rebasing component is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public rebasingComponentEnabled;

    // Internal mapping of enabled rebasing components for syncing positions
    mapping(ISetToken => address[]) internal rebasingComponents;

    /* ============ Constructor ============ */

    /**
     * @dev Initializes the module with the controller address.
     * @param _controller  Address of the controller contract.
     */
    constructor(IController _controller) public ModuleBase(_controller) { }

    /* ============ External Functions ============ */

    /**
     * @dev CALLABLE BY ANYBODY: Sync Set positions with ALL enabled rebasing component positions.
     * @param _setToken    Instance of the SetToken
     */
    function sync(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
        uint256 setTotalSupply = _setToken.totalSupply();

        // Only sync positions when Set supply is not 0. Without this check, if sync is called by someone before the
        // first issuance, then editDefaultPosition would remove the default positions from the SetToken
        if (setTotalSupply > 0) {
            address[] memory setTokenRebasingComponents = rebasingComponents[_setToken];
            for (uint256 i = 0; i < setTokenRebasingComponents.length; i++) {
                IERC20 component = IERC20(setTokenRebasingComponents[i]);

                uint256 previousPositionUnit = _setToken.getDefaultPositionRealUnit(address(component)).toUint256();
                uint256 newPositionUnit = component.balanceOf(address(_setToken)).preciseDiv(setTotalSupply);

                // Note: Accounts for if position does not exist on SetToken but is tracked in rebasingComponents
                if (previousPositionUnit != newPositionUnit) {
                    _setToken.editDefaultPosition(address(component), newPositionUnit);
                }
            }
        }
    }

    /**
     * @dev MANAGER ONLY: Initializes this module to the SetToken. Only callable by the SetToken's manager.
     * Note: Managers can enable rebasing components that don't exist as positions on the SetToken
     * @param _setToken             Instance of the SetToken to initialize
     * @param _rebasingComponents   Rebasing components to be enabled in the SetToken
     */
    function initialize(
        ISetToken _setToken,
        IERC20[] memory _rebasingComponents
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        // Initialize module before trying register
        _setToken.initializeModule();

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).registerToIssuanceModule(_setToken) {} catch {}
        }

        _addRebasingComponents(_setToken, _rebasingComponents);
    }

    /**
     * @dev MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken.
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        // Sync Aave and SetToken positions prior to any removal action
        sync(setToken);

        address[] memory components = rebasingComponents[setToken];
        for(uint256 i = 0; i < components.length; i++) {
            IERC20 component = IERC20(components[i]);
            delete rebasingComponentEnabled[setToken][component];
        }
        delete rebasingComponents[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
        }
    }

    /**
     * @dev MANAGER ONLY: Add registration of this module on the debt issuance module for the SetToken.
     * Note: if the debt issuance module is not added to SetToken before this module is initialized, then this function
     * needs to be called if the debt issuance module is later added and initialized to prevent state inconsistencies
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(address(_debtIssuanceModule)), "Issuance not initialized");

        _debtIssuanceModule.registerToIssuanceModule(_setToken);
    }

    /**
     * @dev MANAGER ONLY: Add rebasing components. Rebasing components are tracked for syncing positions.
     *
     * NOTE: ALL ADDED REBASING COMPONENTS CAN BE ADDED AS A POSITION ON THE SET TOKEN WITHOUT MANAGER'S EXPLICIT PERMISSION.
     * UNWANTED EXTRA POSITIONS CAN BREAK EXTERNAL LOGIC, INCREASE COST OF MINT/REDEEM OF SET TOKEN, AMONG OTHER POTENTIAL UNINTENDED CONSEQUENCES.
     * SO, PLEASE ADD ONLY THOSE REBASING COMPONENTS WHOSE CORRESPONDING POSITIONS ARE NEEDED AS DEFAULT POSITIONS ON THE SET TOKEN.
     *
     * @param _setToken               Instance of the SetToken
     * @param _newRebasingComponents  Addresses of new rebasing components
     */
    function addRebasingComponents(ISetToken _setToken, IERC20[] memory _newRebasingComponents) external onlyManagerAndValidSet(_setToken) {
        _addRebasingComponents(_setToken, _newRebasingComponents);
    }

    /**
     * @dev MANAGER ONLY: Remove rebasing components.
     * @param _setToken              Instance of the SetToken
     * @param _rebasingComponents    Addresses of rebasing components to remove
     */
    function removeRebasingComponents(ISetToken _setToken, IERC20[] memory _rebasingComponents) external onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _rebasingComponents.length; i++) {
            IERC20 component = _rebasingComponents[i];
            require(rebasingComponentEnabled[_setToken][component], "Rebasing component not enabled");

            delete rebasingComponentEnabled[_setToken][component];
            rebasingComponents[_setToken].removeStorage(address(component));
        }
        emit RebasingComponentsUpdated(_setToken, false, _rebasingComponents);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to debt issuance module issuance to sync rebasing components position on SetToken.
     * @param _setToken    Instance of the SetToken
     */
    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external override onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to debt issuance module redemption to sync rebasing components position on SetToken.
     * @param _setToken    Instance of the SetToken
     */
    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external override onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on issuance. Only callable by valid module.
     */
    function componentIssueHook(ISetToken _setToken, uint256 /* _setTokenQuantity */, IERC20 /* _component */, bool /* _isEquity */) external override onlyModule(_setToken) { }

    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on redemption. Only callable by valid module.
     */
    function componentRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */, IERC20 /* _component */, bool /* _isEquity */) external override onlyModule(_setToken) { }

    /**
     * @dev MODULE ONLY: Hook called prior to NAV issuance to sync rebasing components position on SetToken.
     * @param _setToken               Instance of the SetToken
     */
    function invokePreIssueHook(
        ISetToken _setToken,
        address /* _reserveAsset */,
        uint256 /* _reserveAssetQuantity */,
        address /* _sender */,
        address /* _to */
    )
        external
        override
        onlyModule(_setToken)
    {
        sync(_setToken);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to NAV redemption.
     * @param _setToken         Instance of the SetToken
     */
    function invokePreRedeemHook(
        ISetToken _setToken,
        uint256 /* _redeemQuantity */,
        address /* _sender */,
        address /* _to */
    )
        external
        override
        onlyModule(_setToken)
    {
        sync(_setToken);
    }

    /* ============ External Getter Functions ============ */

    /**
     * @dev Get rebasing components for SetToken. Returns an array of rebasing components.
     * @return Rebasing components that are enabled
     */
    function getRebasingComponents(ISetToken _setToken) external view returns(address[] memory) {
        return rebasingComponents[_setToken];
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Add rebasing components to SetToken. Updates the rebasingComponentsEnabled and rebasingComponents mappings.
     * Emits RebasingComponentUpdated event.
     */
    function _addRebasingComponents(ISetToken _setToken, IERC20[] memory _newRebasingComponents) internal {
        for(uint256 i = 0; i < _newRebasingComponents.length; i++) {
            IERC20 component = _newRebasingComponents[i];

            require(!rebasingComponentEnabled[_setToken][component], "Rebasing component already enabled");

            rebasingComponentEnabled[_setToken][component] = true;
            rebasingComponents[_setToken].push(address(component));
        }
        emit RebasingComponentsUpdated(_setToken, true, _newRebasingComponents);
    }
}
