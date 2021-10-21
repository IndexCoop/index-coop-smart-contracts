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
 * transform and untransform components and fetch relevent information such as exhcange rates. With this contract, the operator can begin
 * a rebalance by just supplying components and their target unit allocations mesaured in equivelent amounts of the underlying component.
 */
contract IPRebalanceExtension is GIMExtension {
    using AddressArrayUtils for address[];
    using PreciseUnitMath for uint256;
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;

    /* ============ Structs =========== */

    struct TransformInfo {
        address underlyingComponent;
        ITransformHelper transformHelper;
    }

    /* ========== State Variables ========= */

    IAirdropModule public airdropModule;

    mapping(address => TransformInfo) public transformComponentInfo;

    mapping(address => uint256) public rebalanceParams;
    address[] public setComponentList;

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
        uint256 /* _posotionMultiplier */
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
            rebalanceParams[setComponentList[i]] = 0;
        }

        // Save rebalanceParams
        for (uint256 i = 0; i < _setComponents.length; i++) {
            rebalanceParams[_setComponents[i]] = _targetUnitsUnderlying[i];
        }

        setComponentList = _setComponents;
    }

    /**
     * ONLY ALLOWED CALLER: Untransforms components. This function must be called after starting the rebalance, but before beginning the
     * trades through the GeneralIndexModule. The untransformData parameter can be fetched by the rebalance bots by calling getUntransformData
     * on the relevent TransformHelper. If it is the final untransform, it will automatically begin the rebalance through GeneralIndexMoudule.
     *
     * @param _transformComponents      array of components to untransform
     * @param _untransformData          array of untransform data 
     */
    function batchExecuteUntransform(
        address[] memory _transformComponents,
        bytes[] memory _untransformData
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        require(_transformComponents.length == _untransformData.length, "length mismatch");

        _absorbAirdrops(_transformComponents);

        for (uint256 i = 0; i < _transformComponents.length; i++) {
            _executeUntransform(_transformComponents[i], _untransformData[i]);
        }
    }

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
     * @param _transformComponents      array of components to untransform
     * @param _transformData            array of transform data 
     */
    function batchExecuteTransform(
        address[] memory _transformComponents,
        bytes[] memory _transformData
    )
        external
        onlyAllowedCaller(msg.sender)
    {
        require(_transformComponents.length == _transformData.length, "length mismatch");

        _absorbAirdrops(_transformComponents);

        for (uint256 i = 0; i < _transformComponents.length; i++) {
            _executeTransform(_transformComponents[i], _transformData[i], false);
        }
    }

    /* ======== Internal Functions ======== */

    /**
     * Untransforms a component. If it is the final untransform, it will automatically begin the rebalance
     * through GeneralIndexModule.
     */
    function _executeUntransform(address _transformComponent, bytes memory _untransformData) internal {

        TransformInfo memory transformInfo = transformComponentInfo[_transformComponent];

        require(transformInfo.underlyingComponent != address(0), "nothing to untransform");
        require(
            transformInfo.transformHelper.shouldUntransform(transformInfo.underlyingComponent, _transformComponent),
            "untransform unavailable"
        );

        uint256 targetUnitsUnderlying = rebalanceParams[_transformComponent];
        uint256 currentUnits = setToken.getDefaultPositionRealUnit(_transformComponent).toUint256();

        // convert target units from underlying to transformed amounts
        uint256 exchangeRate = transformInfo.transformHelper.getExchangeRate(transformInfo.underlyingComponent, _transformComponent);
        uint256 targetUnitsInTransformed = targetUnitsUnderlying.preciseMul(exchangeRate);
        uint256 unitsToUntransform = currentUnits > targetUnitsInTransformed ? currentUnits.sub(targetUnitsInTransformed) : 0;

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
     * Untransforms a component
     */
    function _executeTransform(address _transformComponent, bytes memory _transformData, bool _transformRemaining) internal {
        require(tradesComplete, "trades not complete");

        TransformInfo memory transformInfo = transformComponentInfo[_transformComponent];

        require(transformInfo.underlyingComponent != address(0), "nothing to transform");
        require(
            transformInfo.transformHelper.shouldTransform(transformInfo.underlyingComponent, _transformComponent),
            "transform unavailable"
        );

        uint256 unitsToTransform;
        uint256 currentRawUnderlying = setToken.getDefaultPositionRealUnit(transformInfo.underlyingComponent).toUint256();

        if (_transformRemaining) {
            unitsToTransform = currentRawUnderlying;
        } else {
            uint256 currentUnits = setToken.getDefaultPositionRealUnit(_transformComponent).toUint256();
            uint256 exchangeRate = transformInfo.transformHelper.getExchangeRate(transformInfo.underlyingComponent, _transformComponent);

            uint256 currentUnitsUnderlying = currentUnits.preciseDiv(exchangeRate);
            uint256 targetUnitsUnderlying = rebalanceParams[_transformComponent];

            unitsToTransform = targetUnitsUnderlying > currentUnitsUnderlying ? targetUnitsUnderlying.sub(currentUnitsUnderlying) : 0;
        }

        require(unitsToTransform > 0, "nothing to transform");

        if (unitsToTransform > currentRawUnderlying) {
            unitsToTransform = currentRawUnderlying;
        }

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
     * remain fixed at their current allocations. For non-transform units, the target units are calculated by taking into
     * account the total amount of the component needed to create the target trasnform units.
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

                uint256 targetUnderlying = rebalanceParams[component];
                int256 diff = finalTotalUnderlyingUnits.toInt256() - currentTotalUnderlyingUnits.toInt256() + targetUnderlying.toInt256();

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
                sum += rebalanceParams[_components[i]];
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