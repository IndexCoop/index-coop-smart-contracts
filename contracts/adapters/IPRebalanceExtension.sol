/*
    Copyright 2021 Index Coop.

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
pragma experimental ABIEncoderV2;

import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { BaseExtension } from "../lib/BaseExtension.sol";
import { GIMExtension } from "./GIMExtension.sol";
import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IGeneralIndexModule } from "../interfaces/IGeneralIndexModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ITransformHelper } from "../interfaces/ITransformHelper.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


/**
 * @title IPRebalanceExtension
 * @author Index Coop
 *
 * Manager extension for managing the entire rebalance process for sets that include intrinsic productivity. Utilizes Set Protocol's
 * GeneralIndexModule, WrapModuleV2, AmmModule and AirdropModule with all actions invoked via the BaseManagerV2 contract. Additionally
 * uses helper contracts adhering to the ITransformHelper interface to inform the contract how properly interface with Set Protocol to
 * transform and untransform components and fetch relevent information such as exchange rates. With this contract, the operator can begin
 * a rebalance by just supplying components and their target unit allocations mesaured in equivalent amounts of the underlying component.
 *
 * Since the accounting in this contract is quite difficult, strict terminology is used to refer to components:
 * - transform component: a component that has been transformed from an underlying component
 * - underlying component: the underlying token that corresponds to a transform component
 * - set component: a component that should be included in either the initial or final set state. This can be either a transformed component
 *   or an raw untransformed component (given that the component is never meant to be transformed)
 */
