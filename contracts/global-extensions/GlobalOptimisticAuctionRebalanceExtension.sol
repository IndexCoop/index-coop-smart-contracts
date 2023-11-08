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
import {SafeERC20} from  "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";

import { BaseGlobalExtension } from "../lib/BaseGlobalExtension.sol";
import { IAuctionRebalanceModuleV1 } from "../interfaces/IAuctionRebalanceModuleV1.sol";
import { IManagerCore } from "../interfaces/IManagerCore.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IDelegatedManager } from "../interfaces/IDelegatedManager.sol";
import {GlobalAuctionRebalanceExtension} from "./GlobalAuctionRebalanceExtension.sol";
import {AncillaryData } from "../lib/AncillaryData.sol";
import {OptimisticOracleV3Interface} from "../interfaces/OptimisticOracleV3Interface.sol";

/**
 * @title GlobalOptimisticAuctionRebalanceExtension
 * @author Index Coop
 *
 * @dev Extension contract for interacting with the AuctionRebalanceModuleV1. This contract acts as a pass-through and functions 
 * are only callable by operator. 
 */
contract GlobalOptimisticAuctionRebalanceExtension is  GlobalAuctionRebalanceExtension {
    using AddressArrayUtils for address[];
    using SafeERC20 for IERC20;

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
            IERC20 collateral;        // Collateral currency used to assert proposed transactions.
            uint64  liveness;           // The amount of time to dispute proposed transactions before they can be executed.
            uint256 bondAmount;        // Configured amount of collateral currency to make assertions for proposed transactions.
            bytes32 identifier;        // Identifier used to request price from the DVM.
            OptimisticOracleV3Interface optimisticOracleV3; // Optimistic Oracle V3 contract used to assert proposed transactions.
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

        struct ProductSettings{
            OptimisticRebalanceParams optimisticParams;
            bytes32 rulesHash;
        }

    /* ============ State Variables ============ */
    
    // IAuctionRebalanceModuleV1 public immutable auctionModule;  // AuctionRebalanceModuleV1

    mapping (ISetToken=>ProductSettings) public productSettings; // Mapping of quote asset to ProductSettings
    mapping(bytes32 => bytes32) public assertionIds; // Maps proposal hashes to assertionIds.
    mapping(bytes32 => bytes32) public proposalHashes; // Maps assertionIds to proposal hashes.
    mapping (bytes32=>ISetToken) public assertedProducts; // Maps assertionIds to ISetToken

    // Keys for assertion claim data.
    bytes public constant PROPOSAL_HASH_KEY = "proposalHash";
    bytes public constant RULES_KEY = "rulesIPFSHash";


    /* ============ Constructor ============ */

    constructor(AuctionExtensionParams memory _auctionParams) public GlobalAuctionRebalanceExtension(_auctionParams.managerCore, _auctionParams.auctionModule) {
    
    }

    /* ============ External Functions ============ */

    /**
    * @dev OPERATOR ONLY: sets product settings for a given quote asset
    * @param _product Address of the SetToken to set rules and settings for.
    * @param _optimisticParams OptimisticRebalanceParams struct containing optimistic rebalance parameters.
    * @param _rulesHash bytes32 containing the ipfs hash rules for the product.
    */
    function setProductSettings(
        ISetToken _product,
        OptimisticRebalanceParams memory _optimisticParams,
        bytes32 _rulesHash
    )
        external
        onlyOperator(_product)
    {
        productSettings[_product] = ProductSettings({
            optimisticParams: _optimisticParams,
            rulesHash: _rulesHash
        });
    }

     /**
    * @dev OPERATOR ONLY: sets product settings for a given quote asset
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
    function proposeRebalance(
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
    {
        bytes32 proposalHash = keccak256(abi.encode(
            _setToken,
            _quoteAsset,
            _oldComponents,
            _newComponents,
            _newComponentsAuctionParams,
            _oldComponentsAuctionParams,
            _shouldLockSetToken,
            _rebalanceDuration,
            _positionMultiplier
        ));
        ProductSettings memory settings = productSettings[_setToken];

        require(assertionIds[proposalHash] == bytes32(0), "Proposal already exists");
        require(settings.rulesHash != bytes32(""), "Rules not set");
        require(address(settings.optimisticParams.optimisticOracleV3) != address(0), "Oracle not set");


        bytes memory claim = _constructClaim(proposalHash, settings.rulesHash);

  

        
        uint256 minimumBond = settings.optimisticParams.optimisticOracleV3.getMinimumBond(address(settings.optimisticParams.collateral));
        uint256 totalBond =  minimumBond > settings.optimisticParams.bondAmount ? minimumBond : settings.optimisticParams.bondAmount;

        settings.optimisticParams.collateral.safeTransferFrom(msg.sender, address(this), totalBond);
        settings.optimisticParams.collateral.safeIncreaseAllowance(address(settings.optimisticParams.optimisticOracleV3), totalBond);

        bytes32 assertionId = settings.optimisticParams.optimisticOracleV3.assertTruth(
            claim,
            msg.sender,
            address(this),
            address(0),
            settings.optimisticParams.liveness,
            settings.optimisticParams.collateral,
            settings.optimisticParams.bondAmount,
            settings.optimisticParams.identifier,
            bytes32(0)
        );

        assertionIds[proposalHash] = assertionId;
        proposalHashes[assertionId] = proposalHash;

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
        override
    {
        bytes32 proposalHash = keccak256(abi.encode(
            _setToken,
            _quoteAsset,
            _oldComponents,
            _newComponents,
            _newComponentsAuctionParams,
            _oldComponentsAuctionParams,
            _shouldLockSetToken,
            _rebalanceDuration,
            _positionMultiplier
        ));

        bytes32 assertionId = assertionIds[proposalHash];
        require(assertionId != bytes32(0), "Proposal hash does not exist");

        delete assertionIds[proposalHash];
        delete proposalHashes[assertionId];

        ProductSettings memory settings = productSettings[_setToken];
        settings.optimisticParams.optimisticOracleV3.settleAndGetAssertionResult(assertionId);
        
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

     // Constructs the claim that will be asserted at the Optimistic Oracle V3.
    function _constructClaim(bytes32 proposalHash, bytes32 rulesHash) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                AncillaryData.appendKeyValueBytes32("", PROPOSAL_HASH_KEY, proposalHash),
                ",",
                RULES_KEY,
                ":\"",
                rulesHash,
                "\""
            );
    }

    /**
     * @notice Callback function that is called by Optimistic Oracle V3 when an assertion is resolved.
     * @dev This function does nothing and is only here to satisfy the callback recipient interface.
     * @param assertionId The identifier of the assertion that was resolved.
     * @param assertedTruthfully Whether the assertion was resolved as truthful or not.
     */
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external {}

    /**
     * @notice Callback to automatically delete a proposal that was disputed.
     * @param _assertionId the identifier of the disputed assertion.
     */
    function assertionDisputedCallback(bytes32 _assertionId) external {
        bytes32 proposalHash = proposalHashes[_assertionId];
        bytes32 assertionId = assertionIds[proposalHash];

        ProductSettings memory settings = productSettings[assertedProducts[assertionId]];

        require(address(settings.optimisticParams.optimisticOracleV3) != address(0), "Invalid oracle address");


        // If the sender is the Optimistic Oracle V3, delete the proposal and associated assertionId.
        if (msg.sender == address(settings.optimisticParams.optimisticOracleV3)) {
            // Delete the disputed proposal and associated assertionId.
            delete assertionIds[proposalHash];
            delete proposalHashes[assertionId];

        } else {
            // If the sender is not the expected Optimistic Oracle V3, check if the expected Oracle has the assertion and if not delete.
            require(proposalHash != bytes32(0), "Invalid proposal hash");
            require(assertionId != bytes32(0), "Proposal hash does not exist");

            require(settings.optimisticParams.optimisticOracleV3.getAssertion(_assertionId).asserter == address(0), "Oracle has assertion");
            delete assertionIds[proposalHash];
            delete proposalHashes[assertionId];
            delete assertedProducts[assertionId];
        }
    }

}
