/*
    Copyright 2021 Index Coop

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

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWrapModule } from "../interfaces/IWrapModule.sol";

/**
 * @title WrapExtension
 * @author Index Coop
 *
 * Manager extension for interacting with WrapModule
 */
contract WrapExtension is BaseExtension {

    /* ========== State Variables ========= */

    // Address of Set Token
    ISetToken public immutable setToken;

    // Address of WrapModule
    IWrapModule public immutable wrapModule;

    /* ============ Constructor ============ */

    /**
     * Sets state variables
     *
     * @param _manager          Manager contract
     * @param _wrapModule       Set Protocol WrapModule
     */
    constructor(IBaseManager _manager, IWrapModule _wrapModule) public BaseExtension(_manager) {
        manager = _manager;
        setToken = manager.setToken();
        wrapModule = _wrapModule;
    }

    /* ========== External Functions ========== */

    /**
     * OPERATOR ONLY: Initializes the Set Token on the Wrap Module.
     */
    function initialize() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(wrapModule.initialize.selector, setToken);
        invokeManager(address(wrapModule), data);
    }

    /**
     * OPERATOR ONLY: Calls wrap on the WrapModule.
     *
     * @param _underlyingToken  address of underlying token
     * @param _wrappedToken     address of wrapped token
     * @param _underlyingUnits  units of underlying to wrap
     * @param _integrationName  Set Protocol integreation name for the wrap adapter
     */
    function wrap(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits,
        string calldata _integrationName
    )
        external
        onlyOperator
    {
        bytes memory data = abi.encodeWithSelector(
            wrapModule.wrap.selector,
            setToken,
            _underlyingToken,
            _wrappedToken,
            _underlyingUnits,
            _integrationName
        );
        invokeManager(address(wrapModule), data);
    }

    /**
     * OPERATOR ONLY: Calls wrapWithEther on the WrapModule.
     *
     * @param _wrappedToken     address of wrapped token
     * @param _underlyingUnits  units of weth to wrap
     * @param _integrationName  Set Protocol integreation name for the wrap adapter
     */
    function wrapWithEther(
        address _wrappedToken,
        uint256 _underlyingUnits,
        string calldata _integrationName
    )
        external
        onlyOperator
    {
        bytes memory data = abi.encodeWithSelector(
            wrapModule.wrapWithEther.selector,
            setToken,
            _wrappedToken,
            _underlyingUnits,
            _integrationName
        );
        invokeManager(address(wrapModule), data);
    }

    /**
     * OPERATOR ONLY: Calls unwrap on the WrapModule.
     *
     * @param _underlyingToken  address of underlying token
     * @param _wrappedToken     address of wrapped token
     * @param _wrappedUnits     units of wrapped token to unwrap
     * @param _integrationName  Set Protocol integreation name for the wrap adapter
     */
    function unwrap(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _wrappedUnits,
        string calldata _integrationName
    )
        external
        onlyOperator
    {
        bytes memory data = abi.encodeWithSelector(
            wrapModule.unwrap.selector,
            setToken,
            _underlyingToken,
            _wrappedToken,
            _wrappedUnits,
            _integrationName
        );
        invokeManager(address(wrapModule), data);
    }

    /**
     * OPERATOR ONLY: Calls unwrapWithEther on the WrapModule.
     *
     * @param _wrappedToken     address of wrapped token
     * @param _wrappedUnits     units of wrapped token to unwrap
     * @param _integrationName  Set Protocol integreation name for the wrap adapter
     */
    function unwrapWithEther(
        address _wrappedToken,
        uint256 _wrappedUnits,
        string calldata _integrationName
    )
        external
        onlyOperator
    {
        bytes memory data = abi.encodeWithSelector(
            wrapModule.unwrapWithEther.selector,
            setToken,
            _wrappedToken,
            _wrappedUnits,
            _integrationName
        );
        invokeManager(address(wrapModule), data);
    }
}