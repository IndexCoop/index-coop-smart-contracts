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
import { SafeERC20 } from  "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { AncillaryData } from "../lib/AncillaryData.sol";
import { AssetAllowList } from "../lib/AssetAllowList.sol";
import { AuctionRebalanceExtension } from "./AuctionRebalanceExtension.sol";
import { IAuctionRebalanceModuleV1 } from "../interfaces/IAuctionRebalanceModuleV1.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { OptimisticOracleV3Interface } from "../interfaces/OptimisticOracleV3Interface.sol";

/**
 * @title OptimisticAuctionRebalanceExtension
 * @author Index Coop
 *
 * @dev The contract extends `AuctionRebalanceExtension` by adding an optimistic oracle mechanism for validating rules on the proposing and executing of rebalances. 
 * It allows setting product-specific parameters for optimistic rebalancing and includes callback functions for resolved or disputed assertions.
 * @dev Version 1 is characterised by: Optional Asset Whitelist, No Set Token locking, control over rebalance timing via "isOpen" flag
 */
contract OptimisticAuctionRebalanceExtensionV1 is  AuctionRebalanceExtension, AssetAllowList {
    using AddressArrayUtils for address[];
    using SafeERC20 for IERC20;

    /* ============ Events ============ */

    event ProductSettingsUpdated(
        IERC20 indexed setToken,
        address indexed manager,
        OptimisticRebalanceParams optimisticParams,
        string rules
    );

    event RebalanceProposed(
        ISetToken indexed setToken,
        IERC20 indexed quoteAsset,
        address[] oldComponents,
        address[] newComponents,
        AuctionExecutionParams[] newComponentsAuctionParams,
        AuctionExecutionParams[] oldComponentsAuctionParams,
        uint256 rebalanceDuration,
        uint256 positionMultiplier
    );

    event AssertedClaim(
        IERC20 indexed setToken,
        address indexed _assertedBy,
        string rules,
        bytes32 _assertionId,
        bytes _claimData
    );

    event ProposalDeleted(
        bytes32 assertionID, 
        bytes32 indexed proposalHash
    );

    event IsOpenUpdated(
        bool indexed isOpen
    );

    /* ============ Structs ============ */

    struct AuctionExtensionParams {
        IBaseManager baseManager;     // Manager Contract of the set token for which to deploy this extension
        IAuctionRebalanceModuleV1 auctionModule; // Contract that rebalances index sets via single-asset auctions
        bool useAssetAllowlist;     // Bool indicating whether to use asset allow list
        address[] allowedAssets;    // Array of allowed assets
    }

    struct OptimisticRebalanceParams{
        IERC20 collateral;      // Collateral currency used to assert proposed transactions.
        uint64  liveness;       // The amount of time to dispute proposed transactions before they can be executed.
        uint256 bondAmount;     // Configured amount of collateral currency to make assertions for proposed transactions.
        bytes32 identifier;     // Identifier used to request price from the DVM.
        OptimisticOracleV3Interface optimisticOracleV3;     // Optimistic Oracle V3 contract used to assert proposed transactions.
    }

    struct ProductSettings{
        OptimisticRebalanceParams optimisticParams;     // OptimisticRebalanceParams struct containing optimistic rebalance parameters.
        string rules;      // Definition of rules for the product. (including ipfs hash pointing to full rules)
    }

    /* ============ State Variables ============ */
    
    ProductSettings public productSettings;
    mapping(bytes32 => bytes32) public assertionIds; // Maps proposal hashes to assertionIds.
    mapping(bytes32 => bytes32) public assertionIdToProposalHash; // Maps assertionIds to a proposal hash.
    bool public isOpen; // Bool indicating whether the extension is open for proposing rebalances.

    // Keys for assertion claim data.
    bytes public constant PROPOSAL_HASH_KEY = "proposalHash";
    bytes public constant RULES_KEY = "rules";

    /* ============ Constructor ============ */

    /*
      * @dev Initializes the OptimisticAuctionRebalanceExtension with the passed parameters.
      * 
      * @param _auctionParams AuctionExtensionParams struct containing the baseManager and auctionModule addresses.
    */ 
    constructor(
        AuctionExtensionParams memory _auctionParams
    )
        public
        AuctionRebalanceExtension(_auctionParams.baseManager, _auctionParams.auctionModule)
        AssetAllowList(_auctionParams.allowedAssets, _auctionParams.useAssetAllowlist)
    {}

    /* ============ Modifier ============ */

    modifier onlyIfOpen() {
        require(isOpen, "Must be open for rebalancing");
        _;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OPERATOR: Add new asset(s) that can be included as new components in rebalances
     *
     * @param _assets           New asset(s) to add
     */
    function addAllowedAssets(address[] memory _assets) external onlyOperator {
        _addAllowedAssets(_assets);
    }

    /**
     * ONLY OPERATOR: Remove asset(s) so that it/they can't be included as new components in rebalances
     *
     * @param _assets           Asset(s) to remove
     */
    function removeAllowedAssets(address[] memory _assets) external onlyOperator {
        _removeAllowedAssets(_assets);
    }

    /**
     * ONLY OPERATOR: Toggle useAssetAllowlist on and off. When false asset allowlist is ignored
     * when true it is enforced.
     *
     * @param _useAssetAllowlist           Bool indicating whether to use asset allow list
     */
    function updateUseAssetAllowlist(bool _useAssetAllowlist) external onlyOperator {
        _updateUseAssetAllowlist(_useAssetAllowlist);
    }

    /**
     * ONLY OPERATOR: Toggle isOpen on and off. When false the extension is closed for proposing rebalances.
     * when true it is open.
     *
     * @param _isOpen           Bool indicating whether the extension is open for proposing rebalances.
     */
   function updateIsOpen(bool _isOpen) external onlyOperator {
       _updateIsOpen(_isOpen);
    }

    /**
     * @dev OPERATOR ONLY: sets product settings for a given set token
     * @param _optimisticParams OptimisticRebalanceParams struct containing optimistic rebalance parameters.
     * @param _rules string describing the rules of the rebalance (including IPFS hash pointing to full rules)
     */
    function setProductSettings(
        OptimisticRebalanceParams memory _optimisticParams,
        string memory _rules
    )
        external
        onlyOperator
    {
        productSettings = ProductSettings({
            optimisticParams: _optimisticParams,
            rules: _rules
        });

        emit ProductSettingsUpdated(setToken, setToken.manager(), _optimisticParams, _rules);
    }

    /**
     * @dev IF OPEN ONLY: Proposes a rebalance for the SetToken using the Optimistic Oracle V3.
     * 
     * @param _quoteAsset                   ERC20 token used as the quote asset in auctions.
     * @param _oldComponents                Addresses of existing components in the SetToken.
     * @param _newComponents                Addresses of new components to be added.
     * @param _newComponentsAuctionParams   AuctionExecutionParams for new components, indexed corresponding to _newComponents.
     * @param _oldComponentsAuctionParams   AuctionExecutionParams for existing components, indexed corresponding to
     *                                      the current component positions. Set to 0 for components being removed.
     * @param _rebalanceDuration            Duration of the rebalance in seconds.
     * @param _positionMultiplier           Position multiplier at the time target units were calculated.
     */
    function proposeRebalance(
        IERC20 _quoteAsset,
        address[] memory _oldComponents,
        address[] memory _newComponents,
        AuctionExecutionParams[] memory _newComponentsAuctionParams,
        AuctionExecutionParams[] memory _oldComponentsAuctionParams,
        uint256 _rebalanceDuration,
        uint256 _positionMultiplier
    )
        external
        onlyAllowedAssets(_newComponents)
        onlyIfOpen()
    {
        bytes32 proposalHash = keccak256(abi.encode(
            setToken,
            _quoteAsset,
            _oldComponents,
            _newComponents,
            _newComponentsAuctionParams,
            _oldComponentsAuctionParams,
            false, // We don't allow locking the set token in this version
            _rebalanceDuration,
            _positionMultiplier
        ));
        require(assertionIds[proposalHash] == bytes32(0), "Proposal already exists");
        require(bytes(productSettings.rules).length > 0, "Rules not set");
        require(address(productSettings.optimisticParams.optimisticOracleV3) != address(0), "Oracle not set");

        bytes memory claim = _constructClaim(proposalHash, productSettings.rules);
        uint256 totalBond = _pullBond(productSettings.optimisticParams);

        bytes32 assertionId = productSettings.optimisticParams.optimisticOracleV3.assertTruth(
            claim,
            msg.sender,
            address(this),
            address(0),
            productSettings.optimisticParams.liveness,
            productSettings.optimisticParams.collateral,
            totalBond,
            productSettings.optimisticParams.identifier,
            bytes32(0)
        );

        assertionIds[proposalHash] = assertionId;
        assertionIdToProposalHash[assertionId] = proposalHash;

        emit RebalanceProposed( setToken, _quoteAsset, _oldComponents, _newComponents, _newComponentsAuctionParams, _oldComponentsAuctionParams,  _rebalanceDuration, _positionMultiplier);
        emit AssertedClaim(setToken, msg.sender, productSettings.rules, assertionId, claim);
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
     * @param _shouldLockSetToken           Indicates if the rebalance should lock the SetToken. Has to be false in this version
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
        override
        onlyIfOpen()
    {
        bytes32 proposalHash = keccak256(abi.encode(
            setToken,
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
        // Disputed assertions are expected to revert here. Assumption past this point is that there was a valid assertion.
        require(assertionId != bytes32(0), "Proposal hash does not exist");

        _deleteProposal(assertionId);
        
        // There is no need to check the assertion result as this point can be reached only for non-disputed assertions.
        // It is expected that future versions of the Optimistic Oracle will always revert here, 
        // if the assertionId has not been settled and can not currently be settled.
        productSettings.optimisticParams.optimisticOracleV3.settleAndGetAssertionResult(assertionId);

        address[] memory currentComponents = setToken.getComponents();
        
        require(currentComponents.length == _oldComponents.length, "Mismatch: old and current components length");

        for (uint256 i = 0; i < _oldComponents.length; i++) {
            require(currentComponents[i] == _oldComponents[i], "Mismatch: old and current components");
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
        _updateIsOpen(false);
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
        bytes32 proposalHash = assertionIdToProposalHash[_assertionId];

        require(address(productSettings.optimisticParams.optimisticOracleV3) != address(0), "Invalid oracle address");

        // If the sender is the Optimistic Oracle V3, delete the proposal and associated assertionId.
        if (msg.sender == address(productSettings.optimisticParams.optimisticOracleV3)) {
            // Delete the disputed proposal and associated assertionId.
            _deleteProposal(_assertionId);

        } else {
            // If the sender is not the expected Optimistic Oracle V3, check if the expected Oracle has the assertion and if not delete.
            require(proposalHash != bytes32(0), "Invalid proposal hash");
            require(productSettings.optimisticParams.optimisticOracleV3.getAssertion(_assertionId).asserter == address(0), "Oracle has assertion");
            _deleteProposal(_assertionId);
        }
        emit ProposalDeleted(_assertionId, proposalHash);
    }

    /* ============ Internal Functions ============ */

    // Constructs the claim that will be asserted at the Optimistic Oracle V3.
    // @dev Inspired by the equivalent function in the OptimisticGovernor: https://github.com/UMAprotocol/protocol/blob/96cf5be32a3f57ac761f004890dd3466c63e1fa5/packages/core/contracts/optimistic-governor/implementation/OptimisticGovernor.sol#L437
    function _constructClaim(bytes32 proposalHash, string memory rules) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                AncillaryData.appendKeyValueBytes32("", PROPOSAL_HASH_KEY, proposalHash),
                ",",
                RULES_KEY,
                ":\"",
                rules,
                "\""
            );
    }

    /// @notice Delete an existing proposal and associated assertionId.
    /// @dev Internal function that deletes a proposal and associated assertionId.
    /// @param assertionId assertionId of the proposal to delete.
    function _deleteProposal(bytes32 assertionId) internal {
        bytes32 proposalHash = assertionIdToProposalHash[assertionId];
        delete assertionIds[proposalHash];
        delete assertionIdToProposalHash[assertionId];
    }

    /// @notice Pulls the higher of the minimum bond or configured bond amount from the sender.
    /// @dev Internal function to pull the user's bond before asserting a claim.
    /// @param optimisticRebalanceParams optimistic rebalance parameters for the product.
    /// @return Bond amount pulled from the sender.
    function _pullBond(OptimisticRebalanceParams memory optimisticRebalanceParams) internal returns (uint256) {
        uint256 minimumBond = optimisticRebalanceParams.optimisticOracleV3.getMinimumBond(address(optimisticRebalanceParams.collateral));
        uint256 totalBond =  minimumBond > optimisticRebalanceParams.bondAmount ? minimumBond : optimisticRebalanceParams.bondAmount;

        optimisticRebalanceParams.collateral.safeTransferFrom(msg.sender, address(this), totalBond);
        optimisticRebalanceParams.collateral.safeIncreaseAllowance(address(optimisticRebalanceParams.optimisticOracleV3), totalBond);

        return totalBond;
    }

    function _updateIsOpen(bool _isOpen) internal {
        isOpen = _isOpen;
        emit IsOpenUpdated(_isOpen);
    }
}