contract IPRebalanceExtension is GIMExtension {
    using AddressArrayUtils for address[];
    using PreciseUnitMath for uint256;
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using SignedSafeMath for int256;

    /* ============ Structs =========== */

    struct TransformInfo {
        address underlyingComponent;        // underlying component address
        uint256 maxTransformSize;           // max transform/untransform size measured in underlying component units
        uint256 minTransformDelay;          // minumum delay between transfroms/untransforms
        ITransformHelper transformHelper;   // TransformHelper contract address
    }

    /* ========== State Variables ========= */

    IAirdropModule public airdropModule;

    // mapping from transform component to TransformInfo
    // can be used to map a transform component to its underlying component
    mapping(address => TransformInfo) public transformComponentInfo;
    // mapping from set component to target units
    mapping(address => uint256) public targetUnitsUnderlying;

    // mapping from transform component to last transform/untransform timestamp
    mapping(address => uint256) public lastTransform;

    // list of all set components involved in rebalance including added/removed components
    address[] public setComponentList;

    // flag marking whether GIM trades have completed
    bool public tradesComplete;

    /* ========== Constructor ========== */

    /**
     * Sets requires state variables
     *
     * @param _manager              BaseManagerV2 manager contract
     * @param _generalIndexModule   Set Protocol GeneralIndexModule
     * @param _airdropModule        Set Protocol AirdropModule
     */
    constructor(
        IBaseManager _manager,
        IGeneralIndexModule _generalIndexModule,
        IAirdropModule _airdropModule
    )
        public
        GIMExtension(_manager, _generalIndexModule)
    {
        airdropModule = _airdropModule;
    }

    /* ======== External Functions ======== */

    /**
     * Original function for starting rebalances from the inherited GIMExtension. This function has been deprecated
     * in favor of startIPRebalance. It will revert when it is called.
     */
    function startRebalanceWithUnits(
        address[] calldata /* _components */,
        uint256[] calldata /* _targetUnitsUnderlying */,
        uint256 /* _positionMultiplier */
    )
        external
        onlyOperator
        override
    {
        revert("use startIPRebalance instead");
    }

    /**
     * ONLY OPERATOR: Sets a TransformInfo entry for a transform component. Each transform component must have a TransformInfo set
     * for it which includes neccessary information such as the underlying component and TransformHelper address. Must not already
     * have been set. If it has, use updateTransformInfo.
     *
     * @param _transformComponent       component that needs to be transformed/untransformed during rebalance
     * @param _transformInfo            TransfomInfo entry for the transform component
     */
    function setTransformInfo(address _transformComponent, TransformInfo memory _transformInfo) external onlyOperator {
        require(
            transformComponentInfo[_transformComponent].underlyingComponent == address(0),
            "TransformInfo already set"
        );
        
        // Maximum transform size is limited to MAX_UINT_96 to prevent overflows when multiplying this maximum size by
        // the transform components exchange rate to get a maximum untransform size. This prevents using MAX_UINT_256 
        // to represent an unlimited amount.
        require(_transformInfo.maxTransformSize <= type(uint96).max, "max transform size must be less than MAX_UINT_96");
        transformComponentInfo[_transformComponent] = _transformInfo;
    }

    /**
     * ONLY OPERATOR: Updates TransformInfo entry for a transform component. Must already have been set before updating. If not,
     * use setTransformInfo.
     *
     * @param _transformComponent       component that needs to be transformed/untransformed during rebalance
     * @param _transformInfo            new TransfomInfo entry for the transform component
     */
    function updateTransformInfo(address _transformComponent, TransformInfo memory _transformInfo) external onlyOperator {
        require(
            transformComponentInfo[_transformComponent].underlyingComponent != address(0),
            "TransformInfo not set yet"
        );

        require(_transformInfo.maxTransformSize <= type(uint96).max, "max transform size must be less than MAX_UINT_96");
        transformComponentInfo[_transformComponent] = _transformInfo;
    }

    /**
     * ONLY OPERATOR: Begins a rebalance. Must supply the set components as well as the target unit allocation for each. If the
     * component is a transform component, then the target units should be measured in the equivalent value of the underlying tokens
     *
     * @param _setComponents            array of components involved in rebalance including components being removed (target units set to 0)
     * @param _targetUnitsUnderlying    array of target units at end of rebalance, maps to same index of _components array
     */
    function startIPRebalance(address[] memory _setComponents, uint256[] memory _targetUnitsUnderlying) external onlyOperator {
        require(_setComponents.length == _targetUnitsUnderlying.length, "length mismatch");
        tradesComplete = false;

        // clear out any current member of rebalanceParams from last rebalance
        for (uint256 i = 0; i < setComponentList.length; i++) {
            targetUnitsUnderlying[setComponentList[i]] = 0;
        }

        // Save rebalanceParams
        for (uint256 i = 0; i < _setComponents.length; i++) {
            targetUnitsUnderlying[_setComponents[i]] = _targetUnitsUnderlying[i];
        }

        setComponentList = _setComponents;
    }

    /**
     * ONLY ALLOWED CALLER: Untransforms components. This function must be called after starting the rebalance, but before calling startTrades.
     * The untransformData parameter can be fetched by the rebalance bots by calling getUntransformData on the relevent TransformHelper.
     *
     * @param _transformComponents      array of components to untransform
     * @param _untransformData          array of untransform data 
     */
    function batchUntransform(
        address[] memory _transformComponents,
        bytes[] memory _untransformData
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        require(_transformComponents.length == _untransformData.length, "length mismatch");

        _absorbAirdrops(_transformComponents);

        for (uint256 i = 0; i < _transformComponents.length; i++) {
            _untransform(_transformComponents[i], _untransformData[i]);
        }
    }

    /**
     * ONLY OPERATOR: Begins the trading portion of the rebalance by initializing the GeneralIndexModule. Must be called after all required
     * components have been untransformed.
     */
    function startTrades() external onlyOperator {
        _startGIMRebalance();
    }

    /**
     * ONLY OPERATOR: Marks the contract as ready to execute transforms. Must be called after trades through GeneralIndexModule have
     * completed.
     */
    function setTradesComplete() external onlyOperator {
        tradesComplete = true;
    }

    /**
     * ONLY ALLOWED CALLER: Transforms components. This function must be called after calling setTradesComplete. The transformData parameter 
     * can be fetched by the rebalance bots by calling getTransformData on the relevent TransformHelper.
     *
     * @param _transformComponents      array of components to transform
     * @param _transformData            array of transform data 
     */
    function batchTransform(
        address[] memory _transformComponents,
        bytes[] memory _transformData
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        require(_transformComponents.length == _transformData.length, "length mismatch");

        _absorbAirdrops(_transformComponents);

        for (uint256 i = 0; i < _transformComponents.length; i++) {
            _transform(_transformComponents[i], _transformData[i], false);
        }
    }

    /**
     * ONLY ALLOWED CALLER: Transforms all remaining units of the underlying component into the transfrorm component. This function should
     * only be called if it is the final transformation for the underlying, and the raw underlying is not an intended component of the final
     * Set composition. The transformData parameter can be fetched by the rebalance bots by calling getTransformData on the relevent
     * TransformHelper.
     *
     * @param _transformComponent       component to transform
     * @param _transformData            transform data
     */
    function transformRemaining(
        address _transformComponent,
        bytes memory _transformData
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        address underlying = transformComponentInfo[_transformComponent].underlyingComponent;
        uint256 underlyingUnitsRaw = targetUnitsUnderlying[underlying];
        require(underlyingUnitsRaw == 0, "raw underlying in target set composition");

        _transform(_transformComponent, _transformData, true);
    }

    /* ======== Internal Functions ======== */

    /**
     * Untransforms a component. If it is the final untransform, it will automatically begin the rebalance
     * through GeneralIndexModule. To prevent losses from untransforms that may incur slippage, a maximum
     * untransform size and minimum untransform delay are enforced. 
     * 
     * To calculate the number of units to untransform use:
     * max(currentUnits - targetUnitsUnderlying * exchangeRate, 0)
     *
     * This calculation ensures that if the target units is greater than the current units then no tokens will
     * be untransformed. If this calculation yields a resulting amount to untransform that is larger than the
     * maximum untransform size, the untransform size will be replaced with this max value. The rest of the
     * transform component can be untransformed in later transactions.
     */
    function _untransform(address _transformComponent, bytes memory _untransformData) internal {

        TransformInfo memory transformInfo = transformComponentInfo[_transformComponent];

        require(transformInfo.minTransformDelay + lastTransform[_transformComponent] < block.timestamp, "delay not elapsed");
        lastTransform[_transformComponent] = block.timestamp;

        require(transformInfo.underlyingComponent != address(0), "nothing to untransform");
        require(
            transformInfo.transformHelper.shouldUntransform(transformInfo.underlyingComponent, _transformComponent),
            "untransform unavailable"
        );

        uint256 targetUnderlying = targetUnitsUnderlying[_transformComponent];
        uint256 currentUnits = setToken.getDefaultPositionRealUnit(_transformComponent).toUint256();

        // convert target units from underlying to transformed amounts
        uint256 exchangeRate = transformInfo.transformHelper.getExchangeRate(transformInfo.underlyingComponent, _transformComponent);
        uint256 targetUnitsInTransformed = targetUnderlying.preciseMul(exchangeRate);
        uint256 unitsToUntransform = currentUnits > targetUnitsInTransformed ? currentUnits.sub(targetUnitsInTransformed) : 0;
        
        uint256 maxUntransformUnits = transformInfo.maxTransformSize.preciseDiv(setToken.totalSupply()).preciseMul(exchangeRate);
        if (unitsToUntransform > maxUntransformUnits) {
            unitsToUntransform = maxUntransformUnits;
        }


        require(unitsToUntransform > 0, "nothing to untransform");

        (address module, bytes memory callData) = transformInfo.transformHelper.getUntransformCall(
            manager.setToken(),
            transformInfo.underlyingComponent,
            _transformComponent,
            unitsToUntransform,
            _untransformData
        );

        invokeManager(module, callData);
    }

    /**
     * Transforms a component. To prevent losses from untransforms that may incur slippage, a maximum transform
     * size and minimum transform delay are enforced. If _transformRemaining is set to true, ignore the calculations
     * described below and simply transform all remaining underlying tokens.
     *
     * To calculate the number of units to transform use:
     * max(targetUnitsUnderlying - currentUnits / exchangeRate, 0)
     *
     * This calculation ensures that if the current units (measured in underlying amounts) is greater than the target
     * underlying units then no tokens will be transformed. If the calculated units to transform are greater than the
     * units of underlying left in the set, just untransform all the units left. This may happen in cases where the exchange
     * rate changes between the time the rebalance was parameterized and the transformation was made. Finally, if the amount
     * to transform is greater than maximum transform amount, the transform size will be replaced with the max value. The rest
     * can be transformed in later transactions.
     * 
     */
    function _transform(address _transformComponent, bytes memory _transformData, bool _transformRemaining) internal {
        require(tradesComplete, "trades not complete");

        TransformInfo memory transformInfo = transformComponentInfo[_transformComponent];

        require(transformInfo.minTransformDelay + lastTransform[_transformComponent] < block.timestamp, "delay not elapsed");
        lastTransform[_transformComponent] = block.timestamp;

        require(transformInfo.underlyingComponent != address(0), "nothing to transform");
        require(
            transformInfo.transformHelper.shouldTransform(transformInfo.underlyingComponent, _transformComponent),
            "transform unavailable"
        );

        uint256 unitsToTransform;
        uint256 currentRawUnderlying = setToken.getDefaultPositionRealUnit(transformInfo.underlyingComponent).toUint256();
        uint256 maxTransformUnits = transformInfo.maxTransformSize.preciseDiv(setToken.totalSupply());

        if (_transformRemaining) {
            require(maxTransformUnits >= currentRawUnderlying, "transform units greater than max");
            unitsToTransform = currentRawUnderlying;
        } else {
            uint256 currentUnits = setToken.getDefaultPositionRealUnit(_transformComponent).toUint256();
            uint256 exchangeRate = transformInfo.transformHelper.getExchangeRate(transformInfo.underlyingComponent, _transformComponent);

            uint256 currentUnitsUnderlying = currentUnits.preciseDiv(exchangeRate);
            uint256 targetUnderlying = targetUnitsUnderlying[_transformComponent];

            unitsToTransform = targetUnderlying > currentUnitsUnderlying ? targetUnderlying.sub(currentUnitsUnderlying) : 0;

            if (unitsToTransform > currentRawUnderlying) {
                unitsToTransform = currentRawUnderlying;
            }
        }

        if (unitsToTransform > maxTransformUnits) {
            unitsToTransform = maxTransformUnits;
        }


        require(unitsToTransform > 0, "nothing to transform");

        (address module, bytes memory callData) = transformInfo.transformHelper.getTransformCall(
            manager.setToken(),
            transformInfo.underlyingComponent,
            _transformComponent,
            unitsToTransform,
            _transformData
        );

        invokeManager(module, callData);
    }

    /**
     * Parameterizes the rebalancing trades through GeneralIndexModule. For all transform components, the target units
     * remain fixed at their current allocations. For non-transform components, the goal is to end up with the correct
     * unit amount to ensure that there is enough underlying to perform all necessary transformations, and to satisfy
     * any units of this raw (untransformed) component being in the set. For example, if DAI, cDAI, and yDAI are all
     * present in the final set, then enough DAI must be purchased to ensure that there is enough raw DAI units after
     * transforming into cDAI and yDAI.
     *
     * For non-transform components, calculate the target units using:
     * max(finalTotalUnderlying - currentTotalUnderlying + targetUnderlyingRaw, 0)
     *
     * Where:
     * - finalTotalUnderlying: The total amount of equivalent underlying units expected in the final set composition.
     *   This only includes underlying units that are implied by the presence of a transform component rather than raw
     *   underlying units that would be present in the final set. For more information on how this value is calculated,
     *   see _getFinalTotalUnderlyingUnits
     * - currentTotalUnderling: The total amount of equivalent underlying units in the current set composition. This
     *   only includes underlying units that are implied by the presence of a transform component rather than raw underlying
     *   units that are present in the set. For more information on how this value is calculated, see _getCurrentTotalUnderlyingUnits
     * - targetUnderlyingRaw: The target units of the raw underlying component present in the final set composition. This does not
     *   include the implied units from the presence of transform components.
     */
    function _startGIMRebalance() internal {
        
        uint256[] memory rebalanceTargets = new uint256[](setComponentList.length);

        for (uint256 i = 0; i < setComponentList.length; i++) {

            address component = setComponentList[i];

            if (_isTransformComponent(component)) {
                rebalanceTargets[i] = setToken.getDefaultPositionRealUnit(component).toUint256();
            } else {

                uint256 finalTotalUnderlyingUnits = _getFinalTotalUnderlyingUnits(component, setComponentList);
                uint256 currentTotalUnderlyingUnits = _getCurrentTotalUnderlyingUnits(component, setComponentList);

                uint256 targetUnderlyingRaw = targetUnitsUnderlying[component];
                int256 diff = finalTotalUnderlyingUnits.toInt256().sub(currentTotalUnderlyingUnits.toInt256()).add(targetUnderlyingRaw.toInt256());

                rebalanceTargets[i] = diff > 0 ? diff.toUint256() : 0;
            }
        }

        (
            address[] memory newComponents,
            uint256[] memory newComponentsTargetUnits,
            uint256[] memory oldComponentsTargetUnits
        ) = _sortNewAndOldComponents(setComponentList, rebalanceTargets);

        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.startRebalance.selector,
            setToken,
            newComponents,
            newComponentsTargetUnits,
            oldComponentsTargetUnits,
            setToken.positionMultiplier()
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * Absorbs all valid airdrops passed into the components parameter. If a component passed in is not a
     * valid airdrop component, ignore it.
     */
    function _absorbAirdrops(address[] memory _components) internal {
        address[] memory airdropTokens = airdropModule.getAirdrops(setToken);
        address[] memory tokensToAbsorb = new address[](_components.length);

        uint256 numTokensToAbsorb = 0;
        // can do this is n*log(n) time using a sort but might not be worth the effort
        for (uint256 i = 0; i < _components.length; i++) {
            if (airdropTokens.contains(_components[i])) {
                tokensToAbsorb[numTokensToAbsorb] = _components[i];
                numTokensToAbsorb++;
            }
        }

        if (numTokensToAbsorb == 0) return;

        address[] memory batchAbsorbTokens = new address[](numTokensToAbsorb);
        for (uint256 i = 0; i < numTokensToAbsorb; i++) {
            batchAbsorbTokens[i] = tokensToAbsorb[i];
        }

        bytes memory callData = abi.encodeWithSelector(airdropModule.batchAbsorb.selector, setToken, batchAbsorbTokens);
        invokeManager(address(airdropModule), callData);
    }

    /**
     * Checks if a component is a valid transform component. This can be done by checking if it has a TransformInfo
     * entry.
     */
    function _isTransformComponent(address _component) internal view returns (bool) {
        return transformComponentInfo[_component].underlyingComponent != address(0);
    }

    /**
     * Gets the total amount of a underlying component in the target set units. This value includes all units present due to
     * a transform component containing it as its underlying. Units from the raw underlying component potentially being a component
     * in the set are ignored.
     */
    function _getFinalTotalUnderlyingUnits(address _underlying, address[] memory _components) internal view returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < _components.length; i++) {
            if (transformComponentInfo[_components[i]].underlyingComponent == _underlying) {
                sum += targetUnitsUnderlying[_components[i]];
            }
        }
        return sum;
    }

    /**
     * Gets the total amount of a underlying component in the current set units. This value includes all units present due to
     * a transform component containing it as its underlying. Units from the raw underlying component potentially being a component
     * in the set are ignored.
     */
    function _getCurrentTotalUnderlyingUnits(address _underlying, address[] memory _components) internal view returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < _components.length; i++) {
            TransformInfo memory transformInfo = transformComponentInfo[_components[i]];
            if (transformInfo.underlyingComponent == _underlying) {
                uint256 exchangeRate = transformInfo.transformHelper.getExchangeRate(_underlying, _components[i]);
                
                uint256 currentUnderlying = setToken.getDefaultPositionRealUnit(_components[i]).toUint256().preciseDiv(exchangeRate);
                sum += currentUnderlying;
            }
        }
        return sum;
    }
}