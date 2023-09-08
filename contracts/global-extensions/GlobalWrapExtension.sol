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

import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { IWrapModuleV2 } from "../interfaces/IWrapModuleV2.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";

/**
 * @title GlobalWrapExtension
 * @author Set Protocol
 *
 * Smart contract global extension which provides DelegatedManager operator(s) the ability to wrap ERC20 and Ether positions
 * via third party protocols.
 *
 * Some examples of wrap actions include wrapping, DAI to cDAI (Compound) or Dai to aDai (AAVE).
 */
contract GlobalWrapExtension is BaseGlobalExtension {

    /* ============ Events ============ */

    event WrapExtensionInitialized(
        address indexed _setToken,
        address indexed _delegatedManager
    );

    /* ============ State Variables ============ */

    // Instance of WrapModuleV2
    IWrapModuleV2 public immutable wrapModule;

    /* ============ Constructor ============ */

    /**
     * Instantiate with ManagerCore address and WrapModuleV2 address.
     *
     * @param _managerCore              Address of ManagerCore contract
     * @param _wrapModule               Address of WrapModuleV2 contract
     */
    constructor(
        IManagerCore _managerCore,
        IWrapModuleV2 _wrapModule
    )
        public
        BaseGlobalExtension(_managerCore)
    {
        wrapModule = _wrapModule;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Initializes WrapModuleV2 on the SetToken associated with the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the WrapModuleV2 for
     */
    function initializeModule(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        _initializeModule(_delegatedManager.setToken(), _delegatedManager);
    }

    /**
     * ONLY OWNER: Initializes WrapExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);

        emit WrapExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY OWNER: Initializes WrapExtension to the DelegatedManager and TradeModule to the SetToken
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeModuleAndExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager){
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);
        _initializeModule(setToken, _delegatedManager);

        emit WrapExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the WrapExtension
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        _removeExtension(setToken, delegatedManager);
    }

    /**
     * ONLY OPERATOR: Instructs the SetToken to wrap an underlying asset into a wrappedToken via a specified adapter.
     *
     * @param _setToken             Instance of the SetToken
     * @param _underlyingToken      Address of the component to be wrapped
     * @param _wrappedToken         Address of the desired wrapped token
     * @param _underlyingUnits      Quantity of underlying units in Position units
     * @param _integrationName      Name of wrap module integration (mapping on integration registry)
     * @param _wrapData             Arbitrary bytes to pass into the WrapV2Adapter
     */
    function wrap(
        ISetToken _setToken,
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits,
        string calldata _integrationName,
        bytes memory _wrapData
    )
        external
        onlyOperator(_setToken)
        onlyAllowedAsset(_setToken, _wrappedToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IWrapModuleV2.wrap.selector,
            _setToken,
            _underlyingToken,
            _wrappedToken,
            _underlyingUnits,
            _integrationName,
            _wrapData
        );
        _invokeManager(_manager(_setToken), address(wrapModule), callData);
    }

    /**
     * ONLY OPERATOR: Instructs the SetToken to wrap Ether into a wrappedToken via a specified adapter. Since SetTokens
     * only hold WETH, in order to support protocols that collateralize with Ether the SetToken's WETH must be unwrapped
     * first before sending to the external protocol.
     *
     * @param _setToken             Instance of the SetToken
     * @param _wrappedToken         Address of the desired wrapped token
     * @param _underlyingUnits      Quantity of underlying units in Position units
     * @param _integrationName      Name of wrap module integration (mapping on integration registry)
     * @param _wrapData             Arbitrary bytes to pass into the WrapV2Adapter
     */
    function wrapWithEther(
        ISetToken _setToken,
        address _wrappedToken,
        uint256 _underlyingUnits,
        string calldata _integrationName,
        bytes memory _wrapData
    )
        external
        onlyOperator(_setToken)
        onlyAllowedAsset(_setToken, _wrappedToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IWrapModuleV2.wrapWithEther.selector,
            _setToken,
            _wrappedToken,
            _underlyingUnits,
            _integrationName,
            _wrapData
        );
        _invokeManager(_manager(_setToken), address(wrapModule), callData);
    }

    /**
     * ONLY OPERATOR: Instructs the SetToken to unwrap a wrapped asset into its underlying via a specified adapter.
     *
     * @param _setToken             Instance of the SetToken
     * @param _underlyingToken      Address of the underlying asset
     * @param _wrappedToken         Address of the component to be unwrapped
     * @param _wrappedUnits         Quantity of wrapped tokens in Position units
     * @param _integrationName      ID of wrap module integration (mapping on integration registry)
     * @param _unwrapData           Arbitrary bytes to pass into the WrapV2Adapter
     */
    function unwrap(
        ISetToken _setToken,
        address _underlyingToken,
        address _wrappedToken,
        uint256 _wrappedUnits,
        string calldata _integrationName,
        bytes memory _unwrapData
    )
        external
        onlyOperator(_setToken)
        onlyAllowedAsset(_setToken, _underlyingToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IWrapModuleV2.unwrap.selector,
            _setToken,
            _underlyingToken,
            _wrappedToken,
            _wrappedUnits,
            _integrationName,
            _unwrapData
        );
        _invokeManager(_manager(_setToken), address(wrapModule), callData);
    }

    /**
     * ONLY OPERATOR: Instructs the SetToken to unwrap a wrapped asset collateralized by Ether into Wrapped Ether. Since
     * external protocol will send back Ether that Ether must be Wrapped into WETH in order to be accounted for by SetToken.
     *
     * @param _setToken                 Instance of the SetToken
     * @param _wrappedToken             Address of the component to be unwrapped
     * @param _wrappedUnits             Quantity of wrapped tokens in Position units
     * @param _integrationName          ID of wrap module integration (mapping on integration registry)
     * @param _unwrapData           Arbitrary bytes to pass into the WrapV2Adapter
     */
    function unwrapWithEther(
        ISetToken _setToken,
        address _wrappedToken,
        uint256 _wrappedUnits,
        string calldata _integrationName,
        bytes memory _unwrapData
    )
        external
        onlyOperator(_setToken)
        onlyAllowedAsset(_setToken, address(wrapModule.weth()))
    {
        bytes memory callData = abi.encodeWithSelector(
            IWrapModuleV2.unwrapWithEther.selector,
            _setToken,
            _wrappedToken,
            _wrappedUnits,
            _integrationName,
            _unwrapData
        );
        _invokeManager(_manager(_setToken), address(wrapModule), callData);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to initialize WrapModuleV2 on the SetToken associated with the DelegatedManager.
     *
     * @param _setToken             Instance of the SetToken corresponding to the DelegatedManager
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the WrapModuleV2 for
     */
    function _initializeModule(ISetToken _setToken, IDelegatedManager _delegatedManager) internal {
        bytes memory callData = abi.encodeWithSelector(IWrapModuleV2.initialize.selector, _setToken);
        _invokeManager(_delegatedManager, address(wrapModule), callData);
    }
}
