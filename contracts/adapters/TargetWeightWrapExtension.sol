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
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ISetValuer } from "../interfaces/ISetValuer.sol";
import { IWrapModuleV2 } from "../interfaces/IWrapModuleV2.sol";

/**
 * @title TargetWeightWrapExtension
 * @author Index Coop
 * @notice Extension contract for managing asset weights by wrapping a reserve asset into target assets when overweight, 
 * and unwrapping target assets back into the reserve asset when underweight. Enforces weight bounds during rebalancing.
 * @dev Designed for ERC20 reserve assets.
 * @dev Designed for wrap and unwrap operations with minimal slippage.
 */
contract TargetWeightWrapExtension is BaseExtension, ReentrancyGuard {
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using Math for uint256;
    using Position for uint256;
    using PreciseUnitMath for uint256;

    /* ============ Structs ============ */

    struct RebalanceInfo {
        address reserveAsset;        // Address of the reserve asset
        uint256 minReserveWeight;    // Minimum weight of the reserve asset (100% = 1e18)
        uint256 maxReserveWeight;    // Maximum weight of the reserve asset (100% = 1e18)
        address[] targetAssets;      // Array of target assets to wrap/unwrap
    }

    struct TargetWeightWrapParams {
        uint256 minTargetWeight;     // Minimum weight of the target asset (100% = 1e18)
        uint256 maxTargetWeight;     // Maximum weight of the target asset (100% = 1e18)
        string wrapAdapterName;      // Name of the wrap adapter to use
        bytes wrapData;              // Data for wrapping
        bytes unwrapData;            // Data for unwrapping
    }

    /* ============ Events ============ */

    event RebalanceAccessUpdated(bool isRebalanceOpen);
    event TargetsSet(
        address indexed reserveAsset,
        uint256 minReserveWeight,
        uint256 maxReserveWeight,
        address[] targetAssets,
        TargetWeightWrapParams[] executionParams
    );
    event RebalancePaused();
    event WrapModuleUpdated(address indexed wrapModule);
    event SetValuerUpdated(address indexed setValuer);

    /* ========== Immutables ========= */

    ISetToken public immutable setToken;

    /* ========== State Variables ========= */

    IWrapModuleV2 public wrapModule;
    ISetValuer public setValuer;

    // Flag indicating if target weights are set and wrap() and unwrap() can potentially be called 
    bool public isRebalancingActive;
    // Flag indicating if wrap() and unwrap() can be called by anyone or only the operator
    bool public isRebalanceOpen;

    // Mapping of target assets to their target weight wrap() and unwrap() execution parameters
    mapping(address => TargetWeightWrapParams) public executionParams;
    // Reserve asset execution parameters and target assets to rebalance
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
     * @param _wrapModule Address of IWrapModuleV2 for wrapping and unwrapping reserve asset
     * @param _setValuer Address of SetValuer for calculating valuations and weights
     * @param _isRebalanceOpen Flag indicating if anyone can rebalance
     */
    constructor(
        IBaseManager _manager,
        IWrapModuleV2 _wrapModule,
        ISetValuer _setValuer,
        bool _isRebalanceOpen
    ) public BaseExtension(_manager) {
        manager = _manager;
        wrapModule = _wrapModule;
        setValuer = _setValuer;
        isRebalanceOpen = _isRebalanceOpen;

        ISetToken setToken_ = manager.setToken();
        setToken = setToken_;
        _setWrapModule(setToken_, _wrapModule);
        _setSetValuer(setToken_, _setValuer);
    }

    /* ========== Rebalance Functions ========== */

    /**
     * @notice Wraps reserve asset units into the target asset. 
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
        require(isRebalancingActive, "Rebalancing is not active");
        require(rebalanceInfo.targetAssets.contains(_targetAsset), "Invalid target asset");

        bytes memory data = abi.encodeWithSelector(
            wrapModule.wrap.selector,
            setToken,
            rebalanceInfo.reserveAsset,
            _targetAsset,
            _reserveUnits,
            executionParams[_targetAsset].wrapAdapterName,
            executionParams[_targetAsset].wrapData
        );
        invokeManager(address(wrapModule), data);

        (uint256 targetAssetWeight, uint256 reserveWeight) = getTargetAssetAndReserveWeight(_targetAsset);
        require(targetAssetWeight <= executionParams[_targetAsset].maxTargetWeight, "Target asset overweight post-wrap");
        require(reserveWeight >= rebalanceInfo.minReserveWeight, "Reserve asset underweight post-wrap");
    }

    /**
     * @notice Unwraps target asset units into the reserve asset.
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
        require(isRebalancingActive, "Rebalancing is not active");
        require(rebalanceInfo.targetAssets.contains(_targetAsset), "Invalid target asset");
        require(isReserveUnderweight(), "Reserve asset is not underweight");

        bytes memory data = abi.encodeWithSelector(
            wrapModule.unwrap.selector,
            setToken,
            rebalanceInfo.reserveAsset,
            _targetAsset,
            _targetUnits,
            executionParams[_targetAsset].wrapAdapterName,
            executionParams[_targetAsset].unwrapData
        );
        invokeManager(address(wrapModule), data);

        (uint256 targetAssetWeight, uint256 reserveWeight) = getTargetAssetAndReserveWeight(_targetAsset);
        require(targetAssetWeight >= executionParams[_targetAsset].minTargetWeight, "Target asset underweight post-unwrap");
        require(reserveWeight <= rebalanceInfo.maxReserveWeight, "Reserve asset overweight post-unwrap");
    }

    /* ========== Operator Functions ========== */

    /**
     * @notice Sets the reserve asset, target assets, and their associated execution parameters.
     * @dev Only callable by the operator.
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
        require(_targetAssets.length == _executionParams.length, "Mismatched array lengths");
        require(_minReserveWeight <= _maxReserveWeight, "Invalid min reserve weight");
        require(_maxReserveWeight <= PreciseUnitMath.preciseUnit(), "Invalid max reserve weight");

        rebalanceInfo = RebalanceInfo({
            reserveAsset: _reserveAsset,
            minReserveWeight: _minReserveWeight,
            maxReserveWeight: _maxReserveWeight,
            targetAssets: _targetAssets
        });

        for (uint256 i = 0; i < _targetAssets.length; i++) {
            require(_executionParams[i].minTargetWeight <= _executionParams[i].maxTargetWeight, "Invalid min target weight");
            require(_executionParams[i].maxTargetWeight <= PreciseUnitMath.preciseUnit(), "Invalid max target weight");
            executionParams[_targetAssets[i]] = _executionParams[i];
        }

        isRebalancingActive = true;

        emit TargetsSet(_reserveAsset, _minReserveWeight, _maxReserveWeight, _targetAssets, _executionParams);
    }

    /**
     * @notice Pauses rebalancing until targets are reconfigured.
     * @dev Only callable by the operator.
     */
    function pauseRebalance() external onlyOperator {
        isRebalancingActive = false;
        emit RebalancePaused();
    }

    /**
     * @notice Sets the flag to open or restrict rebalancing access through this extension.
     * @dev This function can only be called by the operator.
     * @param _isRebalanceOpen Flag to indicate if rebalancing is open to anyone.
     */
    function setIsRebalanceOpen(bool _isRebalanceOpen) external onlyOperator {
        isRebalanceOpen = _isRebalanceOpen;
        emit RebalanceAccessUpdated(_isRebalanceOpen);
    }

    /**
     * @notice Sets the WrapModule contract used for wrapping and unwrapping assets.
     * @dev This function can only be called by the operator.
     * @param _wrapModule Address of the WrapModuleV2 contract.
     */
    function setWrapModule(IWrapModuleV2 _wrapModule) external onlyOperator {
        _setWrapModule(setToken, _wrapModule);
    }

    /**
     * @notice Sets the SetValuer contract used for calculating valuations and weights.
     * @dev This function can only be called by the operator.
     * @param _setValuer Address of the SetValuer contract.
     */
    function setSetValuer(ISetValuer _setValuer) external onlyOperator {
        _setSetValuer(setToken, _setValuer);
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
        reserveValuation = setToken.isComponent(rebalanceInfo.reserveAsset)
            ? setValuer.calculateComponentValuation(setToken, rebalanceInfo.reserveAsset, rebalanceInfo.reserveAsset)
            : 0;
    }

    /**
     * @notice Gets the valuation of a specific target asset.
     * @param _targetAsset The address of the target asset.
     * @return targetAssetValuation The valuation of the specified target asset.
     */
    function getTargetAssetValuation(address _targetAsset) public view returns(uint256 targetAssetValuation) {
        targetAssetValuation = setToken.isComponent(_targetAsset)
            ? setValuer.calculateComponentValuation(setToken, _targetAsset, rebalanceInfo.reserveAsset)
            : 0;
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
     * @notice Checks if the reserve asset is overweight.
     */
    function isReserveOverweight() public view returns(bool) {
        return getReserveWeight() > rebalanceInfo.maxReserveWeight;
    }

    /**
     * @notice Checks if the reserve asset is underweight.
     */
    function isReserveUnderweight() public view returns(bool) {
        return getReserveWeight() < rebalanceInfo.minReserveWeight;
    }

    /**
     * @notice Checks if the target asset is overweight.
     * @param _targetAsset The address of the target asset.
     */
    function isTargetOverweight(address _targetAsset) public view returns(bool) {
        return getTargetAssetWeight(_targetAsset) > executionParams[_targetAsset].maxTargetWeight;
    }

    /**
     * @notice Checks if the target asset is underweight.
     * @param _targetAsset The address of the target asset.
     */
    function isTargetUnderweight(address _targetAsset) public view returns(bool) {
        return getTargetAssetWeight(_targetAsset) < executionParams[_targetAsset].minTargetWeight;
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
     * Sets the WrapModuleV2 contract used for wrapping and unwrapping assets.
     * @param _setToken Address of the SetToken contract.
     * @param _wrapModule Address of the WrapModuleV2 contract.
     */
    function _setWrapModule(ISetToken _setToken, IWrapModuleV2 _wrapModule) internal {
        require(_setToken.moduleStates(address(_wrapModule)) == ISetToken.ModuleState.PENDING, "WrapModuleV2 not pending");
        wrapModule = _wrapModule;
        emit WrapModuleUpdated(address(_wrapModule));
    }

    /**
     * Sets the SetValuer contract used for calculating valuations and weights.
     * @param _setToken Address of the SetToken contract.
     * @param _setValuer Address of the SetValuer contract.
     */
    function _setSetValuer(ISetToken _setToken, ISetValuer _setValuer) internal {
        require(IController(_setToken.controller()).isResource(address(_setValuer)), "SetValuer not approved by controller");
        setValuer = _setValuer;
        emit SetValuerUpdated(address(_setValuer));
    }

    /* ============== Modifier Helpers ===============
     * Internal functions used to reduce bytecode size
     */

    /*
     * Caller must be oeprator if isRebalanceOpen is false
     */
    function _validateOnlyAllowedRebalancer() internal {
        if (!isRebalanceOpen) {
            require(msg.sender == manager.operator(), "Must be allowed rebalancer");
        }
    }
}
