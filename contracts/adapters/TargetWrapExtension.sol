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
import { IWrapModule } from "../interfaces/IWrapModule.sol";

/**
 * @title TargetWrapExtension
 * @author Index Coop
 */
contract TargetWrapExtension is BaseExtension, ReentrancyGuard {
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using Math for uint256;
    using Position for uint256;

    /* ============ Constants ============== */

    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ Structs ============ */

    struct RebalanceInfo {
        address quoteAsset;               // Underlying token used to wrap and unwrap into other components
        uint256 positionMultiplier;       // Position multiplier when target units were calculated
        uint256 quoteAssetTargetUnit;     // Target unit of the quote asset
        address[] rebalanceComponents;    // Array of addresses of the component tokens involved in the rebalance
    }

    struct WrapExecutionParams {
        uint256 targetUnit;               // Target unit of the component token
        string wrapAdapterName;           // Wrap adapter name
        bytes wrapAdapterConfigData;      // Wrap adapter config data
    }

    /* ============ Events ============ */

    /**
     * @dev Emitted when anyoneAllowedToRebalance is updated
     * @param isAnyoneAllowedToRebalance  Flag to indicate if anyone can rebalance
     */
    event AnyoneRebalanceUpdated(bool isAnyoneAllowedToRebalance);

    /**
     * @dev Emitted when targets are set using the setTargets() function.
     * @param quoteAsset                  The ERC20 token that is used to wrap and unwrap into other components.
     * @param initialPositionMultiplier   Position multiplier when target units were calculated.
     * @param quoteAssetTargetUnit        Target unit of the quote asset.
     * @param componentsInvolved          Array of addresses of the component tokens involved in the rebalance.
     * @param wrapParameters              Array of WrapExecutionParams structs, containing wrap parameters for each component token.
     */
    event TargetsSet(
        address indexed quoteAsset,
        uint256 initialPositionMultiplier,
        uint256 quoteAssetTargetUnit,
        address[] componentsInvolved,
        WrapExecutionParams[] wrapParameters
    );

    /* ========== Immutables ========= */

    ISetToken public immutable setToken;
    IWrapModule public immutable wrapModule;

    /* ========== State Variables ========= */

    bool public isRebalancing;                  // Flag to indicate if rebalancing is enabled
    bool public isAnyoneAllowedToRebalance;     // Flag to indicate if anyone can rebalance, if false only operator can rebalance

    mapping(address => WrapExecutionParams) public executionParams; 
    RebalanceInfo public rebalanceInfo;

    /* ============ Modifiers ============ */

    modifier onlyAllowedRebalancer() {
        _validateOnlyAllowedRebalancer();
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @param _manager          Address of Index Manager
     * @param _wrapModule       Address of WrapModule
     * @param _isRebalancing    Flag to indicate if rebalancing is enabled
     */
    constructor(
        IBaseManager _manager,
        IWrapModule _wrapModule,
        bool _isRebalancing
    ) public BaseExtension(_manager) {
        manager = _manager;
        setToken = manager.setToken();
        wrapModule = _wrapModule;
        isRebalancing = _isRebalancing;
    }

    /* ========== Operator Functions ========== */

    /**
     * OPERATOR ONLY: Set the wrap targets. 
     * @param _quoteAsset           The ERC20 token that is used to wrap and unwrap into other components.
     * @param _positionMultiplier   Position multiplier when target units were calculated.
     * @param _quoteAssetTargetUnit Target unit of the quote asset.
     * @param _components           Array of addresses of the component tokens involved in the rebalance.
     * @param _wrapParameters       Array of WrapExecutionParams structs, containing wrap parameters for each component token.
     */
    function setTargets(
        address _quoteAsset,
        uint256 _positionMultiplier,
        uint256 _quoteAssetTargetUnit,
        address[] memory _components,
        WrapExecutionParams[] memory _wrapParameters
    )
        external
        onlyOperator
    {
        require(_components.length == _wrapParameters.length, "Array lengths do not match");

        rebalanceInfo = RebalanceInfo({
            quoteAsset: _quoteAsset,
            positionMultiplier: _positionMultiplier,
            quoteAssetTargetUnit: _quoteAssetTargetUnit,
            rebalanceComponents: _components
        });

        for (uint256 i = 0; i < _components.length; i++) {
            executionParams[_components[i]] = _wrapParameters[i];
        }

        emit TargetsSet(_quoteAsset, _positionMultiplier, _quoteAssetTargetUnit, _components, _wrapParameters);
    }

    /**
     * OPERATOR ONLY: Initializes the Set Token on the Wrap Module.
     */
    function initialize() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(wrapModule.initialize.selector, setToken);
        invokeManager(address(wrapModule), data);
    }

    /* ========== Rebalance Functions ========== */

    /**
     * ONLY ALLOWED REBALANCER: Wrap quote asset into component 
     * @param _underlyingToken  address of underlying token
     * @param _wrappedToken     address of wrapped token
     * @param _underlyingUnits  units of underlying to wrap
     */
    function wrap(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits
    )
        external
        nonReentrant
        onlyAllowedRebalancer
    {
        require(isRebalancing, "Rebalancing must be enabled");
        require(_underlyingToken == rebalanceInfo.quoteAsset, "Underlying token must be quote asset");
        require(rebalanceInfo.rebalanceComponents.contains(_wrappedToken), "Wrapped token must be in rebalance components");

        (bool isQuoteAssetUnderweightBefore, uint256 maxQuoteQuantity) = getQuoteAssetRebalanceSizeAndDirection();
        require(!isQuoteAssetUnderweightBefore, "Quote asset must be overweight");
        require(_underlyingUnits <= maxQuoteQuantity, "Must wrap less than or equal to max available quote asset");

        (bool isComponentUnderweightBefore, uint256 maxComponentQuantityBefore) = getRebalanceSizeAndDirection(_wrappedToken);
        require(isComponentUnderweightBefore, "Component be underweight");

        bytes memory data = abi.encodeWithSelector(
            wrapModule.wrap.selector,
            setToken,
            _underlyingToken,
            _wrappedToken,
            _underlyingUnits,
            executionParams[_wrappedToken].wrapAdapterName
        );
        invokeManager(address(wrapModule), data);

        (bool isComponentUnderweightAfter, uint256 maxComponentQuantityAfter) = getRebalanceSizeAndDirection(_wrappedToken);
        if (maxComponentQuantityAfter > 0) {
            require(isComponentUnderweightAfter, "Component must still be underweight if target not met");
            require(maxComponentQuantityAfter < maxComponentQuantityBefore, "Component must be closer to target after wrapping");
        }
    }

    /**
     * ONLY ALLOWED REBALANCER: Wrap quote asset into component with Ether
     * @param _wrappedToken     address of wrapped token
     * @param _underlyingUnits  units of underlying to wrap
     */
    function wrapWithEther(
        address _wrappedToken,
        uint256 _underlyingUnits
    )
        external
        nonReentrant
        onlyAllowedRebalancer
    {
        require(isRebalancing, "Rebalancing must be enabled");
        require(rebalanceInfo.quoteAsset == ETH_ADDRESS, "ETH must be quote asset");
        require(rebalanceInfo.rebalanceComponents.contains(_wrappedToken), "Wrapped token must be in rebalance components");

        (bool isQuoteAssetUnderweightBefore, uint256 maxQuoteQuantity) = getQuoteAssetRebalanceSizeAndDirection();
        require(!isQuoteAssetUnderweightBefore, "Quote asset must be overweight");
        require(_underlyingUnits <= maxQuoteQuantity, "Must wrap less than or equal to max available quote asset");

        (bool isComponentUnderweightBefore, uint256 maxComponentQuantityBefore) = getRebalanceSizeAndDirection(_wrappedToken);
        require(isComponentUnderweightBefore, "Component be underweight");

        bytes memory data = abi.encodeWithSelector(
            wrapModule.wrapWithEther.selector,
            setToken,
            _wrappedToken,
            _underlyingUnits,
            executionParams[_wrappedToken].wrapAdapterName
        );
        invokeManager(address(wrapModule), data);

        (bool isComponentUnderweightAfter, uint256 maxComponentQuantityAfter) = getRebalanceSizeAndDirection(_wrappedToken);
        if (maxComponentQuantityAfter > 0) {
            require(isComponentUnderweightAfter, "Component must still be underweight if target not met");
            require(maxComponentQuantityAfter < maxComponentQuantityBefore, "Component must be closer to target after wrapping");
        }
    }

    /**
     * ONLY ALLOWED REBALANCER: Unwrap component into quote asset
     * @param _underlyingToken  address of underlying token
     * @param _wrappedToken     address of wrapped token
     * @param _wrappedUnits     units of wrapped to unwrap
     */
    function unwrap(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _wrappedUnits
    )
        external
        nonReentrant
        onlyAllowedRebalancer
    {
        require(isRebalancing, "Rebalancing must be enabled");
        require(_underlyingToken == rebalanceInfo.quoteAsset, "Underlying token must be quote asset");
        require(rebalanceInfo.rebalanceComponents.contains(_wrappedToken), "Wrapped token must be in rebalance components");

        (bool isComponentUnderweightBefore, uint256 maxComponentQuantityBefore) = getRebalanceSizeAndDirection(_wrappedToken);
        require(!isComponentUnderweightBefore, "Must be overweight");
        require(_wrappedUnits <= maxComponentQuantityBefore, "Must unwrap less than or equal to quantity");

        bytes memory data = abi.encodeWithSelector(
            wrapModule.unwrap.selector,
            setToken,
            _underlyingToken,
            _wrappedToken,
            _wrappedUnits,
            executionParams[_wrappedToken].wrapAdapterName
        );
        invokeManager(address(wrapModule), data);

        (bool isComponentUnderweightAfter, uint256 maxComponentQuantityAfter) = getRebalanceSizeAndDirection(_wrappedToken);
        if (maxComponentQuantityAfter > 0) {
            require(!isComponentUnderweightAfter, "Component must still be overweight if target not met");
            require(maxComponentQuantityAfter < maxComponentQuantityBefore, "Component must be closer to target after wrapping");
        }
    }

    /**
     * ONLY ALLOWED REBALANCER: Unwrap component into quote asset with Ether
     * @param _wrappedToken     address of wrapped token
     * @param _wrappedUnits     units of wrapped to unwrap
     */
    function unwrapWithEther(
        address _wrappedToken,
        uint256 _wrappedUnits
    )
        external
        nonReentrant
        onlyAllowedRebalancer
    {
        require(isRebalancing, "Rebalancing must be enabled");
        require(rebalanceInfo.quoteAsset == ETH_ADDRESS, "ETH must be quote asset");
        require(rebalanceInfo.rebalanceComponents.contains(_wrappedToken), "Wrapped token must be in rebalance components");

        (bool isComponentUnderweightBefore, uint256 maxComponentQuantityBefore) = getRebalanceSizeAndDirection(_wrappedToken);
        require(!isComponentUnderweightBefore, "Must be overweight");
        require(_wrappedUnits <= maxComponentQuantityBefore, "Must unwrap less than or equal to quantity");

        bytes memory data = abi.encodeWithSelector(
            wrapModule.unwrapWithEther.selector,
            setToken,
            _wrappedToken,
            _wrappedUnits,
            executionParams[_wrappedToken].wrapAdapterName
        );
        invokeManager(address(wrapModule), data);

        (bool isComponentUnderweightAfter, uint256 maxComponentQuantityAfter) = getRebalanceSizeAndDirection(_wrappedToken);
        if (maxComponentQuantityAfter > 0) {
            require(!isComponentUnderweightAfter, "Component must still be overweight if target not met");
            require(maxComponentQuantityAfter < maxComponentQuantityBefore, "Component must be closer to target after wrapping");
        }
    }

    /* ========== External Getters ========== */

    /**
     * Get the rebalance size and direction for the quote asset
     * @return isUnderweight       Indicates if the component is underweight or overweight.
     * @return maxComponentQty     The maximum quantity of the component to be rebalanced.
     */
    function getQuoteAssetRebalanceSizeAndDirection() public view returns (bool isUnderweight, uint256 maxComponentQty) {
        (
            uint256 currentUnit,
            uint256 targetUnit,
            uint256 currentNotional,
            uint256 targetNotional
        ) = _getUnitsAndNotionalAmounts(IERC20(rebalanceInfo.quoteAsset));

        // Ensure that the current unit and target unit are not the same
        require(currentUnit != targetUnit, "Target already met");

        // Determine whether the component is underweight or overweight
        isUnderweight = currentNotional <= targetNotional;

        // Calculate the max quantity of the component to be (un)wrapped.
        maxComponentQty = isUnderweight
            ? targetNotional.sub(currentNotional)
            : currentNotional.sub(targetNotional);
    }

    /**
     * Get the rebalance size and direction for a component
     *
     * @param _wrappedToken        Wrapped token to get rebalance info for
     * @return isUnderweight       Indicates if the component is underweight or overweight.
     * @return maxComponentQty     The maximum quantity of the component to be rebalanced.
     */
    function getRebalanceSizeAndDirection(address _wrappedToken) public view returns (bool isUnderweight, uint256 maxComponentQty) {
        (
            uint256 currentUnit,
            uint256 targetUnit,
            uint256 currentNotional,
            uint256 targetNotional
        ) = _getUnitsAndNotionalAmounts(IERC20(_wrappedToken));

        // Ensure that the current unit and target unit are not the same
        require(currentUnit != targetUnit, "Target already met");

        // Determine whether the component is underweight or overweight
        isUnderweight = currentNotional <= targetNotional;

        // Calculate the max quantity of the component to be (un)wrapped.
        maxComponentQty = isUnderweight
            ? targetNotional.sub(currentNotional)
            : currentNotional.sub(targetNotional);
    }

    function getRebalanceComponents() external view returns(address[] memory) {
        return rebalanceInfo.rebalanceComponents;
    }

    /* ========== Internal Functions ========== */

    /**
     * @dev Retrieves the unit and notional amount values for the current position and target.
     * These are necessary to calculate the rebalance size and direction.
     * @param _component            The component to calculate notional amounts for.
     * @return uint256              Current default position real unit of the component.
     * @return uint256              Normalized unit of the bid target.
     * @return uint256              Current notional amount, based on total notional amount of SetToken default position.
     * @return uint256              Target notional amount, based on total SetToken supply multiplied by targetUnit.
     */
    function _getUnitsAndNotionalAmounts(IERC20 _component)
        internal
        view
        returns (uint256, uint256, uint256, uint256)
    {
        uint256 currentUnit = _getDefaultPositionRealUnit(_component);
        uint256 targetUnit = _getNormalizedTargetUnit(_component);

        uint256 totalSupply = setToken.totalSupply();
        uint256 currentNotionalAmount = totalSupply.getDefaultTotalNotional(currentUnit);
        uint256 targetNotionalAmount = PreciseUnitMath.preciseMulCeil(totalSupply, targetUnit);

        return (currentUnit, targetUnit, currentNotionalAmount, targetNotionalAmount);
    }

    /**
     * @dev Retrieves the SetToken's default position real unit.
     * @param _component       Component to fetch the default position for.
     * @return uint256         Real unit position.
     */
    function _getDefaultPositionRealUnit(
        IERC20 _component
    )
        internal
        view
        returns (uint256)
    {
        return setToken.getDefaultPositionRealUnit(address(_component)).toUint256();
    }

    /**
     * @dev Calculates and retrieves the normalized target unit value for a given component.
     * @param _component       Component whose normalized target unit is required.
     * @return uint256         Normalized target unit of the component.
     */
    function _getNormalizedTargetUnit(
        IERC20 _component
    )
        internal
        view
        returns(uint256)
    {
        // (targetUnit * current position multiplier) / position multiplier at the start of rebalance
        return executionParams[address(_component)]
            .targetUnit
            .mul(setToken.positionMultiplier().toUint256())
            .div(rebalanceInfo.positionMultiplier);
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
