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

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { IExtension } from "../interfaces/IExtension.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";


/**
 * @title BaseManagerV2
 * @author Set Protocol
 *
 * Smart contract manager that contains permissions and admin functionality. Implements IIP-64, supporting
 * a registry of protected modules that can only be upgraded with methodologist consent.
 */
contract BaseManagerV2 is MutualUpgrade {
    using Address for address;
    using AddressArrayUtils for address[];
    using SafeERC20 for IERC20;

    /* ============ Struct ========== */

    struct ProtectedModule {
        bool isProtected;                               // Flag set to true if module is protected
        address[] authorizedExtensionsList;             // List of Extensions authorized to call module
        mapping(address => bool) authorizedExtensions;  // Map of extensions authorized to call module
    }

    /* ============ Events ============ */

    event ExtensionAdded(
        address _extension
    );

    event ExtensionRemoved(
        address _extension
    );

    event MethodologistChanged(
        address _oldMethodologist,
        address _newMethodologist
    );

    event OperatorChanged(
        address _oldOperator,
        address _newOperator
    );

    event ExtensionAuthorized(
        address _module,
        address _extension
    );

    event ExtensionAuthorizationRevoked(
        address _module,
        address _extension
    );

    event ModuleProtected(
        address _module,
        address[] _extensions
    );

    event ModuleUnprotected(
        address _module
    );

    event ReplacedProtectedModule(
        address _oldModule,
        address _newModule,
        address[] _newExtensions
    );

    event EmergencyReplacedProtectedModule(
        address _module,
        address[] _extensions
    );

    event EmergencyRemovedProtectedModule(
        address _module
    );

    event EmergencyResolved();

    /* ============ Modifiers ============ */

    /**
     * Throws if the sender is not the SetToken operator
     */
    modifier onlyOperator() {
        require(msg.sender == operator, "Must be operator");
        _;
    }

    /**
     * Throws if the sender is not the SetToken methodologist
     */
    modifier onlyMethodologist() {
        require(msg.sender == methodologist, "Must be methodologist");
        _;
    }

    /**
     * Throws if the sender is not a listed extension
     */
    modifier onlyExtension() {
        require(isExtension[msg.sender], "Must be extension");
        _;
    }

    /**
     * Throws if contract is in an emergency state following a unilateral operator removal of a
     * protected module.
     */
    modifier upgradesPermitted() {
        require(emergencies == 0, "Upgrades paused by emergency");
        _;
    }

    /**
     * Throws if contract is *not* in an emergency state. Emergency replacement and resolution
     * can only happen in an emergency
     */
    modifier onlyEmergency() {
        require(emergencies > 0, "Not in emergency");
        _;
    }

    /* ============ State Variables ============ */

    // Instance of SetToken
    ISetToken public setToken;

    // Array of listed extensions
    address[] internal extensions;

    // Mapping to check if extension is added
    mapping(address => bool) public isExtension;

    // Address of operator which typically executes manager only functions on Set Protocol modules
    address public operator;

    // Address of methodologist which serves as providing methodology for the index
    address public methodologist;

    // Counter incremented when the operator "emergency removes" a protected module. Decremented
    // when methodologist executes an "emergency replacement". Operator can only add modules and
    // extensions when `emergencies` is zero. Emergencies can only be declared "over" by mutual agreement
    // between operator and methodologist or by the methodologist alone via `resolveEmergency`
    uint256 public emergencies;

    // Mapping of protected modules. These cannot be called or removed except by mutual upgrade.
    mapping(address => ProtectedModule) public protectedModules;

    // List of protected modules, for iteration. Used when checking that an extension removal
    // can happen without methodologist approval
    address[] public protectedModulesList;

    // Boolean set when methodologist authorizes initialization after contract deployment.
    // Must be true to call via `interactManager`.
    bool public initialized;

    /* ============ Constructor ============ */

    constructor(
        ISetToken _setToken,
        address _operator,
        address _methodologist
    )
        public
    {
        setToken = _setToken;
        operator = _operator;
        methodologist = _methodologist;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY METHODOLOGIST : Called by the methodologist to enable contract. All `interactManager`
     * calls revert until this is invoked. Lets methodologist review and authorize initial protected
     * module settings.
     */
    function authorizeInitialization() external onlyMethodologist {
        require(!initialized, "Initialization authorized");
        initialized = true;
    }

    /**
     * MUTUAL UPGRADE: Update the SetToken manager address. Operator and Methodologist must each call
     * this function to execute the update.
     *
     * @param _newManager           New manager address
     */
    function setManager(address _newManager) external mutualUpgrade(operator, methodologist) {
        require(_newManager != address(0), "Zero address not valid");
        setToken.setManager(_newManager);
    }

    /**
     * OPERATOR ONLY: Add a new extension that the BaseManager can call.
     *
     * @param _extension           New extension to add
     */
    function addExtension(address _extension) external upgradesPermitted onlyOperator {
        require(!isExtension[_extension], "Extension already exists");
        require(address(IExtension(_extension).manager()) == address(this), "Extension manager invalid");

        _addExtension(_extension);
    }

    /**
     * OPERATOR ONLY: Remove an existing extension tracked by the BaseManager.
     *
     * @param _extension           Old extension to remove
     */
    function removeExtension(address _extension) external onlyOperator {
        require(isExtension[_extension], "Extension does not exist");
        require(!_isAuthorizedExtension(_extension), "Extension used by protected module");

        extensions.removeStorage(_extension);

        isExtension[_extension] = false;

        emit ExtensionRemoved(_extension);
    }

    /**
     * MUTUAL UPGRADE: Authorizes an extension for a protected module. Operator and Methodologist must
     * each call this function to execute the update. Adds extension to manager if not already present.
     *
     * @param _module           Module to authorize extension for
     * @param _extension          Extension to authorize for module
     */
    function authorizeExtension(address _module, address _extension)
        external
        mutualUpgrade(operator, methodologist)
    {
        require(protectedModules[_module].isProtected, "Module not protected");
        require(!protectedModules[_module].authorizedExtensions[_extension], "Extension already authorized");

        _authorizeExtension(_module, _extension);

        emit ExtensionAuthorized(_module, _extension);
    }

    /**
     * MUTUAL UPGRADE: Revokes extension authorization for a protected module. Operator and Methodologist
     * must each call this function to execute the update. In order to remove the extension completely
     * from the contract removeExtension must be called by the operator.
     *
     * @param _module           Module to revoke extension authorization for
     * @param _extension          Extension to revoke authorization of
     */
    function revokeExtensionAuthorization(address _module, address _extension)
        external
        mutualUpgrade(operator, methodologist)
    {
        require(protectedModules[_module].isProtected, "Module not protected");
        require(isExtension[_extension], "Extension does not exist");
        require(protectedModules[_module].authorizedExtensions[_extension], "Extension not authorized");

        protectedModules[_module].authorizedExtensions[_extension] = false;
        protectedModules[_module].authorizedExtensionsList.removeStorage(_extension);

        emit ExtensionAuthorizationRevoked(_module, _extension);
    }

    /**
     * ADAPTER ONLY: Interact with a module registered on the SetToken. Manager initialization must
     * have been authorized by methodologist. Extension making this call must be authorized
     * to call module if module is protected.
     *
     * @param _module           Module to interact with
     * @param _data             Byte data of function to call in module
     */
    function interactManager(address _module, bytes memory _data) external onlyExtension {
        require(initialized, "Manager not initialized");
        require(_module != address(setToken), "Extensions cannot call SetToken");
        require(_senderAuthorizedForModule(_module, msg.sender), "Extension not authorized for module");

        // Invoke call to module, assume value will always be 0
        _module.functionCallWithValue(_data, 0);
    }

    /**
     * OPERATOR ONLY: Transfers _tokens held by the manager to _destination. Can be used to
     * recover anything sent here accidentally. In BaseManagerV2, extensions should
     * be the only contracts designated as `feeRecipient` in fee modules.
     *
     * @param _token           ERC20 token to send
     * @param _destination     Address receiving the tokens
     * @param _amount          Quantity of tokens to send
     */
    function transferTokens(address _token, address _destination, uint256 _amount) external onlyExtension {
        IERC20(_token).safeTransfer(_destination, _amount);
    }

    /**
     * OPERATOR ONLY: Add a new module to the SetToken.
     *
     * @param _module           New module to add
     */
    function addModule(address _module) external upgradesPermitted onlyOperator {
        setToken.addModule(_module);
    }

    /**
     * OPERATOR ONLY: Remove a new module from the SetToken. Any extensions associated with this
     * module need to be removed in separate transactions via removeExtension.
     *
     * @param _module           Module to remove
     */
    function removeModule(address _module) external onlyOperator {
        require(!protectedModules[_module].isProtected, "Module protected");
        setToken.removeModule(_module);
    }

    /**
     * OPERATOR ONLY: Marks a currently protected module as unprotected and deletes its authorized
     * extension registries. Removes module from the SetToken. Increments the `emergencies` counter,
     * prohibiting any operator-only module or extension additions until `emergencyReplaceProtectedModule`
     * is executed or `resolveEmergency` is called by the methodologist.
     *
     * Called by operator when a module must be removed immediately for security reasons and it's unsafe
     * to wait for a `mutualUpgrade` process to play out.
     *
     * NOTE: If removing a fee module, you can ensure all fees are distributed by calling distribute
     * on the module's de-authorized fee extension after this call.
     *
     * @param _module           Module to remove
     */
    function emergencyRemoveProtectedModule(address _module) external onlyOperator {
        _unProtectModule(_module);
        setToken.removeModule(_module);
        emergencies += 1;

        emit EmergencyRemovedProtectedModule(_module);
    }

    /**
     * OPERATOR ONLY: Marks an existing module as protected and authorizes extensions for
     * it, adding them if necessary. Adds module to the protected modules list
     *
     * The operator uses this when they're adding new features and want to assure the methodologist
     * they won't be unilaterally changed in the future. Cannot be called during an emergency because
     * methodologist needs to explicitly approve protection arrangements under those conditions.
     *
     * NOTE: If adding a fee extension while protecting a fee module, it's important to set the
     * module `feeRecipient` to the new extension's address (ideally before this call).
     *
     * @param  _module          Module to protect
     * @param  _extensions        Array of extensions to authorize for protected module
     */
    function protectModule(address _module, address[] memory _extensions)
        external
        upgradesPermitted
        onlyOperator
    {
        require(setToken.getModules().contains(_module), "Module not added yet");
        _protectModule(_module, _extensions);

        emit ModuleProtected(_module, _extensions);
    }

    /**
     * METHODOLOGIST ONLY: Marks a currently protected module as unprotected and deletes its authorized
     * extension registries. Removes old module from the protected modules list.
     *
     * Called by the methodologist when they want to cede control over a protected module without triggering
     * an emergency (for example, to remove it because its dead).
     *
     * @param  _module          Module to revoke protections for
     */
    function unProtectModule(address _module) external onlyMethodologist {
        _unProtectModule(_module);

        emit ModuleUnprotected(_module);
    }

    /**
     * MUTUAL UPGRADE: Replaces a protected module. Operator and Methodologist must each call this
     * function to execute the update.
     *
     * > Marks a currently protected module as unprotected
     * > Deletes its authorized extension registries.
     * > Removes old module from SetToken.
     * > Adds new module to SetToken.
     * > Marks `_newModule` as protected and authorizes new extensions for it.
     *
     * Used when methodologists wants to guarantee that an existing protection arrangement is replaced
     * with a suitable substitute (ex: upgrading a StreamingFeeSplitExtension).
     *
     * NOTE: If replacing a fee module, it's necessary to set the module `feeRecipient` to be
     * the new fee extension address after this call. Any fees remaining in the old module's
     * de-authorized extensions can be distributed by calling `distribute()` on the old extension.
     *
     * @param _oldModule        Module to remove
     * @param _newModule        Module to add in place of removed module
     * @param _newExtensions      Extensions to authorize for new module
     */
    function replaceProtectedModule(address _oldModule, address _newModule, address[] memory _newExtensions)
        external
        mutualUpgrade(operator, methodologist)
    {
        _unProtectModule(_oldModule);

        setToken.removeModule(_oldModule);
        setToken.addModule(_newModule);

        _protectModule(_newModule, _newExtensions);

        emit ReplacedProtectedModule(_oldModule, _newModule, _newExtensions);
    }

    /**
     * MUTUAL UPGRADE & EMERGENCY ONLY: Replaces a module the operator has removed with
     * `emergencyRemoveProtectedModule`. Operator and Methodologist must each call this function to
     *  execute the update.
     *
     * > Adds new module to SetToken.
     * > Marks `_newModule` as protected and authorizes new extensions for it.
     * > Adds `_newModule` to protectedModules list.
     * > Decrements the emergencies counter,
     *
     * Used when methodologist wants to guarantee that a protection arrangement which was
     * removed in an emergency is replaced with a suitable substitute. Operator's ability to add modules
     * or extensions is restored after invoking this method (if this is the only emergency.)
     *
     * NOTE: If replacing a fee module, it's necessary to set the module `feeRecipient` to be
     * the new fee extension address after this call. Any fees remaining in the old module's
     * de-authorized extensions can be distributed by calling `accrueFeesAndDistribute` on the old extension.
     *
     * @param _module          Module to add in place of removed module
     * @param _extensions      Array of extensions to authorize for replacement module
     */
    function emergencyReplaceProtectedModule(
        address _module,
        address[] memory _extensions
    )
        external
        mutualUpgrade(operator, methodologist)
        onlyEmergency
    {
        setToken.addModule(_module);
        _protectModule(_module, _extensions);

        emergencies -= 1;

        emit EmergencyReplacedProtectedModule(_module, _extensions);
    }

    /**
     * METHODOLOGIST ONLY & EMERGENCY ONLY: Decrements the emergencies counter.
     *
     * Allows a methodologist to exit a state of emergency without replacing a protected module that
     * was removed. This could happen if the module has no viable substitute or operator and methodologist
     * agree that restoring normal operations is the best way forward.
     */
    function resolveEmergency() external onlyMethodologist onlyEmergency {
        emergencies -= 1;

        emit EmergencyResolved();
    }

    /**
     * METHODOLOGIST ONLY: Update the methodologist address
     *
     * @param _newMethodologist           New methodologist address
     */
    function setMethodologist(address _newMethodologist) external onlyMethodologist {
        emit MethodologistChanged(methodologist, _newMethodologist);

        methodologist = _newMethodologist;
    }

    /**
     * OPERATOR ONLY: Update the operator address
     *
     * @param _newOperator           New operator address
     */
    function setOperator(address _newOperator) external onlyOperator {
        emit OperatorChanged(operator, _newOperator);

        operator = _newOperator;
    }

    /* ============ External Getters ============ */

    function getExtensions() external view returns(address[] memory) {
        return extensions;
    }

    function getAuthorizedExtensions(address _module) external view returns (address[] memory) {
        return protectedModules[_module].authorizedExtensionsList;
    }

    function isAuthorizedExtension(address _module, address _extension) external view returns (bool) {
        return protectedModules[_module].authorizedExtensions[_extension];
    }

    function getProtectedModules() external view returns (address[] memory) {
        return protectedModulesList;
    }

    /* ============ Internal ============ */


    /**
     * Add a new extension that the BaseManager can call.
     */
    function _addExtension(address _extension) internal {
        extensions.push(_extension);

        isExtension[_extension] = true;

        emit ExtensionAdded(_extension);
    }

    /**
     * Marks a currently protected module as unprotected and deletes it from authorized extension
     * registries. Removes module from the SetToken.
     */
    function _unProtectModule(address _module) internal {
        require(protectedModules[_module].isProtected, "Module not protected");

        // Clear mapping and array entries in struct before deleting mapping entry
        for (uint256 i = 0; i < protectedModules[_module].authorizedExtensionsList.length; i++) {
            address extension = protectedModules[_module].authorizedExtensionsList[i];
            protectedModules[_module].authorizedExtensions[extension] = false;
        }

        delete protectedModules[_module];

        protectedModulesList.removeStorage(_module);
    }

    /**
     * Adds new module to SetToken. Marks `_newModule` as protected and authorizes
     * new extensions for it. Adds `_newModule` module to protectedModules list.
     */
    function _protectModule(address _module, address[] memory _extensions) internal {
        require(!protectedModules[_module].isProtected, "Module already protected");

        protectedModules[_module].isProtected = true;
        protectedModulesList.push(_module);

        for (uint i = 0; i < _extensions.length; i++) {
            _authorizeExtension(_module, _extensions[i]);
        }
    }

    /**
     * Adds extension if not already added and marks extension as authorized for module
     */
    function _authorizeExtension(address _module, address _extension) internal {
        if (!isExtension[_extension]) {
            _addExtension(_extension);
        }

        protectedModules[_module].authorizedExtensions[_extension] = true;
        protectedModules[_module].authorizedExtensionsList.push(_extension);
    }

    /**
     * Searches the extension mappings of each protected modules to determine if an extension
     * is authorized by any of them. Authorized extensions cannot be unilaterally removed by
     * the operator.
     */
    function _isAuthorizedExtension(address _extension) internal view returns (bool) {
        for (uint256 i = 0; i < protectedModulesList.length; i++) {
            if (protectedModules[protectedModulesList[i]].authorizedExtensions[_extension]) {
                return true;
            }
        }

        return false;
    }

    /**
     * Checks if `_sender` (an extension) is allowed to call a module (which may be protected)
     */
    function _senderAuthorizedForModule(address _module, address _sender) internal view returns (bool) {
        if (protectedModules[_module].isProtected) {
            return protectedModules[_module].authorizedExtensions[_sender];
        }

        return true;
    }
}
