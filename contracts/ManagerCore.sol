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

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AddressArrayUtils } from "./lib/AddressArrayUtils.sol";

/**
 * @title ManagerCore
 * @author Set Protocol
 *
 *  Registry for governance approved GlobalExtensions, DelegatedManagerFactories, and DelegatedManagers.
 */
contract ManagerCore is Ownable {
    using AddressArrayUtils for address[];

    /* ============ Events ============ */

    event ExtensionAdded(address indexed _extension);
    event ExtensionRemoved(address indexed _extension);
    event FactoryAdded(address indexed _factory);
    event FactoryRemoved(address indexed _factory);
    event ManagerAdded(address indexed _manager, address indexed _factory);
    event ManagerRemoved(address indexed _manager);

    /* ============ Modifiers ============ */

    /**
     * Throws if function is called by any address other than a valid factory.
     */
    modifier onlyFactory() {
        require(isFactory[msg.sender], "Only valid factories can call");
        _;
    }

    modifier onlyInitialized() {
        require(isInitialized, "Contract must be initialized.");
        _;
    }

    /* ============ State Variables ============ */

    // List of enabled extensions
    address[] public extensions;
    // List of enabled factories of managers
    address[] public factories;
    // List of enabled managers
    address[] public managers;

    // Mapping to check whether address is valid Extension, Factory, or Manager
    mapping(address => bool) public isExtension;
    mapping(address => bool) public isFactory;
    mapping(address => bool) public isManager;


    // Return true if the ManagerCore is initialized
    bool public isInitialized;

    /* ============ External Functions ============ */

    /**
     * Initializes any predeployed factories. Note: This function can only be called by
     * the owner once to batch initialize the initial system contracts.
     *
     * @param _extensions            List of extensions to add
     * @param _factories             List of factories to add
     */
    function initialize(
        address[] memory _extensions,
        address[] memory _factories
    )
        external
        onlyOwner
    {
        require(!isInitialized, "ManagerCore is already initialized");

        extensions = _extensions;
        factories = _factories;

        // Loop through and initialize isExtension and isFactory mapping
        for (uint256 i = 0; i < _extensions.length; i++) {
            _addExtension(_extensions[i]);
        }
        for (uint256 i = 0; i < _factories.length; i++) {
            _addFactory(_factories[i]);
        }

        // Set to true to only allow initialization once
        isInitialized = true;
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to add an extension
     *
     * @param _extension               Address of the extension contract to add
     */
    function addExtension(address _extension) external onlyInitialized onlyOwner {
        require(!isExtension[_extension], "Extension already exists");

        _addExtension(_extension);

        extensions.push(_extension);
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to remove an extension
     *
     * @param _extension               Address of the extension contract to remove
     */
    function removeExtension(address _extension) external onlyInitialized onlyOwner {
        require(isExtension[_extension], "Extension does not exist");

        extensions.removeStorage(_extension);

        isExtension[_extension] = false;

        emit ExtensionRemoved(_extension);
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to add a factory
     *
     * @param _factory               Address of the factory contract to add
     */
    function addFactory(address _factory) external onlyInitialized onlyOwner {
        require(!isFactory[_factory], "Factory already exists");

        _addFactory(_factory);

        factories.push(_factory);
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to remove a factory
     *
     * @param _factory               Address of the factory contract to remove
     */
    function removeFactory(address _factory) external onlyInitialized onlyOwner {
        require(isFactory[_factory], "Factory does not exist");

        factories.removeStorage(_factory);

        isFactory[_factory] = false;

        emit FactoryRemoved(_factory);
    }

    /**
     * PRIVILEGED FACTORY FUNCTION. Adds a newly deployed manager as an enabled manager.
     *
     * @param _manager               Address of the manager contract to add
     */
    function addManager(address _manager) external onlyInitialized onlyFactory {
        require(!isManager[_manager], "Manager already exists");

        isManager[_manager] = true;

        managers.push(_manager);

        emit ManagerAdded(_manager, msg.sender);
    }

    /**
     * PRIVILEGED GOVERNANCE FUNCTION. Allows governance to remove a manager
     *
     * @param _manager               Address of the manager contract to remove
     */
    function removeManager(address _manager) external onlyInitialized onlyOwner {
        require(isManager[_manager], "Manager does not exist");

        managers.removeStorage(_manager);

        isManager[_manager] = false;

        emit ManagerRemoved(_manager);
    }

    /* ============ External Getter Functions ============ */

    function getExtensions() external view returns (address[] memory) {
        return extensions;
    }

    function getFactories() external view returns (address[] memory) {
        return factories;
    }

    function getManagers() external view returns (address[] memory) {
        return managers;
    }

    /* ============ Internal Functions ============ */

    /**
     * Add an extension tracked on the ManagerCore
     *
     * @param _extension               Address of the extension contract to add
     */
    function _addExtension(address _extension) internal {
        require(_extension != address(0), "Zero address submitted.");

        isExtension[_extension] = true;

        emit ExtensionAdded(_extension);
    }

    /**
     * Add a factory tracked on the ManagerCore
     *
     * @param _factory               Address of the factory contract to add
     */
    function _addFactory(address _factory) internal {
        require(_factory != address(0), "Zero address submitted.");

        isFactory[_factory] = true;

        emit FactoryAdded(_factory);
    }
}
