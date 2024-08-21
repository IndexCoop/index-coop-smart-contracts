/*
    Copyright 2024 Index Coop

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
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ISetValuer } from "../interfaces/ISetValuer.sol";
import { IWrapModule } from "../interfaces/IWrapModule.sol";

/**
 * @title TargetWeightWrapExtension
 * @author Index Coop
 * @notice Extension contract that allows designated rebalancers to manage asset weights by wrapping a reserve asset into target assets when the reserve is overweight, 
 * and unwrapping target assets back into the reserve asset when the reserve is underweight. The contract enforces specified weight bounds for each target asset during rebalancing.
 */
contract TargetWeightWrapExtension is BaseExtension, ReentrancyGuard {
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using Math for uint256;
    using Position for uint256;
    using PreciseUnitMath for uint256;

    /* ============ Constants ============== */

    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ Structs ============ */

    struct RebalanceInfo {
        address reserveAsset;        // Address of the reserve asset
        uint256 minReserveWeight;    // Minimum weight of the reserve asset (100% = 1e18)
        uint256 maxReserveWeight;    // Maximum weight of the reserve asset (100% = 1e18)
        address[] targetAssets;      // Array of target assets to wrap into and unwrap from
    }

    struct TargetWeightWrapParams {
        uint256 minTargetWeight;    // Minimum weight of the target asset (100% = 1e18)
        uint256 maxTargetWeight;    // Maximum weight of the target asset (100% = 1e18)
        string wrapAdapterName;     // Name of the wrap adapter to use
    }

    /* ============ Events ============ */

    event AnyoneRebalanceUpdated(bool isAnyoneAllowedToRebalance);
    event TargetsSet(
        address indexed reserveAsset,
        uint256 minReserveWeight,
        uint256 maxReserveWeight,
        address[] targetAssets,
        TargetWeightWrapParams[] executionParams
    );

    /* ========== Immutables ========= */

    ISetToken public immutable setToken;
    IWrapModule public immutable wrapModule;
    ISetValuer public immutable setValuer;

    /* ========== State Variables ========= */

    bool public isRebalancing;
    bool public isAnyoneAllowedToRebalance;

    mapping(address => TargetWeightWrapParams) public executionParams; 
    RebalanceInfo public rebalanceInfo;

    /* ============ Modifiers ============ */

    modifier onlyAllowedRebalancer() {
        _validateOnlyAllowedRebalancer();
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Initializes the extension with the required contracts and parameters.
     * @param _manager Address of Index Manager contract
     * @param _wrapModule Address of WrapModule for wrapping and unwrapping reserve asset
     * @param _setValuer Address of SetValuer for calculating valuations and weights
     * @param _isRebalancing Flag to indicate if rebalancing is initially enabled
     */
    constructor(
        IBaseManager _manager,
        IWrapModule _wrapModule,
        ISetValuer _setValuer,
        bool _isRebalancing
    ) public BaseExtension(_manager) {
        manager = _manager;
        setToken = manager.setToken();
        wrapModule = _wrapModule;
        setValuer = _setValuer;
        isRebalancing = _isRebalancing;
    }

    /* ========== Rebalance Functions ========== */

    /**
     * @notice Wraps units of the reserve asset into the target asset. 
     * @dev Must be called when the reserve asset is overweight, rebalancing is enabled, and the caller is an allowed rebalancer. 
     * Ensures that after wrapping, the target asset does not become overweight and the reserve asset does not become underweight.
     * @param _targetAsset Address of the target asset to wrap into.
     * @param _reserveUnits Units of the reserve asset to wrap.
     */
    function wrap(
        address _targetAsset,
        uint256 _reserveUnits
    )
        external
        nonReentrant
        onlyAllowedRebalancer
    {
        require(isRebalancing, "Rebalancing must be enabled");
        require(rebalanceInfo.targetAssets.contains(_targetAsset), "Target asset must be in rebalance");

        require(getReserveWeight() > rebalanceInfo.maxReserveWeight, "Reserve must be overweight before");

        _wrap(_targetAsset, _reserveUnits);

        (uint256 targetAssetWeight, uint256 reserveWeight) = getTargetAssetAndReserveWeight(_targetAsset);
        require(targetAssetWeight < executionParams[_targetAsset].maxTargetWeight, "Target asset must be not be overweight after");
        require(reserveWeight > rebalanceInfo.minReserveWeight, "Reserve must be not be underweight after");
    }

    /**
     * @notice Unwraps units of the target asset into the reserve asset.
     * @dev Must be called when the reserve asset is underweight, rebalancing is enabled, and the caller is an allowed rebalancer.
     * Ensures that after unwrapping, the target asset does not become underweight and the reserve asset does not become overweight.
     * @param _targetAsset Address of target asset to unwrap from
     * @param _targetUnits Units of target asset to unwrap
     */
    function unwrap(
        address _targetAsset,
        uint256 _targetUnits
    )
        external
        nonReentrant
        onlyAllowedRebalancer
    {
        require(isRebalancing, "Rebalancing must be enabled");
        require(rebalanceInfo.targetAssets.contains(_targetAsset), "Target asset must be in rebalance");

        require(getReserveWeight() < rebalanceInfo.minReserveWeight, "Reserve must be underweight before");

        _unwrap(_targetAsset, _targetUnits);

        (uint256 targetAssetWeight, uint256 reserveWeight) = getTargetAssetAndReserveWeight(_targetAsset);
        require(targetAssetWeight > executionParams[_targetAsset].minTargetWeight, "Target must be not be underweight after");
        require(reserveWeight < rebalanceInfo.maxReserveWeight, "Reserve must be not be overweight after");
    }

    /* ========== Operator Functions ========== */

    /**
     * @notice Sets the reserve asset, target assets, and their associated execution parameters.
     * @dev This function can only be called by the operator.
     * @dev The weights are percentages where 100% equals 1e18.
     * @param _reserveAsset Address of the reserve asset.
     * @param _minReserveWeight Minimum allowable weight of the reserve asset.
     * @param _maxReserveWeight Maximum allowable weight of the reserve asset.
     * @param _targetAssets Array of target asset addresses.
     * @param _executionParams Array of execution parameters corresponding to each target asset.
     */
    function setTargetWeights(
        address _reserveAsset,
        uint256 _minReserveWeight,
        uint256 _maxReserveWeight,
        address[] memory _targetAssets,
        TargetWeightWrapParams[] memory _executionParams
    )
        external
        onlyOperator
    {
        require(_targetAssets.length == _executionParams.length, "Array lengths do not match");

        rebalanceInfo = RebalanceInfo({
            reserveAsset: _reserveAsset,
            minReserveWeight: _minReserveWeight,
            maxReserveWeight: _maxReserveWeight,
            targetAssets: _targetAssets
        });

        for (uint256 i = 0; i < _targetAssets.length; i++) {
            executionParams[_targetAssets[i]] = _executionParams[i];
        }

        emit TargetsSet(_reserveAsset, _minReserveWeight, _maxReserveWeight, _targetAssets, _executionParams);
    }

    /**
     * @notice Initializes the Set Token within the Wrap Module.
     * @dev This function can only be called by the operator.
     */
    function initialize() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(wrapModule.initialize.selector, setToken);
        invokeManager(address(wrapModule), data);
    }

    /* ========== External Getters ========== */

    /**
     * @notice Gets the valuation of the reserve asset.
     * @return reserveValuation The valuation of the reserve asset.
     */
    function getReserveValuation() public view returns(uint256 reserveValuation) {
        reserveValuation = setValuer.calculateComponentValuation(setToken, rebalanceInfo.reserveAsset, rebalanceInfo.reserveAsset);
    }

    /**
     * @notice Gets the valuation of a specific target asset.
     * @param _targetAsset The address of the target asset.
     * @return targetAssetValuation The valuation of the specified target asset.
     */
    function getTargetAssetValuation(address _targetAsset) public view returns(uint256 targetAssetValuation) {
        targetAssetValuation = setValuer.calculateComponentValuation(setToken, _targetAsset, rebalanceInfo.reserveAsset);
    }

    /**
     * @notice Gets the total valuation of the SetToken.
     * @return totalValuation The total valuation of the SetToken.
     */
    function getTotalValuation() public view returns(uint256 totalValuation) {
        totalValuation = setValuer.calculateSetTokenValuation(setToken, rebalanceInfo.reserveAsset);
    }

    /**
     * @notice Gets the weight of the reserve asset relative to the total valuation of the SetToken.
     * @dev The weight is returned as a percentage where 100% equals 1e18.
     * @return reserveWeight The weight of the reserve asset relative to the SetToken's total valuation.
     */
    function getReserveWeight() public view returns(uint256 reserveWeight) {
        uint256 reserveValuation = getReserveValuation();
        uint256 totalValuation = getTotalValuation();
        reserveWeight = reserveValuation.preciseDiv(totalValuation);
    }

    /**
     * @notice Gets the weight of a specific target asset relative to the total valuation of the SetToken.
     * @dev The weight is returned as a percentage where 100% equals 1e18.
     * @param _targetAsset The address of the target asset.
     * @return targetAssetWeight The weight of the specified target asset relative to the SetToken's total valuation.
     */
    function getTargetAssetWeight(address _targetAsset) public view returns(uint256 targetAssetWeight) {
        uint256 targetAssetValuation = getTargetAssetValuation(_targetAsset);
        uint256 totalValuation = getTotalValuation();
        targetAssetWeight = targetAssetValuation.preciseDiv(totalValuation);
    }

    /**
     * @notice Gets the weights of both the target asset and the reserve asset relative to the total valuation of the SetToken.
     * @dev The weights are returned as percentages where 100% equals 1e18.
     * @param _targetAsset The address of the target asset.
     * @return targetAssetWeight The weight of the target asset relative to the SetToken's total valuation.
     * @return reserveWeight The weight of the reserve asset relative to the SetToken's total valuation.
     */
    function getTargetAssetAndReserveWeight(address _targetAsset) public view returns(uint256 targetAssetWeight, uint256 reserveWeight) {
        uint256 targetAssetValuation = getTargetAssetValuation(_targetAsset);
        uint256 reserveValuation = getReserveValuation();
        uint256 totalValuation = getTotalValuation();

        targetAssetWeight = targetAssetValuation.preciseDiv(totalValuation);
        reserveWeight = reserveValuation.preciseDiv(totalValuation);
    }

    /**
     * @notice Gets the list of target assets that can be wrapped into or unwrapped from during rebalancing.
     * @return An array of addresses representing the target assets.
     */
    function getTargetAssets() external view returns(address[] memory) {
        return rebalanceInfo.targetAssets;
    }

    /* ========== Internal Functions ========== */

    /**
     * @notice Wraps the specified units of the reserve asset into the target asset.
     * @param _targetAsset The address of the target asset to wrap into.
     * @param _reserveUnits The amount of the reserve asset to wrap.
     */
    function _wrap(address _targetAsset, uint256 _reserveUnits) internal {
        if (rebalanceInfo.reserveAsset == ETH_ADDRESS) {
            bytes memory data = abi.encodeWithSelector(
                wrapModule.wrapWithEther.selector,
                setToken,
                _targetAsset,
                _reserveUnits,
                executionParams[_targetAsset].wrapAdapterName
            );
            invokeManager(address(wrapModule), data);
        } else {
            bytes memory data = abi.encodeWithSelector(
                wrapModule.wrap.selector,
                setToken,
                rebalanceInfo.reserveAsset,
                _targetAsset,
                _reserveUnits,
                executionParams[_targetAsset].wrapAdapterName
            );
            invokeManager(address(wrapModule), data);
        }
    }

    /**
     * @notice Unwraps the specified units of the target asset into the reserve asset.
     * @param _targetAsset The address of the target asset to unwrap from.
     * @param _targetUnits The amount of the target asset to unwrap.
     */
    function _unwrap(address _targetAsset, uint256 _targetUnits) internal {
        if (rebalanceInfo.reserveAsset == ETH_ADDRESS) {
            bytes memory data = abi.encodeWithSelector(
                wrapModule.unwrapWithEther.selector,
                setToken,
                _targetAsset,
                _targetUnits,
                executionParams[_targetAsset].wrapAdapterName
            );
            invokeManager(address(wrapModule), data);
        } else {
            bytes memory data = abi.encodeWithSelector(
                wrapModule.unwrap.selector,
                setToken,
                rebalanceInfo.reserveAsset,
                _targetAsset,
                _targetUnits,
                executionParams[_targetAsset].wrapAdapterName
            );
            invokeManager(address(wrapModule), data);
        }
    }

    /* ============== Modifier Helpers ===============
     * Internal functions used to reduce bytecode size
     */

    /*
     * Caller must be oeprator if isAnyoneAllowedToRebalance is false
     */
    function _validateOnlyAllowedRebalancer() internal {
        if (!isAnyoneAllowedToRebalance) {
            require(msg.sender == manager.operator(), "Must be operator");
        }
    }
}
