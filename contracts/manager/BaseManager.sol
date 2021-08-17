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

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { IAdapter } from "../interfaces/IAdapter.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";


/**
 * @title BaseManager
 * @author Set Protocol
 *
 * Smart contract manager that contains permissions and admin functionality
 */
contract BaseManager is MutualUpgrade {
    using Address for address;
    using AddressArrayUtils for address[];

    /* ============ Struct ========== */

    struct ProtectedModule {
        bool isProtected;                               // Flag set to true if module is protected
        address[] authorizedAdaptersList;               // List of Adapters authorized to call module
        mapping(address => bool) authorizedAdapters;    // Map of adapters authorized to call module
    }

    /* ============ Events ============ */

    event AdapterAdded(
        address _adapter
    );

    event AdapterRemoved(
        address _adapter
    );

    event MethodologistChanged(
        address _oldMethodologist,
        address _newMethodologist
    );

    event OperatorChanged(
        address _oldOperator,
        address _newOperator
    );

    event AdapterAuthorized(
        address _module,
        address _adapter
    );

    event AdapterAuthorizationRevoked(
        address _module,
        address _adapter
    );

    event ModuleProtected(
        address _module,
        address[] _adapters
    );

    event ModuleUnprotected(
        address _module
    );

    event ReplacedProtectedModule(
        address _oldModule,
        address _newModule,
        address[] _newAdapters
    );

    event EmergencyReplacedProtectedModule(
        address _module,
        address[] _adapters
    );

    event EmergencyRemovedProtectedModule(
        address _module
    );

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
     * Throws if the sender is not a listed adapter
     */
    modifier onlyAdapter() {
        require(isAdapter[msg.sender], "Must be adapter");
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

    // Array of listed adapters
    address[] internal adapters;

    // Mapping to check if adapter is added
    mapping(address => bool) public isAdapter;

    // Address of operator which typically executes manager only functions on Set Protocol modules
    address public operator;

    // Address of methodologist which serves as providing methodology for the index
    address public methodologist;

    // Counter incremented when the operator "emergency removes" a protected module. Decremented
    // when methodologist executes an "emergency replacement". Operator can only add modules and
    // adapters when `emergencies` is zero. Emergencies can only be declared "over" by mutual agreement
    // between operator and methodologist or by the methodologist alone via `resolveEmergency`
    uint256 public emergencies;

    // Mapping of protected modules. These cannot be called or removed except by mutual upgrade.
    mapping(address => ProtectedModule) public protectedModules;

    // List of protected modules, for iteration. Used when checking that an adapter removal
    // can happen without methodologist approval
    address[] public protectedModulesList;

    // Boolean set when methodologist authorizes initialization after contract deployment.
    // Must be true to call via `interactManager`.
    bool public initialized;

    /* ============ Constructor ============ */

    constructor(
        ISetToken _setToken,
        address _operator,
        address _methodologist,
        address[] memory _protectedModules,      // Modules to initialize as protected
        address[][] memory _authorizedAdapters   // Adapters authorized for each protected module
    )
        public
    {
        setToken = _setToken;
        operator = _operator;
        methodologist = _methodologist;

        for (uint256 i = 0; i < _protectedModules.length; i++) {
            _protectModule(_protectedModules[i], _authorizedAdapters[i]);
        }
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
     * OPERATOR ONLY: Add a new adapter that the BaseManager can call.
     *
     * @param _adapter           New adapter to add
     */
    function addAdapter(address _adapter) external upgradesPermitted onlyOperator {
        require(!isAdapter[_adapter], "Adapter already exists");
        require(address(IAdapter(_adapter).manager()) == address(this), "Adapter manager invalid");

        _addAdapter(_adapter);
    }

    /**
     * OPERATOR ONLY: Remove an existing adapter tracked by the BaseManager.
     *
     * @param _adapter           Old adapter to remove
     */
    function removeAdapter(address _adapter) external onlyOperator {
        require(isAdapter[_adapter], "Adapter does not exist");
        require(!_isAuthorizedAdapter(_adapter), "Adapter used by protected module");

        adapters.removeStorage(_adapter);

        isAdapter[_adapter] = false;

        emit AdapterRemoved(_adapter);
    }

    /**
     * MUTUAL UPGRADE: Authorizes an adapter for a protected module. Operator and Methodologist must
     * each call this function to execute the update. Adds adapter to manager if not already present.
     *
     * @param _module           Module to authorize adapter for
     * @param _adapter          Adapter to authorize for module
     */
    function authorizeAdapter(address _module, address _adapter)
        external
        mutualUpgrade(operator, methodologist)
    {
        require(protectedModules[_module].isProtected, "Module not protected");
        require(!protectedModules[_module].authorizedAdapters[_adapter], "Adapter already authorized");

        if (!isAdapter[_adapter]) {
            _addAdapter(_adapter);
        }

        protectedModules[_module].authorizedAdapters[_adapter] = true;
        protectedModules[_module].authorizedAdaptersList.push(_adapter);

        emit AdapterAuthorized(_module, _adapter);
    }

    /**
     * MUTUAL UPGRADE: Revokes adapter authorization for a protected module. Operator and Methodologist
     * must each call this function to execute the update. In order to remove the extension completely
     * from the contract removeAdapter must be called by the operator.
     *
     * @param _module           Module to revoke adapter authorization for
     * @param _adapter          Adapter to revoke authorization of
     */
    function revokeAdapterAuthorization(address _module, address _adapter)
        external
        mutualUpgrade(operator, methodologist)
    {
        require(protectedModules[_module].isProtected, "Module not protected");
        require(isAdapter[_adapter], "Adapter does not exist");
        require(protectedModules[_module].authorizedAdapters[_adapter], "Adapter not authorized");

        protectedModules[_module].authorizedAdapters[_adapter] = false;
        protectedModules[_module].authorizedAdaptersList.removeStorage(_adapter);

        emit AdapterAuthorizationRevoked(_module, _adapter);
    }

    /**
     * ADAPTER ONLY: Interact with a module registered on the SetToken. Manager initialization must
     * have been authorized by methodologist. Adapter making this call must be authorized
     * to call module if module is protected.
     *
     * @param _module           Module to interact with
     * @param _data             Byte data of function to call in module
     */
    function interactManager(address _module, bytes memory _data) external onlyAdapter {
        require(initialized, "Manager not initialized");
        require(_senderAuthorizedForModule(_module, msg.sender), "Adapter not authorized for module");

        // Invoke call to module, assume value will always be 0
        _module.functionCallWithValue(_data, 0);
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
     * OPERATOR ONLY: Remove a new module from the SetToken. Any adapters associated with this
     * module need to be removed in separate transactions via removeAdapter.
     *
     * @param _module           Module to remove
     */
    function removeModule(address _module) external onlyOperator {
        require(!protectedModules[_module].isProtected, "Module protected");
        setToken.removeModule(_module);
    }

    /**
     * OPERATOR ONLY: Marks a currently protected module as unprotected and deletes its authorized
     * adapter registries. Removes module from the SetToken. Increments the `emergencies` counter,
     * prohibiting any operator-only module or extension additions until `emergencyReplaceProtectedModule`
     * is executed or `resolveEmergency` is called by the methodologist.
     *
     * Called by operator when a module must be removed immediately for security reasons and it's unsafe
     * to wait for a `mutualUpgrade` process to play out.
     *
     * NOTE: If removing a fee module, you can ensure all fees are distributed by calling distribute
     * on the module's de-authorized fee adapter after this call.
     *
     * @param _module           Module to remove
     */
    function emergencyRemoveProtectedModule(address _module) external onlyOperator {
        _unProtectModule(_module);
        setToken.removeModule(_module);
        emergencies += 1;

        EmergencyRemovedProtectedModule(_module);
    }

    /**
     * OPERATOR ONLY: Marks an existing module as protected and authorizes existing adapters for
     * it. Adds module to the protected modules list
     *
     * The operator uses this when they're adding new features and want to assure the methodologist
     * they won't be unilaterally changed in the future. Cannot be called during an emergency because
     * methodologist needs to explicitly approve protection arrangements under those conditions.
     *
     * NOTE: If adding a fee adapter while protecting a fee module, it's important to set the
     * module `feeRecipient` to the new adapter's address (ideally before this call).
     *
     * @param  _module          Module to protect
     * @param  _adapters        Array of adapters to authorize for protected module
     */
    function protectModule(address _module, address[] memory _adapters)
        external
        upgradesPermitted
        onlyOperator
    {
        require(setToken.getModules().contains(_module), "Module not added yet");
        _protectModule(_module, _adapters);

        emit ModuleProtected(_module, _adapters);
    }

    /**
     * METHODOLOGIST ONLY: Marks a currently protected module as unprotected and deletes its authorized
     * adapter registries. Removes old module from the protected modules list.
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
     * > Deletes its authorized adapter registries.
     * > Removes old module from SetToken.
     * > Adds new module to SetToken.
     * > Marks `_newModule` as protected and authorizes new adapters for it.
     *
     * Used when methodologists wants to guarantee that an existing protection arrangement is replaced
     * with a suitable substitute (ex: upgrading a StreamingFeeSplitExtension).
     *
     * NOTE: If replacing a fee module, it's necessary to set the module `feeRecipient` to be
     * the new fee adapter address after this call. Any fees remaining in the old module's
     * de-authorized adapters can be distributed by calling `distribute()` on the old adapter.
     *
     * @param _oldModule        Module to remove
     * @param _newModule        Module to add in place of removed module
     * @param _newAdapters      Adapters to authorize for new module
     */
    function replaceProtectedModule(address _oldModule, address _newModule, address[] memory _newAdapters)
        external
        mutualUpgrade(operator, methodologist)
    {
        _unProtectModule(_oldModule);

        setToken.removeModule(_oldModule);
        setToken.addModule(_newModule);

        _protectModule(_newModule, _newAdapters);

        ReplacedProtectedModule(_oldModule, _newModule, _newAdapters);
    }

    /**
     * MUTUAL UPGRADE & EMERGENCY ONLY: Replaces a module the operator has removed with
     * `emergencyRemoveProtectedModule`. Operator and Methodologist must each call this function to
     *  execute the update.
     *
     * > Adds new module to SetToken.
     * > Marks `_newModule` as protected and authorizes new adapters for it.
     * > Adds `_newModule` to protectedModules list.
     * > Decrements the emergencies counter,
     *
     * Used when methodologist wants to guarantee that a protection arrangement which was
     * removed in an emergency is replaced with a suitable substitute. Operator's ability to add modules
     * or adapters is restored after invoking this method (if this is the only emergency.)
     *
     * NOTE: If replacing a fee module, it's necessary to set the module `feeRecipient` to be
     * the new fee adapter address after this call. Any fees remaining in the old module's
     * de-authorized adapters can be distributed by calling `distribute()` on the old adapter.
     *
     * @param _module        Module to add in place of removed module
     * @param _adapters      Array of adapters to authorize for replacement module
     */
    function emergencyReplaceProtectedModule(
        address _module,
        address[] memory _adapters
    )
        external
        mutualUpgrade(operator, methodologist)
        onlyEmergency
    {
        setToken.addModule(_module);
        _protectModule(_module, _adapters);

        emergencies -= 1;

        EmergencyReplacedProtectedModule(_module, _adapters);
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

    function getAdapters() external view returns(address[] memory) {
        return adapters;
    }

    function getAuthorizedAdapters(address _module) external view returns (address[] memory) {
        return protectedModules[_module].authorizedAdaptersList;
    }

    function isAuthorizedAdapter(address _module, address _adapter) external view returns (bool) {
        return protectedModules[_module].authorizedAdapters[_adapter];
    }

    function getProtectedModules() external view returns (address[] memory) {
        return protectedModulesList;
    }

    /* ============ Internal ============ */


    /**
     * Add a new adapter that the BaseManager can call.
     */
    function _addAdapter(address _adapter) internal {
        adapters.push(_adapter);

        isAdapter[_adapter] = true;

        emit AdapterAdded(_adapter);
    }

    /**
     * Marks a currently protected module as unprotected and deletes it from authorized adapter
     * registries. Removes module from the SetToken.
     */
    function _unProtectModule(address _module) internal {
        require(protectedModules[_module].isProtected, "Module not protected");

        // Clear mapping and array entries in struct before deleting mapping entry
        for (uint256 i = 0; i < protectedModules[_module].authorizedAdaptersList.length; i++) {
            address adapter = protectedModules[_module].authorizedAdaptersList[i];
            protectedModules[_module].authorizedAdapters[adapter] = false;
        }

        delete protectedModules[_module];

        protectedModulesList.removeStorage(_module);
    }

    /**
     * Adds new module to SetToken. Marks `_newModule` as protected and authorizes
     * new adapters for it. Adds `_newModule` module to protectedModules list.
     */
    function _protectModule(address _module, address[] memory _adapters) internal {
        require(!protectedModules[_module].isProtected, "Module already protected");

        protectedModules[_module].isProtected = true;
        protectedModulesList.push(_module);

        for (uint i = 0; i < _adapters.length; i++) {
            if (!isAdapter[_adapters[i]]) {
                _addAdapter(_adapters[i]);
            }
            protectedModules[_module].authorizedAdapters[_adapters[i]] = true;
            protectedModules[_module].authorizedAdaptersList.push(_adapters[i]);
        }
    }

    /**
     * Searches the adapter mappings of each protected modules to determine if an extension
     * is authorized by any of them. Authorized extensions cannot be unilaterally removed by
     * the operator.
     */
    function _isAuthorizedAdapter(address _adapter) internal view returns (bool) {
        for (uint256 i = 0; i < protectedModulesList.length; i++) {
            if (protectedModules[protectedModulesList[i]].authorizedAdapters[_adapter]) {
                return true;
            }
        }

        return false;
    }

    /**
     * Checks if `_sender` (an adapter) is allowed to call a module (which may be protected)
     */
    function _senderAuthorizedForModule(address _module, address _sender) internal view returns (bool) {
        if (protectedModules[_module].isProtected) {
            return protectedModules[_module].authorizedAdapters[_sender];
        }

        return true;
    }
}
