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
import { BaseExtension } from "../lib/BaseExtension.sol";
import { IAuctionRebalanceModuleV1 } from "../interfaces/IAuctionRebalanceModuleV1.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title AuctionRebalanceExtension
 * @author Index Coop
 *
 * @dev Extension contract for interacting with the AuctionRebalanceModuleV1. This contract acts as a pass-through and functions 
 * are only callable by operator. 
 */
contract AuctionRebalanceExtension is BaseExtension {
    using AddressArrayUtils for address[];
    using SafeMath for uint256;

    /* ============ Structs ============ */

    struct AuctionExecutionParams {
        uint256 targetUnit;                      // Target quantity of the component in Set, in precise units (10 ** 18).
        string priceAdapterName;                 // Identifier for the price adapter to be used.
        bytes priceAdapterConfigData;            // Encoded data for configuring the chosen price adapter.
    }

    /* ============ State Variables ============ */

    ISetToken public immutable setToken;
    IAuctionRebalanceModuleV1 public immutable auctionModule;  // AuctionRebalanceModuleV1

    /* ============ Constructor ============ */

    constructor(IBaseManager _manager, IAuctionRebalanceModuleV1 _auctionModule) public BaseExtension(_manager) {
        auctionModule = _auctionModule;
        setToken = manager.setToken();
    }

    /* ============ External Functions ============ */

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
        onlyOperator
    {
        address[] memory currentComponents = setToken.getComponents();
        
        require(currentComponents.length == _oldComponents.length, "Old components length must match the current components length.");

        for (uint256 i = 0; i < _oldComponents.length; i++) {
            require(currentComponents[i] == _oldComponents[i], "Input old components array must match the current components array.");
        }

        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.startRebalance.selector,
            setToken,
            _quoteAsset,
            _newComponents,
            _newComponentsAuctionParams,
            _oldComponentsAuctionParams,
            _shouldLockSetToken,
            _rebalanceDuration,
            _positionMultiplier
        );

        invokeManager(address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Unlocks SetToken via AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     */
    function unlock() external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.unlock.selector,
            setToken
        );

        invokeManager(address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Sets the target raise percentage for all components on AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _raiseTargetPercentage   Amount to raise all component's unit targets by (in precise units)
     */
    function setRaiseTargetPercentage(uint256 _raiseTargetPercentage) external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.setRaiseTargetPercentage.selector,
            setToken,
            _raiseTargetPercentage
        );

        invokeManager(address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Updates the bidding permission status for a list of addresses on AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _bidders    An array of addresses whose bidding permission status is to be toggled.
     * @param _statuses   An array of booleans indicating the new bidding permission status for each corresponding address in `_bidders`.
     */
    function setBidderStatus(
        address[] memory _bidders,
        bool[] memory _statuses
    )
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.setBidderStatus.selector,
            setToken,
            _bidders,
            _statuses
        );

        invokeManager(address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Sets whether anyone can bid on the AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     *
     * @param _status   A boolean indicating if anyone can bid.
     */
    function setAnyoneBid(bool _status) external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.setAnyoneBid.selector,
            setToken,
            _status
        );

        invokeManager(address(auctionModule), callData);
    }

    /**
     * @dev OPERATOR ONLY: Initializes the AuctionRebalanceModuleV1. 
     * Refer to AuctionRebalanceModuleV1 for function specific restrictions.
     */
    function initialize() external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IAuctionRebalanceModuleV1.initialize.selector,
            setToken
        );

        invokeManager(address(auctionModule), callData);
    }
}
