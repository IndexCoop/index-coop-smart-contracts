/*
    Copyright © 2023 Index Coop

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

import { Math } from "@openzeppelin/contracts/math/Math.sol";

import { AaveLeverageStrategyExtension } from "./AaveLeverageStrategyExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IAaveOracle } from "../interfaces/IAaveOracle.sol";
import { IPool } from "../interfaces/IPool.sol";
import { IPoolAddressesProvider } from "../interfaces/IPoolAddressesProvider.sol";
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

    uint8 public currentEModeCategoryId;  // EMode CategoryId currently set on Aave for the SetToken
    IPoolAddressesProvider public lendingPoolAddressesProvider; // Aave's address registry used to get Pool and Oracle addresses
    bool public overrideNoRebalanceInProgress; // Manager controlled flag that allows bypassing the noRebalanceInProgress modifier

    /* ============ Constructor ============ */

    /**
     * Instantiate addresses, methodology parameters, execution parameters, and incentive parameters.
     *
     * @param _manager                       Address of IBaseManager contract
     * @param _strategy                      Struct of contract addresses
     * @param _methodology                   Struct containing methodology parameters
     * @param _execution                     Struct containing execution parameters
     * @param _incentive                     Struct containing incentive parameters for ripcord
     * @param _exchangeNames                 List of initial exchange names
     * @param _exchangeSettings              List of structs containing exchange parameters for the initial exchanges
     * @param _lendingPoolAddressesProvider  Aave's address registry used to get Pool and Oracle addresses
     */
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

    /* ============ Modifiers ============ */

    /**
     * Throws if rebalance is currently in TWAP` can be overriden by the operator
     */
    modifier noRebalanceInProgress() override {
        if(!overrideNoRebalanceInProgress) {
            require(twapLeverageRatio == 0, "Rebalance is currently in progress");
        }
        _;
    }


    /* ============ External Functions ============ */

    /**
     * OPERATOR ONLY: Enable/Disable override of noRebalanceInProgress modifier
     *
     * @param _overrideNoRebalanceInProgress  Boolean indicating wether to enable / disable override
     */
    function setOverrideNoRebalanceInProgress(bool _overrideNoRebalanceInProgress) external onlyOperator {
        overrideNoRebalanceInProgress = _overrideNoRebalanceInProgress;
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

    /* ============ Internal Functions ============ */

    /**
     * Sets EMode category in AaveV3 on behalf of the SetToken
     */
    function _setEModeCategory(uint8 _categoryId) internal {
        bytes memory setEmodeCallData =
            abi.encodeWithSignature("setEModeCategory(address,uint8)", address(strategy.setToken), _categoryId);
        invokeManager(address(strategy.leverageModule), setEmodeCallData);
    }

    /**
     * Calculate the max borrow / repay amount allowed in base units for lever / delever. This is due to overcollateralization requirements on
     * assets deposited in lending protocols for borrowing.
     *
     */
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

    /**
     * Calculates LTV and LquidationThreshold either based on ReserveConfiguration or EModeCategory depending on wether EMode is enabled or not
     *
     */
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

    /**
     * Validate non-exchange settings in constructor and setters when updating.
     */
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

    /**
     * Derive the min repay units from collateral units for delever. Units are calculated as target collateral rebalance units multiplied by slippage tolerance
     * and pair price (collateral oracle price / borrow oracle price). Output is measured in borrow unit decimals.
     *
     * return uint256           Min position units to repay in borrow asset
     */
    function _calculateMinRepayUnits(uint256 _collateralRebalanceUnits, uint256 _slippageTolerance, ActionInfo memory _actionInfo)
        internal
        override
        pure
        returns(uint256)
    {
        return _collateralRebalanceUnits
            .preciseMul(_actionInfo.collateralPrice)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(_slippageTolerance)) // Changed order of mul / div here
            .preciseDiv(_actionInfo.borrowPrice);
    }

    /**
     * Calculate total notional rebalance quantity and chunked rebalance quantity in collateral units.
     *
     * return uint256          Chunked rebalance notional in collateral units
     * return uint256          Total rebalance notional in collateral units
     */
    function _calculateChunkRebalanceNotional(
        LeverageInfo memory _leverageInfo,
        uint256 _newLeverageRatio,
        bool _isLever
    )
        internal
        view
        override
        returns (uint256, uint256)
    {
        // Calculate absolute value of difference between new and current leverage ratio
        uint256 leverageRatioDifference = _isLever ?
            _newLeverageRatio.sub(_leverageInfo.currentLeverageRatio) :
            _leverageInfo.currentLeverageRatio.sub(_newLeverageRatio);

        uint256 totalRebalanceNotional = leverageRatioDifference
            .preciseMul(_leverageInfo.action.collateralBalance) // Changed order of mul / div here
            .preciseDiv(_leverageInfo.currentLeverageRatio);

        uint256 maxBorrow = _calculateMaxBorrowCollateral(_leverageInfo.action, _isLever);

        uint256 chunkRebalanceNotional = Math.min(Math.min(maxBorrow, totalRebalanceNotional), _leverageInfo.twapMaxTradeSize);

        return (chunkRebalanceNotional, totalRebalanceNotional);
    }

    /**
     * Create the action info struct to be used in internal functions
     *
     * return ActionInfo                Struct containing data used by internal lever and delever functions
     */
    function _createActionInfo() internal view override returns(ActionInfo memory) {
        ActionInfo memory rebalanceInfo;

        // Calculate prices from chainlink. AaveOracle returns prices with 8 decimal places, but we need 36 - underlyingDecimals decimal places.
        // This is so that when the underlying amount is multiplied by the received price, the collateral valuation is normalized to 36 decimals. 
        // To perform this adjustment, we multiply by 10^(36 - 8 - underlyingDecimals)
        rebalanceInfo.collateralPrice = _getAssetPrice(strategy.collateralAsset, strategy.collateralDecimalAdjustment);
        rebalanceInfo.borrowPrice = _getAssetPrice(strategy.borrowAsset, strategy.borrowDecimalAdjustment);

        rebalanceInfo.collateralBalance = strategy.targetCollateralAToken.balanceOf(address(strategy.setToken));
        rebalanceInfo.borrowBalance = strategy.targetBorrowDebtToken.balanceOf(address(strategy.setToken));
        rebalanceInfo.collateralValue = rebalanceInfo.collateralPrice.preciseMul(rebalanceInfo.collateralBalance);
        rebalanceInfo.borrowValue = rebalanceInfo.borrowPrice.preciseMul(rebalanceInfo.borrowBalance);
        rebalanceInfo.setTotalSupply = strategy.setToken.totalSupply();

        return rebalanceInfo;
    }

    /**
     * Gets AssetPrice from AaveOracle and multiplies by decimalAdjustment if necessary
     *
     * return uint256          Asset price normalized to desired number of decimals
     */
    function _getAssetPrice(address _asset, uint256 _decimalAdjustment) internal view returns (uint256) {
        IAaveOracle aaveOracle = IAaveOracle(IPoolAddressesProvider(lendingPoolAddressesProvider).getPriceOracle());
        uint256 rawPrice = aaveOracle.getAssetPrice(_asset);
        return rawPrice.mul(10 ** _decimalAdjustment);
    }

}
