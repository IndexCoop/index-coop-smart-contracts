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
import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IAuctionRebalanceModuleV1 } from "../interfaces/IAuctionRebalanceModuleV1.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import {GlobalAuctionRebalanceExtension} from "./GlobalAuctionRebalanceExtension.sol";

/**
 * @title GlobalOptimisticAuctionRebalanceExtension
 * @author Index Coop
 *
 * @dev Extension contract for interacting with the AuctionRebalanceModuleV1. This contract acts as a pass-through and functions 
 * are only callable by operator. 
 */
contract GlobalOptimisticAuctionRebalanceExtension is  GlobalAuctionRebalanceExtension {
    using AddressArrayUtils for address[];

    /* ============ Events ============ */

    // event AuctionRebalanceExtensionInitialized(
    //     address indexed _setToken,
    //     address indexed _delegatedManager
    // );


    /* ============ Structs ============ */

        struct AuctionExtensionParams {
            IManagerCore managerCore;     // Registry contract for governance approved GlobalExtensions, DelegatedManagerFactories, and DelegatedManagers.
            IAuctionRebalanceModuleV1 auctionModule; // Contract that rebalances index sets via single-asset auctions
        }

        struct OptimisticRebalanceParams{
            address finder;            // Contract that finds UMA contracts on-chain.
            address collateral;        // Collateral currency used to assert proposed transactions.
            uint64  liveness;           // The amount of time to dispute proposed transactions before they can be executed.
            uint256 bondAmount;        // Configured amount of collateral currency to make assertions for proposed transactions.
            bytes32 identifier;        // Identifier used to request price from the DVM.
            address optimisticOracleV3; // Optimistic Oracle V3 contract used to assert proposed transactions.
        }

        struct RebalanceProposal{
            uint256 proposeTime;    // Timestamp of when the proposal was proposed.
            address _setToken;      // Address of the SetToken being rebalanced.
            address _quoteAsset;    // Address of the quote asset used in the rebalance.
            address[] _oldComponents; // Addresses of existing components in the SetToken.
            address[] _newComponents; // Addresses of new components to be added.
            AuctionExecutionParams[]  _newComponentsAuctionParams; // AuctionExecutionParams for new components, indexed corresponding to _newComponents.
            AuctionExecutionParams[]  _oldComponentsAuctionParams; // AuctionExecutionParams for existing components, indexed corresponding to the current component positions. Set to 0 for components being removed.
            bool _shouldLockSetToken; // Indicates if the rebalance should lock the SetToken.
            uint256 _rebalanceDuration; // Duration of the rebalance in seconds.
            uint256 _positionMultiplier; // Position multiplier at the time target units were calculated.
        }

    /* ============ State Variables ============ */
    
    // IAuctionRebalanceModuleV1 public immutable auctionModule;  // AuctionRebalanceModuleV1




    /* ============ Constructor ============ */

    constructor(AuctionExtensionParams memory _auctionParams, OptimisticRebalanceParams memory _optimisticParams) public GlobalAuctionRebalanceExtension(_auctionParams.managerCore, _auctionParams.auctionModule) {
    
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
        onlyOperator(_setToken)
        override
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
}
