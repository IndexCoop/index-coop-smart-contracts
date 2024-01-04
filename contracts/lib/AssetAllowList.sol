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
import { AddressArrayUtils } from "./AddressArrayUtils.sol";

/**
 * @title AssetAllowList
 * @author Index Coop
 *
 * Abstract contract that allows inheriting contracts to restrict the assets that can be traded to, wrapped to, or claimed
 */
abstract contract AssetAllowList {
    using AddressArrayUtils for address[];

    /* ============ Events ============ */

    event AllowedAssetAdded(
        address indexed _asset
    );

    event AllowedAssetRemoved(
        address indexed _asset
    );

    event UseAssetAllowlistUpdated(
        bool _status
    );

    /* ============ State Variables ============ */

    // Boolean indicating wether to use asset allow list
    bool public useAssetAllowlist;

    // Mapping keeping track of allowed assets
    mapping(address => bool) public assetAllowlist;

    // List of allowed assets
    address[] internal allowedAssets;

    /* ============ Modifiers ============ */

    modifier onlyAllowedAssets(address[] memory _assets) {
        require(
            _areAllowedAssets(_assets),
            "Invalid asset"
        );
        _;
    }

    /* ============ Constructor ============ */

    /**
     * Set state variables and map asset pairs to their oracles
     *
     * @param _allowedAssets           Array of allowed assets 
     * @param _useAssetAllowlist       Bool indicating whether to use asset allow list
     */
    constructor(address[] memory _allowedAssets, bool _useAssetAllowlist) public {
        _addAllowedAssets(_allowedAssets);
        _updateUseAssetAllowlist(_useAssetAllowlist);
    }

    /* ============ External Functions ============ */

    function getAllowedAssets() external view returns(address[] memory) {
        return allowedAssets;
    }

    /* ============ Internal Functions ============ */


    /**
     * Add new assets that can be traded to, wrapped to, or claimed
     *
     * @param _assets           New asset to add
     */
    function _addAllowedAssets(address[] memory _assets) internal {
        for (uint256 i = 0; i < _assets.length; i++) {
            address asset = _assets[i];

            require(!assetAllowlist[asset], "Asset already added");

            allowedAssets.push(asset);

            assetAllowlist[asset] = true;

            emit AllowedAssetAdded(asset);
        }
    }

    /**
     * Remove asset(s) so that it/they can't be traded to, wrapped to, or claimed
     *
     * @param _assets           Asset(s) to remove
     */
    function _removeAllowedAssets(address[] memory _assets) internal {
        for (uint256 i = 0; i < _assets.length; i++) {
            address asset = _assets[i];

            require(assetAllowlist[asset], "Asset not already added");

            allowedAssets.removeStorage(asset);

            assetAllowlist[asset] = false;

            emit AllowedAssetRemoved(asset);
        }
    }

    /**
     * Toggle useAssetAllowlist on and off. When false asset allowlist is ignored
     * when true it is enforced.
     *
     * @param _useAssetAllowlist           Bool indicating whether to use asset allow list
     */
    function _updateUseAssetAllowlist(bool _useAssetAllowlist) internal {
        useAssetAllowlist = _useAssetAllowlist;

        emit UseAssetAllowlistUpdated(_useAssetAllowlist);
    }

    /// @notice Check that all assets in array are allowed to be treated
    /// @dev ca be bypassed by setting the useAssetAllowlist to false (default)
    function _areAllowedAssets(address[] memory _assets) internal view returns(bool) {
        if (!useAssetAllowlist) { return true; }
        for (uint256 i = 0; i < _assets.length; i++) {
            if (!assetAllowlist[_assets[i]]) { return false; }
        }
        return true;
    }
}
