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
pragma experimental ABIEncoderV2;

import {AaveLeverageStrategyExtension} from "./AaveLeverageStrategyExtension.sol";

import {IBaseManager} from "../interfaces/IBaseManager.sol";
import {IPool} from "../interfaces/IPool.sol";
import {IPoolAddressesProvider} from "../interfaces/IPoolAddressesProvider.sol";
import { DataTypes } from "../interfaces/Datatypes.sol";


import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title AaveV3LeverageStrategyExtension
 * @author Index Coop
 *
 * Extension of AaveLeverageStrategyExtension to add endpoint for setting the eMode categoryId
 *
 */
contract AaveV3LeverageStrategyExtension is AaveLeverageStrategyExtension {
    uint8 public currentEModeCategoryId;
    IPoolAddressesProvider public lendingPoolAddressesProvider;
    constructor(
        IBaseManager _manager,
        ContractSettings memory _strategy,
        MethodologySettings memory _methodology,
        ExecutionSettings memory _execution,
        IncentiveSettings memory _incentive,
        string[] memory _exchangeNames,
        ExchangeSettings[] memory _exchangeSettings,
        IPoolAddressesProvider _lendingPoolAddressesProvider

    )
        public
        AaveLeverageStrategyExtension(
            _manager,
            _strategy,
            _methodology,
            _execution,
            _incentive,
            _exchangeNames,
            _exchangeSettings
        )
    {
        lendingPoolAddressesProvider = _lendingPoolAddressesProvider;
    }

    /**
     * OPERATOR ONLY: Set eMode categoryId to new value
     *
     * @param _categoryId    eMode categoryId as defined on aaveV3
     */
    function setEModeCategory(uint8 _categoryId) external onlyOperator {
        currentEModeCategoryId = _categoryId;
        _setEModeCategory(_categoryId);
    }

    function _setEModeCategory(uint8 _categoryId) internal {
        bytes memory setEmodeCallData =
            abi.encodeWithSignature("setEModeCategory(address,uint8)", address(strategy.setToken), _categoryId);
        invokeManager(address(strategy.leverageModule), setEmodeCallData);
    }

    function _calculateMaxBorrowCollateral(ActionInfo memory _actionInfo, bool _isLever) internal override view returns(uint256) {
        
        (uint256 maxLtvRaw, uint256 liquidationThresholdRaw) = _getLtvAndLiquidationThreshold();

        // Normalize LTV and liquidation threshold to precise units. LTV is measured in 4 decimals in Aave which is why we must multiply by 1e14
        // for example ETH has an LTV value of 8000 which represents 80%
        if (_isLever) {
            uint256 netBorrowLimit = _actionInfo.collateralValue
                .preciseMul(maxLtvRaw.mul(10 ** 14))
                .preciseMul(PreciseUnitMath.preciseUnit().sub(execution.unutilizedLeveragePercentage));

            return netBorrowLimit
                .sub(_actionInfo.borrowValue)
                .preciseDiv(_actionInfo.collateralPrice);
        } else {
            uint256 netRepayLimit = _actionInfo.collateralValue
                .preciseMul(liquidationThresholdRaw.mul(10 ** 14));

            return _actionInfo.collateralBalance
                .preciseMul(netRepayLimit.sub(_actionInfo.borrowValue))
                .preciseDiv(netRepayLimit);
        }
    }

    function _getLtvAndLiquidationThreshold() internal view returns(uint256, uint256) {
        if(currentEModeCategoryId != 0 ) {
            // Retrieve collateral factor and liquidation threshold for the collateral asset in precise units (1e16 = 1%)
            DataTypes.EModeCategory memory emodeData = IPool(lendingPoolAddressesProvider.getPool()).getEModeCategoryData(currentEModeCategoryId);
            return (emodeData.ltv, emodeData.liquidationThreshold);
        } else {
            ( , uint256 maxLtvRaw, uint256 liquidationThresholdRaw, , , , , , ,) = strategy.aaveProtocolDataProvider.getReserveConfigurationData(address(strategy.collateralAsset));
            return (maxLtvRaw, liquidationThresholdRaw);
        }

    }

    function _validateNonExchangeSettings(
        MethodologySettings memory _methodology,
        ExecutionSettings memory _execution,
        IncentiveSettings memory _incentive
    )
        internal
        override
        pure
    {
        super._validateNonExchangeSettings(_methodology, _execution, _incentive);
        require(_methodology.targetLeverageRatio >= 1 ether, "Target leverage ratio must be >= 1e18");
    }
}
