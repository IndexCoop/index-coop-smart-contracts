/*
    Copyright 2021 IndexCooperative

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
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IGeneralIndexModule } from "../interfaces/IGeneralIndexModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title GIMExtension
 * @author Set Protocol
 *
 * Smart contract manager extension that acts as a pass-through contract for interacting with GeneralIndexModule.
 * All functions are only callable by operator. startRebalance() on GIM maps to startRebalanceWithUnits on
 * GIMExtension.
 */
contract GIMExtension is BaseExtension {

    using AddressArrayUtils for address[];
    using SafeMath for uint256;

    /* ============ State Variables ============ */

    ISetToken public setToken;
    IGeneralIndexModule public generalIndexModule;  // GIM

    /* ============ Constructor ============ */

    constructor(IBaseManager _manager, IGeneralIndexModule _generalIndexModule) public BaseExtension(_manager) {
        generalIndexModule = _generalIndexModule;
        setToken = manager.setToken();
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OPERATOR: Submits a startRebalance call to GeneralIndexModule. Uses internal function so that this contract can be inherited and
     * custom startRebalance logic can be added on top. Components array is sorted in new and old components arrays in order to conform to
     * startRebalance interface. See GIM for function specific restrictions.
     * @param _components               Array of components involved in rebalance inclusive of components being removed from set (targetUnit = 0)
     * @param _targetUnits              Array of target units at end of rebalance, maps to same index of _components array
     * @param _positionMultiplier       Position multiplier when target units were calculated, needed in order to adjust target units if fees accrued
     */
    function startRebalanceWithUnits(
        address[] calldata _components,
        uint256[] calldata _targetUnits,
        uint256 _positionMultiplier
    )
        external
        onlyOperator
    {
        (
            address[] memory newComponents,
            uint256[] memory newComponentsTargetUnits,
            uint256[] memory oldComponentsTargetUnits
        ) = _sortNewAndOldComponents(_components, _targetUnits);
        _startRebalance(newComponents, newComponentsTargetUnits, oldComponentsTargetUnits, _positionMultiplier);
    }

    /**
     * ONLY OPERATOR: Submits a setTradeMaximums call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _components           Array of components
     * @param _tradeMaximums        Array of trade maximums mapping to correct component
     */
    function setTradeMaximums(
        address[] memory _components,
        uint256[] memory _tradeMaximums
    )
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setTradeMaximums.selector,
            setToken,
            _components,
            _tradeMaximums
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a setExchanges call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _components           Array of components
     * @param _exchangeNames        Array of exchange names mapping to correct component
     */
    function setExchanges(
        address[] memory _components,
        string[] memory _exchangeNames
    )
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setExchanges.selector,
            setToken,
            _components,
            _exchangeNames
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a setCoolOffPeriods call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _components           Array of components
     * @param _coolOffPeriods       Array of cool off periods to correct component
     */
    function setCoolOffPeriods(
        address[] memory _components,
        uint256[] memory _coolOffPeriods
    )
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setCoolOffPeriods.selector,
            setToken,
            _components,
            _coolOffPeriods
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a setExchangeData call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _components           Array of components
     * @param _exchangeData         Array of exchange specific arbitrary bytes data
     */
    function setExchangeData(
        address[] memory _components,
        bytes[] memory _exchangeData
    )
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setExchangeData.selector,
            setToken,
            _components,
            _exchangeData
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a setRaiseTargetPercentage call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _raiseTargetPercentage        Amount to raise all component's unit targets by (in precise units)
     */
    function setRaiseTargetPercentage(uint256 _raiseTargetPercentage) external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setRaiseTargetPercentage.selector,
            setToken,
            _raiseTargetPercentage
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a setTraderStatus call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _traders           Array trader addresses to toggle status
     * @param _statuses          Booleans indicating if matching trader can trade
     */
    function setTraderStatus(
        address[] memory _traders,
        bool[] memory _statuses
    )
        external
        onlyOperator
    {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setTraderStatus.selector,
            setToken,
            _traders,
            _statuses
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a setAnyoneTrade call to GeneralIndexModule. See GIM for function specific restrictions.
     *
     * @param _status          Boolean indicating if anyone can call trade
     */
    function setAnyoneTrade(bool _status) external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.setAnyoneTrade.selector,
            setToken,
            _status
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * ONLY OPERATOR: Submits a initialize call to GeneralIndexModule. See GIM for function specific restrictions.
     */
    function initialize() external onlyOperator {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.initialize.selector,
            setToken
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /* ============ Internal Functions ============ */

    /**
     * Internal function that creates calldata and submits startRebalance call to GeneralIndexModule.
     *
     * @param _newComponents                    Array of new components to add to allocation
     * @param _newComponentsTargetUnits         Array of target units at end of rebalance for new components, maps to same index of _newComponents array
     * @param _oldComponentsTargetUnits         Array of target units at end of rebalance for old component, maps to same index of
     *                                               _setToken.getComponents() array, if component being removed set to 0.
     * @param _positionMultiplier               Position multiplier when target units were calculated, needed in order to adjust target units
     *                                               if fees accrued
     */
    function _startRebalance(
        address[] memory _newComponents,
        uint256[] memory _newComponentsTargetUnits,
        uint256[] memory _oldComponentsTargetUnits,
        uint256 _positionMultiplier
    )
        internal
    {
        bytes memory callData = abi.encodeWithSelector(
            IGeneralIndexModule.startRebalance.selector,
            setToken,
            _newComponents,
            _newComponentsTargetUnits,
            _oldComponentsTargetUnits,
            _positionMultiplier
        );

        invokeManager(address(generalIndexModule), callData);
    }

    /**
     * Internal function that sorts components into old and new components and builds the requisite target unit arrays. Old components target units
     * MUST maintain the order of the components array on the SetToken. The _components array MUST contain an entry for all current components even if
     * component is being removed (targetUnit = 0). This is validated implicitly by calculating the amount of new components that would be added as
     * implied by the array lengths, if more than the expected amount of new components are added then it implies an old component is missing.
     *
     * @param _components          Array of components involved in rebalance inclusive of components being removed from set (targetUnit = 0)
     * @param _targetUnits         Array of target units at end of rebalance, maps to same index of _components array
     */
    function _sortNewAndOldComponents(
        address[] memory _components,
        uint256[] memory _targetUnits
    )
        internal
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        address[] memory currentComponents = setToken.getComponents();

        uint256 currentSetComponentsLength = currentComponents.length;
        uint256 rebalanceComponentsLength = _components.length;

        require(rebalanceComponentsLength >= currentSetComponentsLength, "Components array must be equal or longer than current components");

        // We assume that there is an entry for each old component regardless of if it's 0, so any additional components in the array
        // must be added as a new component. Hence we can declare the length of the new components array as the difference between
        // rebalanceComponentsLength and currentSetComponentsLength
        uint256[] memory oldComponentsTargetUnits = new uint256[](currentSetComponentsLength);
        address[] memory newComponents = new address[](rebalanceComponentsLength.sub(currentSetComponentsLength));
        uint256[] memory newTargetUnits = new uint256[](rebalanceComponentsLength.sub(currentSetComponentsLength));

        uint256 newCounter;     // Count amount of components added to newComponents array to add new components to next index
        for (uint256 i = 0; i < rebalanceComponentsLength; i++) {
            address component = _components[i];
            (uint256 index, bool isIn) = currentComponents.indexOf(component);

            if (isIn) {
                oldComponentsTargetUnits[index] = _targetUnits[i];  // Use index in order to map to correct component in currentComponents array
            } else {
                require(newCounter < newComponents.length, "Unexpected new component added");
                newComponents[newCounter] = component;
                newTargetUnits[newCounter] = _targetUnits[i];
                newCounter = newCounter.add(1);
            }
        }

        return (newComponents, newTargetUnits, oldComponentsTargetUnits);
    }
}