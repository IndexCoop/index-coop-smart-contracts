/*
    Copyright 2023 Index Coop

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
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IAuctionRebalanceModuleV1 } from "../interfaces/IAuctionRebalanceModuleV1.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";


/**
 * @title GlobalAuctionRebalanceExtension
 * @author Index Coop
 *
 * @dev Extension contract for interacting with the AuctionRebalanceModuleV1. This contract acts as a pass-through and functions 
 * are only callable by operator. 
 */
contract GlobalAuctionRebalanceExtension is BaseGlobalExtension {
    using AddressArrayUtils for address[];
    using SafeMath for uint256;

    /* ============ Events ============ */

    event AuctionRebalanceExtensionInitialized(
        address indexed _setToken,
        address indexed _delegatedManager
    );


    /* ============ Structs ============ */

    struct AuctionExecutionParams {
        uint256 targetUnit;                      // Target quantity of the component in Set, in precise units (10 ** 18).
        string priceAdapterName;                 // Identifier for the price adapter to be used.
        bytes priceAdapterConfigData;            // Encoded data for configuring the chosen price adapter.
    }

    /* ============ State Variables ============ */
    
    IAuctionRebalanceModuleV1 public immutable auctionModule;  // AuctionRebalanceModuleV1


    /* ============ Constructor ============ */
    /**
     * @dev Instantiate with ManagerCore address and WrapModuleV2 address. 
     * 
     * @param _managerCore              Address of ManagerCore contract 
     * @param _auctionModule            Address of AuctionRebalanceModuleV1 contract 
    */ 
    constructor(IManagerCore _managerCore, IAuctionRebalanceModuleV1 _auctionModule) public BaseGlobalExtension(_managerCore) {
        auctionModule = _auctionModule;
    }

    /* ============ External Functions ============ */

    
    /**
     * @dev ONLY OWNER: Initializes AuctionRebalanceModuleV1 on the SetToken associated with the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the AuctionRebalanceModuleV1 for
     */
    function initializeModule(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        require(_delegatedManager.isInitializedExtension(address(this)), "Extension must be initialized");
        _initializeModule(_delegatedManager.setToken(), _delegatedManager);
    }

    /**
     * @dev ONLY OWNER: Initializes AuctionRebalanceExtension to the DelegatedManager.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager) {
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);

        emit AuctionRebalanceExtensionInitialized(address(setToken), address(_delegatedManager));
    }

    /**
     * @dev ONLY OWNER: Initializes AuctionRebalanceExtension to the DelegatedManager and AuctionRebalanceModuleV1 to the SetToken.
     *
     * @param _delegatedManager     Instance of the DelegatedManager to initialize
     */
    function initializeModuleAndExtension(IDelegatedManager _delegatedManager) external onlyOwnerAndValidManager(_delegatedManager){
        require(_delegatedManager.isPendingExtension(address(this)), "Extension must be pending");
        ISetToken setToken = _delegatedManager.setToken();

        _initializeExtension(setToken, _delegatedManager);
        _initializeModule(setToken, _delegatedManager);

        emit AuctionRebalanceExtensionInitialized(address(setToken), address(_delegatedManager));
    }


    /**
     * @dev ONLY MANAGER: Remove an existing SetToken and DelegatedManager tracked by the AuctionRebalanceExtension
     * @dev _removeExtension implements the only manager assertion.
     */
    function removeExtension() external override {
        IDelegatedManager delegatedManager = IDelegatedManager(msg.sender);
        ISetToken setToken = delegatedManager.setToken();

        _removeExtension(setToken, delegatedManager);
    }

    /**
     * @dev OPERATOR ONLY: Checks that the old components array matches the current components array and then invokes the 
     * AuctionRebalanceModuleV1 startRebalance function.
     * 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _quoteAsset                   ERC20 token used as the quote asset in auctions.
     * @param _oldComponents                Addresses of existing components in the SetToken.
     * @param _newComponents                Addresses of new components to be added.
     * @param _newComponentsAuctionParams   AuctionExecutionParams for new components, indexed corresponding to _newComponents.
     * @param _oldComponentsAuctionParams   AuctionExecutionParams for existing components, indexed corresponding to
     *                                      the current component positions. Set to 0 for components being removed.
     * @param _shouldLockSetToken           Indicates if the rebalance should lock the SetToken.
     * @param _rebalanceDuration            Duration of the rebalance in seconds.
     * @param _positionMultiplier           Position multiplier at the time target units were calculated.
     */
    function startRebalance(
        ISetToken _setToken,
        IERC20 _quoteAsset,
        address[] memory _oldComponents,
        address[] memory _newComponents,
        AuctionExecutionParams[] memory _newComponentsAuctionParams,
        AuctionExecutionParams[] memory _oldComponentsAuctionParams,
        bool _shouldLockSetToken,
        uint256 _rebalanceDuration,
        uint256 _positionMultiplier
    )
        external
        virtual
        onlyOperator(_setToken)
    {
        address[] memory currentComponents = _setToken.getComponents();
        
        require(currentComponents.length == _oldComponents.length, "Mismatch: old and current components length");

        for (uint256 i = 0; i < _oldComponents.length; i++) {
            require(currentComponents[i] == _oldComponents[i], "Mismatch: old and current components");
        }

        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.startRebalance.selector,
            _setToken,
            _quoteAsset,
            _newComponents,
            _newComponentsAuctionParams,
            _oldComponentsAuctionParams,
            _shouldLockSetToken,
            _rebalanceDuration,
            _positionMultiplier
        );

        _invokeManager(_manager((_setToken)), address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Unlocks SetToken via AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     * 
     * @param _setToken     Address of the SetToken to unlock.
     */
    function unlock(ISetToken _setToken) external onlyOperator(_setToken) {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.unlock.selector,
            _setToken
        );

        _invokeManager(_manager((_setToken)), address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Sets the target raise percentage for all components on AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _setToken                Address of the SetToken to update unit targets of.
     * @param _raiseTargetPercentage   Amount to raise all component's unit targets by (in precise units)
     */
    function setRaiseTargetPercentage(ISetToken _setToken, uint256 _raiseTargetPercentage) external onlyOperator(_setToken) {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.setRaiseTargetPercentage.selector,
            _setToken,
            _raiseTargetPercentage
        );

        _invokeManager(_manager((_setToken)), address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Updates the bidding permission status for a list of addresses on AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _setToken                Address of the SetToken to rebalance bidder status of. 
     * @param _bidders    An array of addresses whose bidding permission status is to be toggled.
     * @param _statuses   An array of booleans indicating the new bidding permission status for each corresponding address in `_bidders`.
     */
    function setBidderStatus(
        ISetToken _setToken,
        address[] memory _bidders,
        bool[] memory _statuses
    )
        external
        onlyOperator(_setToken)
    {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.setBidderStatus.selector,
            _setToken,
            _bidders,
            _statuses
        );

        _invokeManager(_manager((_setToken)), address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Sets whether anyone can bid on the AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _setToken     Address of the SetToken to update anyone bid status of. 
     * @param _status       A boolean indicating if anyone can bid.
     */
    function setAnyoneBid( ISetToken _setToken, bool _status) external onlyOperator(_setToken) {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.setAnyoneBid.selector,
            _setToken,
            _status
        );

        _invokeManager(_manager((_setToken)), address(auctionModule), callData);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function to initialize AuctionRebalanceModuleV1 on the SetToken associated with the DelegatedManager.
     *
     * @param _setToken             Instance of the SetToken corresponding to the DelegatedManager
     * @param _delegatedManager     Instance of the DelegatedManager to initialize the AuctionRebalanceModuleV1 for
     */
    function _initializeModule(ISetToken _setToken, IDelegatedManager _delegatedManager) internal {
        bytes memory callData = abi.encodeWithSelector(IAuctionRebalanceModuleV1.initialize.selector, _setToken);
        _invokeManager(_delegatedManager, address(auctionModule), callData);
    }

}
