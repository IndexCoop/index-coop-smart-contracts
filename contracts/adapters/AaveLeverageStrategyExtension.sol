/*
    Copyright 2021 Set Labs Inc.

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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IChainlinkAggregatorV3 } from "../interfaces/IChainlinkAggregatorV3.sol";
import { ILeverageModule } from "../interfaces/ILeverageModule.sol";
import { IProtocolDataProvider } from "../interfaces/IProtocolDataProvider.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { StringArrayUtils } from "../lib/StringArrayUtils.sol";


/**
 * @title AaveLeverageStrategyExtension
 * @author Set Protocol
 *
 * Smart contract that enables trustless leverage tokens. This extension is paired with the AaveLeverageModule from Set protocol where module 
 * interactions are invoked via the IBaseManager contract. Any leveraged token can be constructed as long as the collateral and borrow asset 
 * is available on Aave. This extension contract also allows the operator to set an ETH reward to incentivize keepers calling the rebalance
 * function at different leverage thresholds.
 *
 */
contract AaveLeverageStrategyExtension is BaseExtension {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;
    using StringArrayUtils for string[];

    /* ============ Enums ============ */

    enum ShouldRebalance {
        NONE,                   // Indicates no rebalance action can be taken
        REBALANCE,              // Indicates rebalance() function can be successfully called
        ITERATE_REBALANCE,      // Indicates iterateRebalance() function can be successfully called
        RIPCORD                 // Indicates ripcord() function can be successfully called
    }

    /* ============ Structs ============ */

    struct ActionInfo {
        uint256 collateralBalance;                      // Balance of underlying held in Aave in base units (e.g. USDC 10e6)
        uint256 borrowBalance;                          // Balance of underlying borrowed from Aave in base units
        uint256 collateralValue;                        // Valuation in USD adjusted for decimals in precise units (10e18)
        uint256 borrowValue;                            // Valuation in USD adjusted for decimals in precise units (10e18)
        uint256 collateralPrice;                        // Price of collateral in precise units (10e18) from Chainlink
        uint256 borrowPrice;                            // Price of borrow asset in precise units (10e18) from Chainlink
        uint256 setTotalSupply;                         // Total supply of SetToken
    }

     struct LeverageInfo {
        ActionInfo action;
        uint256 currentLeverageRatio;                   // Current leverage ratio of Set
        uint256 slippageTolerance;                      // Allowable percent trade slippage in preciseUnits (1% = 10^16)
        uint256 twapMaxTradeSize;                       // Max trade size in collateral units allowed for rebalance action
        string exchangeName;                            // Exchange to use for trade
    }

    struct ContractSettings {
        ISetToken setToken;                             // Instance of leverage token
        ILeverageModule leverageModule;                 // Instance of Aave leverage module
        IProtocolDataProvider aaveProtocolDataProvider; // Instance of Aave protocol data provider
        IChainlinkAggregatorV3 collateralPriceOracle;   // Chainlink oracle feed that returns prices in 8 decimals for collateral asset
        IChainlinkAggregatorV3 borrowPriceOracle;       // Chainlink oracle feed that returns prices in 8 decimals for borrow asset
        IERC20 targetCollateralAToken;                  // Instance of target collateral aToken asset
        IERC20 targetBorrowDebtToken;                   // Instance of target borrow variable debt token asset
        address collateralAsset;                        // Address of underlying collateral
        address borrowAsset;                            // Address of underlying borrow asset
        uint256 collateralDecimalAdjustment;            // Decimal adjustment for chainlink oracle of the collateral asset. Equal to 28-collateralDecimals (10^18 * 10^18 / 10^decimals / 10^8)
        uint256 borrowDecimalAdjustment;                // Decimal adjustment for chainlink oracle of the borrowing asset. Equal to 28-borrowDecimals (10^18 * 10^18 / 10^decimals / 10^8)
    }

    struct MethodologySettings {
        uint256 targetLeverageRatio;                     // Long term target ratio in precise units (10e18)
        uint256 minLeverageRatio;                        // In precise units (10e18). If current leverage is below, rebalance target is this ratio
        uint256 maxLeverageRatio;                        // In precise units (10e18). If current leverage is above, rebalance target is this ratio
        uint256 recenteringSpeed;                        // % at which to rebalance back to target leverage in precise units (10e18)
        uint256 rebalanceInterval;                       // Period of time required since last rebalance timestamp in seconds
    }

    struct ExecutionSettings {
        uint256 unutilizedLeveragePercentage;            // Percent of max borrow left unutilized in precise units (1% = 10e16)
        uint256 slippageTolerance;                       // % in precise units to price min token receive amount from trade quantities
        uint256 twapCooldownPeriod;                      // Cooldown period required since last trade timestamp in seconds
    }

    struct ExchangeSettings {
        uint256 twapMaxTradeSize;                        // Max trade size in collateral base units
        uint256 exchangeLastTradeTimestamp;              // Timestamp of last trade made with this exchange
        uint256 incentivizedTwapMaxTradeSize;            // Max trade size for incentivized rebalances in collateral base units
        bytes leverExchangeData;                         // Arbitrary exchange data passed into rebalance function for levering up
        bytes deleverExchangeData;                       // Arbitrary exchange data passed into rebalance function for delevering
    }

    struct IncentiveSettings {
        uint256 etherReward;                             // ETH reward for incentivized rebalances
        uint256 incentivizedLeverageRatio;               // Leverage ratio for incentivized rebalances
        uint256 incentivizedSlippageTolerance;           // Slippage tolerance percentage for incentivized rebalances
        uint256 incentivizedTwapCooldownPeriod;          // TWAP cooldown in seconds for incentivized rebalances
    }

    /* ============ Events ============ */

    event Engaged(uint256 _currentLeverageRatio, uint256 _newLeverageRatio, uint256 _chunkRebalanceNotional, uint256 _totalRebalanceNotional);
    event Rebalanced(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        uint256 _chunkRebalanceNotional,
        uint256 _totalRebalanceNotional
    );
    event RebalanceIterated(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        uint256 _chunkRebalanceNotional,
        uint256 _totalRebalanceNotional
    );
    event RipcordCalled(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        uint256 _rebalanceNotional,
        uint256 _etherIncentive
    );
    event Disengaged(uint256 _currentLeverageRatio, uint256 _newLeverageRatio, uint256 _chunkRebalanceNotional, uint256 _totalRebalanceNotional);
    event MethodologySettingsUpdated(
        uint256 _targetLeverageRatio,
        uint256 _minLeverageRatio,
        uint256 _maxLeverageRatio,
        uint256 _recenteringSpeed,
        uint256 _rebalanceInterval
    );
    event ExecutionSettingsUpdated(
        uint256 _unutilizedLeveragePercentage,
        uint256 _twapCooldownPeriod,
        uint256 _slippageTolerance
    );
    event IncentiveSettingsUpdated(
        uint256 _etherReward,
        uint256 _incentivizedLeverageRatio,
        uint256 _incentivizedSlippageTolerance,
        uint256 _incentivizedTwapCooldownPeriod
    );
    event ExchangeUpdated(
        string _exchangeName,
        uint256 twapMaxTradeSize,
        uint256 exchangeLastTradeTimestamp,
        uint256 incentivizedTwapMaxTradeSize,
        bytes leverExchangeData,
        bytes deleverExchangeData
    );
    event ExchangeAdded(
        string _exchangeName,
        uint256 twapMaxTradeSize,
        uint256 exchangeLastTradeTimestamp,
        uint256 incentivizedTwapMaxTradeSize,
        bytes leverExchangeData,
        bytes deleverExchangeData
    );
    event ExchangeRemoved(
        string _exchangeName
    );

    /* ============ Modifiers ============ */

    /**
     * Throws if rebalance is currently in TWAP`
     */
    modifier noRebalanceInProgress() virtual {
        require(twapLeverageRatio == 0, "Rebalance is currently in progress");
        _;
    }

    /* ============ State Variables ============ */

    ContractSettings internal strategy;                             // Struct of contracts used in the strategy (SetToken, price oracles, leverage module etc)
    MethodologySettings internal methodology;                       // Struct containing methodology parameters
    ExecutionSettings internal execution;                           // Struct containing execution parameters
    mapping(string => ExchangeSettings) internal exchangeSettings;  // Mapping from exchange name to exchange settings
    IncentiveSettings internal incentive;                           // Struct containing incentive parameters for ripcord
    string[] public enabledExchanges;                               // Array containing enabled exchanges
    uint256 public twapLeverageRatio;                               // Stored leverage ratio to keep track of target between TWAP rebalances
    uint256 public globalLastTradeTimestamp;                        // Last rebalance timestamp. Current timestamp must be greater than this variable + rebalance interval to rebalance

    /* ============ Constructor ============ */

    /**
     * Instantiate addresses, methodology parameters, execution parameters, and incentive parameters.
     *
     * @param _manager                  Address of IBaseManager contract
     * @param _strategy                 Struct of contract addresses
     * @param _methodology              Struct containing methodology parameters
     * @param _execution                Struct containing execution parameters
     * @param _incentive                Struct containing incentive parameters for ripcord
     * @param _exchangeNames            List of initial exchange names
     * @param _exchangeSettings         List of structs containing exchange parameters for the initial exchanges
     */
    constructor(
        IBaseManager _manager,
        ContractSettings memory _strategy,
        MethodologySettings memory _methodology,
        ExecutionSettings memory _execution,
        IncentiveSettings memory _incentive,
        string[] memory _exchangeNames,
        ExchangeSettings[] memory _exchangeSettings
    )
        public
        BaseExtension(_manager)
    {
        strategy = _strategy;
        methodology = _methodology;
        execution = _execution;
        incentive = _incentive;

        for (uint256 i = 0; i < _exchangeNames.length; i++) {
            _validateExchangeSettings(_exchangeSettings[i]);
            exchangeSettings[_exchangeNames[i]] = _exchangeSettings[i];
            enabledExchanges.push(_exchangeNames[i]);
        }

        _validateNonExchangeSettings(methodology, execution, incentive);
    }

    /* ============ External Functions ============ */

    /**
     * OPERATOR ONLY: Engage to target leverage ratio for the first time. SetToken will borrow debt position from Aave and trade for collateral asset. If target
     * leverage ratio is above max borrow or max trade size, then TWAP is kicked off. To complete engage if TWAP, any valid caller must call iterateRebalance until target
     * is met.
     *
     * @param _exchangeName     the exchange used for trading
     */
    function engage(string memory _exchangeName) external onlyOperator {
        ActionInfo memory engageInfo = _createActionInfo();

        require(engageInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(engageInfo.collateralBalance > 0, "Collateral balance must be > 0");
        require(engageInfo.borrowBalance == 0, "Debt must be 0");

        LeverageInfo memory leverageInfo = LeverageInfo({
            action: engageInfo,
            currentLeverageRatio: PreciseUnitMath.preciseUnit(), // 1x leverage in precise units
            slippageTolerance: execution.slippageTolerance,
            twapMaxTradeSize: exchangeSettings[_exchangeName].twapMaxTradeSize,
            exchangeName: _exchangeName
        });

        // Calculate total rebalance units and kick off TWAP if above max borrow or max trade size
        (
            uint256 chunkRebalanceNotional,
            uint256 totalRebalanceNotional
        ) = _calculateChunkRebalanceNotional(leverageInfo, methodology.targetLeverageRatio, true);

        _lever(leverageInfo, chunkRebalanceNotional);

        _updateRebalanceState(
            chunkRebalanceNotional,
            totalRebalanceNotional,
            methodology.targetLeverageRatio,
            _exchangeName
        );

        emit Engaged(
            leverageInfo.currentLeverageRatio,
            methodology.targetLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional
        );
    }

    /**
     * ONLY EOA AND ALLOWED CALLER: Rebalance product. If current leverage ratio is between the max and min bounds, then rebalance 
     * can only be called once the rebalance interval has elapsed since last timestamp. If outside the max and min, rebalance can be called anytime to bring leverage
     * ratio back to the max or min bounds. The methodology will determine whether to delever or lever.
     *
     * Note: If the calculated current leverage ratio is above the incentivized leverage ratio or in TWAP then rebalance cannot be called. Instead, you must call
     * ripcord() which is incentivized with a reward in Ether or iterateRebalance().
     *
     * @param _exchangeName     the exchange used for trading
     */
     function rebalance(string memory _exchangeName) external onlyEOA onlyAllowedCaller(msg.sender) {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(
            execution.slippageTolerance,
            exchangeSettings[_exchangeName].twapMaxTradeSize,
            _exchangeName
        );

        // use globalLastTradeTimestamps to prevent multiple rebalances being called with different exchanges during the epoch rebalance
        _validateNormalRebalance(leverageInfo, methodology.rebalanceInterval, globalLastTradeTimestamp);
        _validateNonTWAP();

        uint256 newLeverageRatio = _calculateNewLeverageRatio(leverageInfo.currentLeverageRatio);

        (
            uint256 chunkRebalanceNotional,
            uint256 totalRebalanceNotional
        ) = _handleRebalance(leverageInfo, newLeverageRatio);

        _updateRebalanceState(chunkRebalanceNotional, totalRebalanceNotional, newLeverageRatio, _exchangeName);

        emit Rebalanced(
            leverageInfo.currentLeverageRatio,
            newLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional
        );
    }

    /**
     * ONLY EOA AND ALLOWED CALLER: Iterate a rebalance when in TWAP. TWAP cooldown period must have elapsed. If price moves advantageously, then exit without rebalancing
     * and clear TWAP state. This function can only be called when below incentivized leverage ratio and in TWAP state.
     *
     * @param _exchangeName     the exchange used for trading
     */
    function iterateRebalance(string memory _exchangeName) external onlyEOA onlyAllowedCaller(msg.sender) {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(
            execution.slippageTolerance,
            exchangeSettings[_exchangeName].twapMaxTradeSize,
            _exchangeName
        );

        // Use the exchangeLastTradeTimestamp since cooldown periods are measured on a per-exchange basis, allowing it to rebalance multiple time in quick
        // succession with different exchanges
        _validateNormalRebalance(leverageInfo, execution.twapCooldownPeriod, exchangeSettings[_exchangeName].exchangeLastTradeTimestamp);
        _validateTWAP();

        uint256 chunkRebalanceNotional;
        uint256 totalRebalanceNotional;
        if (!_isAdvantageousTWAP(leverageInfo.currentLeverageRatio)) {
            (chunkRebalanceNotional, totalRebalanceNotional) = _handleRebalance(leverageInfo, twapLeverageRatio);
        }

        // If not advantageous, then rebalance is skipped and chunk and total rebalance notional are both 0, which means TWAP state is
        // cleared
        _updateIterateState(chunkRebalanceNotional, totalRebalanceNotional, _exchangeName);

        emit RebalanceIterated(
            leverageInfo.currentLeverageRatio,
            twapLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional
        );
    }

    /**
     * ONLY EOA: In case the current leverage ratio exceeds the incentivized leverage threshold, the ripcord function can be called by anyone to return leverage ratio
     * back to the max leverage ratio. This function typically would only be called during times of high downside volatility and / or normal keeper malfunctions. The caller
     * of ripcord() will receive a reward in Ether. The ripcord function uses it's own TWAP cooldown period, slippage tolerance and TWAP max trade size which are typically
     * looser than in regular rebalances.
     *
     * @param _exchangeName     the exchange used for trading
     */
    function ripcord(string memory _exchangeName) external onlyEOA {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(
            incentive.incentivizedSlippageTolerance,
            exchangeSettings[_exchangeName].incentivizedTwapMaxTradeSize,
            _exchangeName
        );

        // Use the exchangeLastTradeTimestamp so it can ripcord quickly with multiple exchanges
        _validateRipcord(leverageInfo, exchangeSettings[_exchangeName].exchangeLastTradeTimestamp);

        ( uint256 chunkRebalanceNotional, ) = _calculateChunkRebalanceNotional(leverageInfo, methodology.maxLeverageRatio, false);

        _delever(leverageInfo, chunkRebalanceNotional);

        _updateRipcordState(_exchangeName);

        uint256 etherTransferred = _transferEtherRewardToCaller(incentive.etherReward);

        emit RipcordCalled(
            leverageInfo.currentLeverageRatio,
            methodology.maxLeverageRatio,
            chunkRebalanceNotional,
            etherTransferred
        );
    }

    /**
     * OPERATOR ONLY: Return leverage ratio to 1x and delever to repay loan. This can be used for upgrading or shutting down the strategy. SetToken will redeem
     * collateral position and trade for debt position to repay Aave. If the chunk rebalance size is less than the total notional size, then this function will
     * delever and repay entire borrow balance on Aave. If chunk rebalance size is above max borrow or max trade size, then operator must
     * continue to call this function to complete repayment of loan. The function iterateRebalance will not work.
     *
     * Note: Delever to 0 will likely result in additional units of the borrow asset added as equity on the SetToken due to oracle price / market price mismatch
     *
     * @param _exchangeName     the exchange used for trading
     */
    function disengage(string memory _exchangeName) external onlyOperator {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(
            execution.slippageTolerance,
            exchangeSettings[_exchangeName].twapMaxTradeSize,
            _exchangeName
        );

        uint256 newLeverageRatio = PreciseUnitMath.preciseUnit();

        (
            uint256 chunkRebalanceNotional,
            uint256 totalRebalanceNotional
        ) = _calculateChunkRebalanceNotional(leverageInfo, newLeverageRatio, false);

        if (totalRebalanceNotional > chunkRebalanceNotional) {
            _delever(leverageInfo, chunkRebalanceNotional);
        } else {
            _deleverToZeroBorrowBalance(leverageInfo, totalRebalanceNotional);
        }

        emit Disengaged(
            leverageInfo.currentLeverageRatio,
            newLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional
        );
    }

    /**
     * OPERATOR ONLY: Set methodology settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newMethodologySettings          Struct containing methodology parameters
     */
    function setMethodologySettings(MethodologySettings memory _newMethodologySettings) external onlyOperator noRebalanceInProgress {
        methodology = _newMethodologySettings;

        _validateNonExchangeSettings(methodology, execution, incentive);

        emit MethodologySettingsUpdated(
            methodology.targetLeverageRatio,
            methodology.minLeverageRatio,
            methodology.maxLeverageRatio,
            methodology.recenteringSpeed,
            methodology.rebalanceInterval
        );
    }

    /**
     * OPERATOR ONLY: Set execution settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newExecutionSettings          Struct containing execution parameters
     */
    function setExecutionSettings(ExecutionSettings memory _newExecutionSettings) external onlyOperator noRebalanceInProgress {
        execution = _newExecutionSettings;

        _validateNonExchangeSettings(methodology, execution, incentive);

        emit ExecutionSettingsUpdated(
            execution.unutilizedLeveragePercentage,
            execution.twapCooldownPeriod,
            execution.slippageTolerance
        );
    }

    /**
     * OPERATOR ONLY: Set incentive settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newIncentiveSettings          Struct containing incentive parameters
     */
    function setIncentiveSettings(IncentiveSettings memory _newIncentiveSettings) external onlyOperator noRebalanceInProgress {
        incentive = _newIncentiveSettings;

        _validateNonExchangeSettings(methodology, execution, incentive);

        emit IncentiveSettingsUpdated(
            incentive.etherReward,
            incentive.incentivizedLeverageRatio,
            incentive.incentivizedSlippageTolerance,
            incentive.incentivizedTwapCooldownPeriod
        );
    }

    /**
     * OPERATOR ONLY: Add a new enabled exchange for trading during rebalances. New exchanges will have their exchangeLastTradeTimestamp set to 0. Adding
     * exchanges during rebalances is allowed, as it is not possible to enter an unexpected state while doing so.
     *
     * @param _exchangeName         Name of the exchange
     * @param _exchangeSettings     Struct containing exchange parameters
     */
    function addEnabledExchange(
        string memory _exchangeName,
        ExchangeSettings memory _exchangeSettings
    )
        external
        onlyOperator
    {
        require(exchangeSettings[_exchangeName].twapMaxTradeSize == 0, "Exchange already enabled");
        _validateExchangeSettings(_exchangeSettings);

        exchangeSettings[_exchangeName].twapMaxTradeSize = _exchangeSettings.twapMaxTradeSize;
        exchangeSettings[_exchangeName].incentivizedTwapMaxTradeSize = _exchangeSettings.incentivizedTwapMaxTradeSize;
        exchangeSettings[_exchangeName].leverExchangeData = _exchangeSettings.leverExchangeData;
        exchangeSettings[_exchangeName].deleverExchangeData = _exchangeSettings.deleverExchangeData;
        exchangeSettings[_exchangeName].exchangeLastTradeTimestamp = 0;

        enabledExchanges.push(_exchangeName);

        emit ExchangeAdded(
            _exchangeName,
            _exchangeSettings.twapMaxTradeSize,
            _exchangeSettings.exchangeLastTradeTimestamp,
            _exchangeSettings.incentivizedTwapMaxTradeSize,
            _exchangeSettings.leverExchangeData,
            _exchangeSettings.deleverExchangeData
        );
    }

    /**
     * OPERATOR ONLY: Removes an exchange. Reverts if the exchange is not already enabled. Removing exchanges during rebalances is allowed,
     * as it is not possible to enter an unexpected state while doing so.
     *
     * @param _exchangeName     Name of exchange to remove
     */
    function removeEnabledExchange(string memory _exchangeName) external onlyOperator {
        require(exchangeSettings[_exchangeName].twapMaxTradeSize != 0, "Exchange not enabled");

        delete exchangeSettings[_exchangeName];
        enabledExchanges.removeStorage(_exchangeName);

        emit ExchangeRemoved(_exchangeName);
    }

    /**
     * OPERATOR ONLY: Updates the settings of an exchange. Reverts if exchange is not already added. When updating an exchange, exchangeLastTradeTimestamp
     * is preserved. Updating exchanges during rebalances is allowed, as it is not possible to enter an unexpected state while doing so. Note: Need to
     * pass in all existing parameters even if only changing a few settings.
     *
     * @param _exchangeName         Name of the exchange
     * @param _exchangeSettings     Struct containing exchange parameters
     */
    function updateEnabledExchange(
        string memory _exchangeName,
        ExchangeSettings memory _exchangeSettings
    )
        external
        onlyOperator
    {
        require(exchangeSettings[_exchangeName].twapMaxTradeSize != 0, "Exchange not enabled");
        _validateExchangeSettings(_exchangeSettings);

        exchangeSettings[_exchangeName].twapMaxTradeSize = _exchangeSettings.twapMaxTradeSize;
        exchangeSettings[_exchangeName].incentivizedTwapMaxTradeSize = _exchangeSettings.incentivizedTwapMaxTradeSize;
        exchangeSettings[_exchangeName].leverExchangeData = _exchangeSettings.leverExchangeData;
        exchangeSettings[_exchangeName].deleverExchangeData = _exchangeSettings.deleverExchangeData;

        emit ExchangeUpdated(
            _exchangeName,
            _exchangeSettings.twapMaxTradeSize,
            _exchangeSettings.exchangeLastTradeTimestamp,
            _exchangeSettings.incentivizedTwapMaxTradeSize,
            _exchangeSettings.leverExchangeData,
            _exchangeSettings.deleverExchangeData
        );
    }

    /**
     * OPERATOR ONLY: Withdraw entire balance of ETH in this contract to operator. Rebalance must not be in progress
     */
    function withdrawEtherBalance() external onlyOperator noRebalanceInProgress {
        msg.sender.transfer(address(this).balance);
    }

    receive() external payable {}

    /* ============ External Getter Functions ============ */

    /**
     * Get current leverage ratio. Current leverage ratio is defined as the USD value of the collateral divided by the USD value of the SetToken. Prices for collateral
     * and borrow asset are retrieved from the Chainlink Price Oracle.
     *
     * return currentLeverageRatio         Current leverage ratio in precise units (10e18)
     */
    function getCurrentLeverageRatio() public view returns(uint256) {
        ActionInfo memory currentLeverageInfo = _createActionInfo();

        return _calculateCurrentLeverageRatio(currentLeverageInfo.collateralValue, currentLeverageInfo.borrowValue);
    }

    /**
     * Calculates the chunk rebalance size. This can be used by external contracts and keeper bots to calculate the optimal exchange to rebalance with.
     * Note: this function does not take into account timestamps, so it may return a nonzero value even when shouldRebalance would return ShouldRebalance.NONE for
     * all exchanges (since minimum delays have not elapsed)
     *
     * @param _exchangeNames    Array of exchange names to get rebalance sizes for
     *
     * @return sizes            Array of total notional chunk size. Measured in the asset that would be sold
     * @return sellAsset        Asset that would be sold during a rebalance
     * @return buyAsset         Asset that would be purchased during a rebalance
     */
    function getChunkRebalanceNotional(
        string[] calldata _exchangeNames
    )
        external
        view
        returns(uint256[] memory sizes, address sellAsset, address buyAsset)
    {

        uint256 newLeverageRatio;
        uint256 currentLeverageRatio = getCurrentLeverageRatio();
        bool isRipcord = false;

        // if over incentivized leverage ratio, always ripcord
        if (currentLeverageRatio > incentive.incentivizedLeverageRatio) {
            newLeverageRatio = methodology.maxLeverageRatio;
            isRipcord = true;
        // if we are in an ongoing twap, use the cached twapLeverageRatio as our target leverage
        } else if (twapLeverageRatio > 0) {
            newLeverageRatio = twapLeverageRatio;
        // if all else is false, then we would just use the normal rebalance new leverage ratio calculation
        } else {
            newLeverageRatio = _calculateNewLeverageRatio(currentLeverageRatio);
        }

        ActionInfo memory actionInfo = _createActionInfo();
        bool isLever = newLeverageRatio > currentLeverageRatio;

        sizes = new uint256[](_exchangeNames.length);

        for (uint256 i = 0; i < _exchangeNames.length; i++) {
    
            LeverageInfo memory leverageInfo = LeverageInfo({
                action: actionInfo,
                currentLeverageRatio: currentLeverageRatio,
                slippageTolerance: isRipcord ? incentive.incentivizedSlippageTolerance : execution.slippageTolerance,
                twapMaxTradeSize: isRipcord ?
                    exchangeSettings[_exchangeNames[i]].incentivizedTwapMaxTradeSize :
                    exchangeSettings[_exchangeNames[i]].twapMaxTradeSize,
                exchangeName: _exchangeNames[i]
            });

            (uint256 collateralNotional, ) = _calculateChunkRebalanceNotional(leverageInfo, newLeverageRatio, isLever);

            // _calculateBorrowUnits can convert both unit and notional values
            sizes[i] = isLever ? _calculateBorrowUnits(collateralNotional, leverageInfo.action) : collateralNotional;
        }

        sellAsset = isLever ? strategy.borrowAsset : strategy.collateralAsset;
        buyAsset = isLever ? strategy.collateralAsset : strategy.borrowAsset;
    }

    /**
     * Get current Ether incentive for when current leverage ratio exceeds incentivized leverage ratio and ripcord can be called. If ETH balance on the contract is
     * below the etherReward, then return the balance of ETH instead.
     *
     * return etherReward               Quantity of ETH reward in base units (10e18)
     */
    function getCurrentEtherIncentive() external view returns(uint256) {
        uint256 currentLeverageRatio = getCurrentLeverageRatio();

        if (currentLeverageRatio >= incentive.incentivizedLeverageRatio) {
            // If ETH reward is below the balance on this contract, then return ETH balance on contract instead
            return incentive.etherReward < address(this).balance ? incentive.etherReward : address(this).balance;
        } else {
            return 0;
        }
    }

    /**
     * Helper that checks if conditions are met for rebalance or ripcord. Returns an enum with 0 = no rebalance, 1 = call rebalance(), 2 = call iterateRebalance()
     * 3 = call ripcord()
     *
     * @return (string[] memory, ShouldRebalance[] memory)      List of exchange names and a list of enums representing whether that exchange should rebalance
     */
    function shouldRebalance() external view returns(string[] memory, ShouldRebalance[] memory) {
        uint256 currentLeverageRatio = getCurrentLeverageRatio();

        return _shouldRebalance(currentLeverageRatio, methodology.minLeverageRatio, methodology.maxLeverageRatio);
    }

    /**
     * Helper that checks if conditions are met for rebalance or ripcord with custom max and min bounds specified by caller. This function simplifies the
     * logic for off-chain keeper bots to determine what threshold to call rebalance when leverage exceeds max or drops below min. Returns an enum with
     * 0 = no rebalance, 1 = call rebalance(), 2 = call iterateRebalance(), 3 = call ripcord()
     *
     * @param _customMinLeverageRatio          Min leverage ratio passed in by caller
     * @param _customMaxLeverageRatio          Max leverage ratio passed in by caller
     *
     * @return (string[] memory, ShouldRebalance[] memory)      List of exchange names and a list of enums representing whether that exchange should rebalance
     */
    function shouldRebalanceWithBounds(
        uint256 _customMinLeverageRatio,
        uint256 _customMaxLeverageRatio
    )
        external
        view
        returns(string[] memory, ShouldRebalance[] memory)
    {
        require (
            _customMinLeverageRatio <= methodology.minLeverageRatio && _customMaxLeverageRatio >= methodology.maxLeverageRatio,
            "Custom bounds must be valid"
        );

        uint256 currentLeverageRatio = getCurrentLeverageRatio();

        return _shouldRebalance(currentLeverageRatio, _customMinLeverageRatio, _customMaxLeverageRatio);
    }

    /**
     * Gets the list of enabled exchanges
     */
    function getEnabledExchanges() external view returns (string[] memory) {
        return enabledExchanges;
    }

    /**
     * Explicit getter functions for parameter structs are defined as workaround to issues fetching structs that have dynamic types.
     */
    function getStrategy() external view returns (ContractSettings memory) { return strategy; }
    function getMethodology() external view returns (MethodologySettings memory) { return methodology; }
    function getExecution() external view returns (ExecutionSettings memory) { return execution; }
    function getIncentive() external view returns (IncentiveSettings memory) { return incentive; }
    function getExchangeSettings(string memory _exchangeName) external view returns (ExchangeSettings memory) {
        return exchangeSettings[_exchangeName];
    }

    /* ============ Internal Functions ============ */

    /**
     * Calculate notional rebalance quantity, whether to chunk rebalance based on max trade size and max borrow and invoke lever on AaveLeverageModule
     *
     */
     function _lever(
        LeverageInfo memory _leverageInfo,
        uint256 _chunkRebalanceNotional
    )
        internal
    {
        uint256 collateralRebalanceUnits = _chunkRebalanceNotional.preciseDiv(_leverageInfo.action.setTotalSupply);

        uint256 borrowUnits = _calculateBorrowUnits(collateralRebalanceUnits, _leverageInfo.action);

        uint256 minReceiveCollateralUnits = _calculateMinCollateralReceiveUnits(collateralRebalanceUnits, _leverageInfo.slippageTolerance);

        bytes memory leverCallData = abi.encodeWithSignature(
            "lever(address,address,address,uint256,uint256,string,bytes)",
            address(strategy.setToken),
            strategy.borrowAsset,
            strategy.collateralAsset,
            borrowUnits,
            minReceiveCollateralUnits,
            _leverageInfo.exchangeName,
            exchangeSettings[_leverageInfo.exchangeName].leverExchangeData
        );

        invokeManager(address(strategy.leverageModule), leverCallData);
    }

    /**
     * Calculate delever units Invoke delever on AaveLeverageModule.
     */
    function _delever(
        LeverageInfo memory _leverageInfo,
        uint256 _chunkRebalanceNotional
    )
        internal
    {
        uint256 collateralRebalanceUnits = _chunkRebalanceNotional.preciseDiv(_leverageInfo.action.setTotalSupply);

        uint256 minRepayUnits = _calculateMinRepayUnits(collateralRebalanceUnits, _leverageInfo.slippageTolerance, _leverageInfo.action);

        bytes memory deleverCallData = abi.encodeWithSignature(
            "delever(address,address,address,uint256,uint256,string,bytes)",
            address(strategy.setToken),
            strategy.collateralAsset,
            strategy.borrowAsset,
            collateralRebalanceUnits,
            minRepayUnits,
            _leverageInfo.exchangeName,
            exchangeSettings[_leverageInfo.exchangeName].deleverExchangeData
        );

        invokeManager(address(strategy.leverageModule), deleverCallData);
    }

    /**
     * Invoke deleverToZeroBorrowBalance on AaveLeverageModule.
     */
    function _deleverToZeroBorrowBalance(
        LeverageInfo memory _leverageInfo,
        uint256 _chunkRebalanceNotional
    )
        internal
    {
        // Account for slippage tolerance in redeem quantity for the deleverToZeroBorrowBalance function
        uint256 maxCollateralRebalanceUnits = _chunkRebalanceNotional
            .preciseMul(PreciseUnitMath.preciseUnit().add(execution.slippageTolerance))
            .preciseDiv(_leverageInfo.action.setTotalSupply);

        bytes memory deleverToZeroBorrowBalanceCallData = abi.encodeWithSignature(
            "deleverToZeroBorrowBalance(address,address,address,uint256,string,bytes)",
            address(strategy.setToken),
            strategy.collateralAsset,
            strategy.borrowAsset,
            maxCollateralRebalanceUnits,
            _leverageInfo.exchangeName,
            exchangeSettings[_leverageInfo.exchangeName].deleverExchangeData
        );

        invokeManager(address(strategy.leverageModule), deleverToZeroBorrowBalanceCallData);
    }

    /**
     * Check whether to delever or lever based on the current vs new leverage ratios. Used in the rebalance() and iterateRebalance() functions
     *
     * return uint256           Calculated notional to trade
     * return uint256           Total notional to rebalance over TWAP
     */
    function _handleRebalance(LeverageInfo memory _leverageInfo, uint256 _newLeverageRatio) internal returns(uint256, uint256) {
        uint256 chunkRebalanceNotional;
        uint256 totalRebalanceNotional;
        if (_newLeverageRatio < _leverageInfo.currentLeverageRatio) {
            (
                chunkRebalanceNotional,
                totalRebalanceNotional
            ) = _calculateChunkRebalanceNotional(_leverageInfo, _newLeverageRatio, false);

            _delever(_leverageInfo, chunkRebalanceNotional);
        } else {
            (
                chunkRebalanceNotional,
                totalRebalanceNotional
            ) = _calculateChunkRebalanceNotional(_leverageInfo, _newLeverageRatio, true);

            _lever(_leverageInfo, chunkRebalanceNotional);
        }

        return (chunkRebalanceNotional, totalRebalanceNotional);
    }

    /**
     * Create the leverage info struct to be used in internal functions
     *
     * return LeverageInfo                Struct containing ActionInfo and other data
     */
    function _getAndValidateLeveragedInfo(uint256 _slippageTolerance, uint256 _maxTradeSize, string memory _exchangeName) internal view returns(LeverageInfo memory) {
        // Assume if maxTradeSize is 0, then the exchange is not enabled. This is enforced by addEnabledExchange and updateEnabledExchange
        require(_maxTradeSize > 0, "Must be valid exchange");

        ActionInfo memory actionInfo = _createActionInfo();

        require(actionInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(actionInfo.collateralBalance > 0, "Collateral balance must be > 0");
        require(actionInfo.borrowBalance > 0, "Borrow balance must exist");

        // Get current leverage ratio
        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            actionInfo.collateralValue,
            actionInfo.borrowValue
        );

        return LeverageInfo({
            action: actionInfo,
            currentLeverageRatio: currentLeverageRatio,
            slippageTolerance: _slippageTolerance,
            twapMaxTradeSize: _maxTradeSize,
            exchangeName: _exchangeName
        });
    }

    /**
     * Create the action info struct to be used in internal functions
     *
     * return ActionInfo                Struct containing data used by internal lever and delever functions
     */
    function _createActionInfo() internal view virtual returns(ActionInfo memory) {
        ActionInfo memory rebalanceInfo;

        // Calculate prices from chainlink. Chainlink returns prices with 8 decimal places, but we need 36 - underlyingDecimals decimal places.
        // This is so that when the underlying amount is multiplied by the received price, the collateral valuation is normalized to 36 decimals. 
        // To perform this adjustment, we multiply by 10^(36 - 8 - underlyingDecimals)
        int256 rawCollateralPrice = strategy.collateralPriceOracle.latestAnswer();
        rebalanceInfo.collateralPrice = rawCollateralPrice.toUint256().mul(10 ** strategy.collateralDecimalAdjustment);
        int256 rawBorrowPrice = strategy.borrowPriceOracle.latestAnswer();
        rebalanceInfo.borrowPrice = rawBorrowPrice.toUint256().mul(10 ** strategy.borrowDecimalAdjustment);

        rebalanceInfo.collateralBalance = strategy.targetCollateralAToken.balanceOf(address(strategy.setToken));
        rebalanceInfo.borrowBalance = strategy.targetBorrowDebtToken.balanceOf(address(strategy.setToken));
        rebalanceInfo.collateralValue = rebalanceInfo.collateralPrice.preciseMul(rebalanceInfo.collateralBalance);
        rebalanceInfo.borrowValue = rebalanceInfo.borrowPrice.preciseMul(rebalanceInfo.borrowBalance);
        rebalanceInfo.setTotalSupply = strategy.setToken.totalSupply();

        return rebalanceInfo;
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
        virtual
        pure
    {
        require (
            _methodology.minLeverageRatio <= _methodology.targetLeverageRatio && _methodology.minLeverageRatio > 0,
            "Must be valid min leverage"
        );
        require (
            _methodology.maxLeverageRatio >= _methodology.targetLeverageRatio,
            "Must be valid max leverage"
        );
        require (
            _methodology.recenteringSpeed <= PreciseUnitMath.preciseUnit() && _methodology.recenteringSpeed > 0,
            "Must be valid recentering speed"
        );
        require (
            _execution.unutilizedLeveragePercentage <= PreciseUnitMath.preciseUnit(),
            "Unutilized leverage must be <100%"
        );
        require (
            _execution.slippageTolerance <= PreciseUnitMath.preciseUnit(),
            "Slippage tolerance must be <100%"
        );
        require (
            _incentive.incentivizedSlippageTolerance <= PreciseUnitMath.preciseUnit(),
            "Incentivized slippage tolerance must be <100%"
        );
        require (
            _incentive.incentivizedLeverageRatio >= _methodology.maxLeverageRatio,
            "Incentivized leverage ratio must be > max leverage ratio"
        );
        require (
            _methodology.rebalanceInterval >= _execution.twapCooldownPeriod,
            "Rebalance interval must be greater than TWAP cooldown period"
        );
        require (
            _execution.twapCooldownPeriod >= _incentive.incentivizedTwapCooldownPeriod,
            "TWAP cooldown must be greater than incentivized TWAP cooldown"
        );
    }

    /**
     * Validate an ExchangeSettings struct when adding or updating an exchange. Does not validate that twapMaxTradeSize < incentivizedMaxTradeSize since
     * it may be useful to disable exchanges for ripcord by setting incentivizedMaxTradeSize to 0.
     */
     function _validateExchangeSettings(ExchangeSettings memory _settings) internal pure {
         require(_settings.twapMaxTradeSize != 0, "Max TWAP trade size must not be 0");
     }

    /**
     * Validate that current leverage is below incentivized leverage ratio and cooldown / rebalance period has elapsed or outsize max/min bounds. Used
     * in rebalance() and iterateRebalance() functions
     */
    function _validateNormalRebalance(LeverageInfo memory _leverageInfo, uint256 _coolDown, uint256 _lastTradeTimestamp) internal view {
        require(_leverageInfo.currentLeverageRatio < incentive.incentivizedLeverageRatio, "Must be below incentivized leverage ratio");
        require(
            block.timestamp.sub(_lastTradeTimestamp) > _coolDown
            || _leverageInfo.currentLeverageRatio > methodology.maxLeverageRatio
            || _leverageInfo.currentLeverageRatio < methodology.minLeverageRatio,
            "Cooldown not elapsed or not valid leverage ratio"
        );
    }

    /**
     * Validate that current leverage is above incentivized leverage ratio and incentivized cooldown period has elapsed in ripcord()
     */
    function _validateRipcord(LeverageInfo memory _leverageInfo, uint256 _lastTradeTimestamp) internal view {
        require(_leverageInfo.currentLeverageRatio >= incentive.incentivizedLeverageRatio, "Must be above incentivized leverage ratio");
        // If currently in the midst of a TWAP rebalance, ensure that the cooldown period has elapsed
        require(_lastTradeTimestamp.add(incentive.incentivizedTwapCooldownPeriod) < block.timestamp, "TWAP cooldown must have elapsed");
    }

    /**
     * Validate TWAP in the iterateRebalance() function
     */
    function _validateTWAP() internal view {
        require(twapLeverageRatio > 0, "Not in TWAP state");
    }

    /**
     * Validate not TWAP in the rebalance() function
     */
    function _validateNonTWAP() internal view {
        require(twapLeverageRatio == 0, "Must call iterate");
    }

    /**
     * Check if price has moved advantageously while in the midst of the TWAP rebalance. This means the current leverage ratio has moved over/under
     * the stored TWAP leverage ratio on lever/delever so there is no need to execute a rebalance. Used in iterateRebalance()
     */
    function _isAdvantageousTWAP(uint256 _currentLeverageRatio) internal view returns (bool) {
        return (
            (twapLeverageRatio < methodology.targetLeverageRatio && _currentLeverageRatio >= twapLeverageRatio)
            || (twapLeverageRatio > methodology.targetLeverageRatio && _currentLeverageRatio <= twapLeverageRatio)
        );
    }

    /**
     * Calculate the current leverage ratio given a valuation of the collateral and borrow asset, which is calculated as collateral USD valuation / SetToken USD valuation
     *
     * return uint256            Current leverage ratio
     */
    function _calculateCurrentLeverageRatio(
        uint256 _collateralValue,
        uint256 _borrowValue
    )
        internal
        pure
        returns(uint256)
    {
        return _collateralValue.preciseDiv(_collateralValue.sub(_borrowValue));
    }

    /**
     * Calculate the new leverage ratio. The methodology reduces the size of each rebalance by weighting
     * the current leverage ratio against the target leverage ratio by the recentering speed percentage. The lower the recentering speed, the slower
     * the leverage token will move towards the target leverage each rebalance.
     *
     * return uint256          New leverage ratio
     */
    function _calculateNewLeverageRatio(uint256 _currentLeverageRatio) internal view returns(uint256) {
        // CLRt+1 = max(MINLR, min(MAXLR, CLRt * (1 - RS) + TLR * RS))
        // a: TLR * RS
        // b: (1- RS) * CLRt
        // c: (1- RS) * CLRt + TLR * RS
        // d: min(MAXLR, CLRt * (1 - RS) + TLR * RS)
        uint256 a = methodology.targetLeverageRatio.preciseMul(methodology.recenteringSpeed);
        uint256 b = PreciseUnitMath.preciseUnit().sub(methodology.recenteringSpeed).preciseMul(_currentLeverageRatio);
        uint256 c = a.add(b);
        uint256 d = Math.min(c, methodology.maxLeverageRatio);
        return Math.max(methodology.minLeverageRatio, d);
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
        virtual
        returns (uint256, uint256)
    {
        // Calculate absolute value of difference between new and current leverage ratio
        uint256 leverageRatioDifference = _isLever ? _newLeverageRatio.sub(_leverageInfo.currentLeverageRatio) : _leverageInfo.currentLeverageRatio.sub(_newLeverageRatio);

        uint256 totalRebalanceNotional = leverageRatioDifference.preciseDiv(_leverageInfo.currentLeverageRatio).preciseMul(_leverageInfo.action.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowCollateral(_leverageInfo.action, _isLever);

        uint256 chunkRebalanceNotional = Math.min(Math.min(maxBorrow, totalRebalanceNotional), _leverageInfo.twapMaxTradeSize);

        return (chunkRebalanceNotional, totalRebalanceNotional);
    }

    /**
     * Calculate the max borrow / repay amount allowed in base units for lever / delever. This is due to overcollateralization requirements on
     * assets deposited in lending protocols for borrowing.
     *
     * For lever, max borrow is calculated as:
     * (Net borrow limit in USD - existing borrow value in USD) / collateral asset price adjusted for decimals
     *
     * For delever, max repay is calculated as:
     * Collateral balance in base units * (net borrow limit in USD - existing borrow value in USD) / net borrow limit in USD
     *
     * Net borrow limit for levering is calculated as:
     * The collateral value in USD * Aave collateral factor * (1 - unutilized leverage %)
     *
     * Net repay limit for delevering is calculated as:
     * The collateral value in USD * Aave liquiditon threshold * (1 - unutilized leverage %)
     *
     * return uint256          Max borrow notional denominated in collateral asset
     */
    function _calculateMaxBorrowCollateral(ActionInfo memory _actionInfo, bool _isLever) internal virtual view returns(uint256) {
        
        // Retrieve collateral factor and liquidation threshold for the collateral asset in precise units (1e16 = 1%)
        ( , uint256 maxLtvRaw, uint256 liquidationThresholdRaw, , , , , , ,) = strategy.aaveProtocolDataProvider.getReserveConfigurationData(address(strategy.collateralAsset));

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
                .preciseMul(liquidationThresholdRaw.mul(10 ** 14))
                .preciseMul(PreciseUnitMath.preciseUnit().sub(execution.unutilizedLeveragePercentage));

            return _actionInfo.collateralBalance
                .preciseMul(netRepayLimit.sub(_actionInfo.borrowValue))
                .preciseDiv(netRepayLimit);
        }
    }

    /**
     * Derive the borrow units for lever. The units are calculated by the collateral units multiplied by collateral / borrow asset price.
     * Output is measured to borrow unit decimals.
     *
     * return uint256           Position units to borrow
     */
    function _calculateBorrowUnits(uint256 _collateralRebalanceUnits, ActionInfo memory _actionInfo) internal pure returns (uint256) {
        return _collateralRebalanceUnits.preciseMul(_actionInfo.collateralPrice).preciseDiv(_actionInfo.borrowPrice);
    }

    /**
     * Calculate the min receive units in collateral units for lever. Units are calculated as target collateral rebalance units multiplied by slippage tolerance
     * Output is measured in collateral asset decimals.
     *
     * return uint256           Min position units to receive after lever trade
     */
    function _calculateMinCollateralReceiveUnits(uint256 _collateralRebalanceUnits, uint256 _slippageTolerance) internal pure returns (uint256) {
        return _collateralRebalanceUnits.preciseMul(PreciseUnitMath.preciseUnit().sub(_slippageTolerance));
    }

    /**
     * Derive the min repay units from collateral units for delever. Units are calculated as target collateral rebalance units multiplied by slippage tolerance
     * and pair price (collateral oracle price / borrow oracle price). Output is measured in borrow unit decimals.
     *
     * return uint256           Min position units to repay in borrow asset
     */
    function _calculateMinRepayUnits(uint256 _collateralRebalanceUnits, uint256 _slippageTolerance, ActionInfo memory _actionInfo) internal virtual pure returns (uint256) {
        return _collateralRebalanceUnits
            .preciseMul(_actionInfo.collateralPrice)
            .preciseDiv(_actionInfo.borrowPrice)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(_slippageTolerance));
    }

    /**
     * Update last trade timestamp and if chunk rebalance size is less than total rebalance notional, store new leverage ratio to kick off TWAP. Used in
     * the engage() and rebalance() functions
     */
    function _updateRebalanceState(
        uint256 _chunkRebalanceNotional,
        uint256 _totalRebalanceNotional,
        uint256 _newLeverageRatio,
        string memory _exchangeName
    )
        internal
    {

        _updateLastTradeTimestamp(_exchangeName);

        if (_chunkRebalanceNotional < _totalRebalanceNotional) {
            twapLeverageRatio = _newLeverageRatio;
        }
    }

    /**
     * Update last trade timestamp and if chunk rebalance size is equal to the total rebalance notional, end TWAP by clearing state. This function is used
     * in iterateRebalance()
     */
    function _updateIterateState(uint256 _chunkRebalanceNotional, uint256 _totalRebalanceNotional, string memory _exchangeName) internal {

        _updateLastTradeTimestamp(_exchangeName);

        // If the chunk size is equal to the total notional meaning that rebalances are not chunked, then clear TWAP state.
        if (_chunkRebalanceNotional == _totalRebalanceNotional) {
            delete twapLeverageRatio;
        }
    }

    /**
     * Update last trade timestamp and if currently in a TWAP, delete the TWAP state. Used in the ripcord() function.
     */
    function _updateRipcordState(string memory _exchangeName) internal {

        _updateLastTradeTimestamp(_exchangeName);

        // If TWAP leverage ratio is stored, then clear state. This may happen if we are currently in a TWAP rebalance, and the leverage ratio moves above the
        // incentivized threshold for ripcord.
        if (twapLeverageRatio > 0) {
            delete twapLeverageRatio;
        }
    }

    /**
     * Update globalLastTradeTimestamp and exchangeLastTradeTimestamp values. This function updates both the exchange-specific and global timestamp so that the
     * epoch rebalance can use the global timestamp (since the global timestamp is always  equal to the most recently used exchange timestamp). This allows for
     * multiple rebalances to occur simultaneously since only the exchange-specific timestamp is checked for non-epoch rebalances.
     */
     function _updateLastTradeTimestamp(string memory _exchangeName) internal {
        globalLastTradeTimestamp = block.timestamp;
        exchangeSettings[_exchangeName].exchangeLastTradeTimestamp = block.timestamp;
     }

    /**
     * Transfer ETH reward to caller of the ripcord function. If the ETH balance on this contract is less than required
     * incentive quantity, then transfer contract balance instead to prevent reverts.
     *
     * return uint256           Amount of ETH transferred to caller
     */
    function _transferEtherRewardToCaller(uint256 _etherReward) internal returns(uint256) {
        uint256 etherToTransfer = _etherReward < address(this).balance ? _etherReward : address(this).balance;

        msg.sender.transfer(etherToTransfer);

        return etherToTransfer;
    }

    /**
     * Internal function returning the ShouldRebalance enum used in shouldRebalance and shouldRebalanceWithBounds external getter functions
     *
     * return ShouldRebalance         Enum detailing whether to rebalance, iterateRebalance, ripcord or no action
     */
    function _shouldRebalance(
        uint256 _currentLeverageRatio,
        uint256 _minLeverageRatio,
        uint256 _maxLeverageRatio
    )
        internal
        view
        returns(string[] memory, ShouldRebalance[] memory)
    {

        ShouldRebalance[] memory shouldRebalanceEnums = new ShouldRebalance[](enabledExchanges.length);

        for (uint256 i = 0; i < enabledExchanges.length; i++) {
            // If none of the below conditions are satisfied, then should not rebalance
            shouldRebalanceEnums[i] = ShouldRebalance.NONE;

            // If above ripcord threshold, then check if incentivized cooldown period has elapsed
            if (_currentLeverageRatio >= incentive.incentivizedLeverageRatio) {
                if (exchangeSettings[enabledExchanges[i]].exchangeLastTradeTimestamp.add(incentive.incentivizedTwapCooldownPeriod) < block.timestamp) {
                    shouldRebalanceEnums[i] = ShouldRebalance.RIPCORD;
                }
            } else {
                // If TWAP, then check if the cooldown period has elapsed
                if (twapLeverageRatio > 0) {
                    if (exchangeSettings[enabledExchanges[i]].exchangeLastTradeTimestamp.add(execution.twapCooldownPeriod) < block.timestamp) {
                        shouldRebalanceEnums[i] = ShouldRebalance.ITERATE_REBALANCE;
                    }
                } else {
                    // If not TWAP, then check if the rebalance interval has elapsed OR current leverage is above max leverage OR current leverage is below
                    // min leverage
                    if (
                        block.timestamp.sub(globalLastTradeTimestamp) > methodology.rebalanceInterval
                        || _currentLeverageRatio > _maxLeverageRatio
                        || _currentLeverageRatio < _minLeverageRatio
                    ) {
                        shouldRebalanceEnums[i] = ShouldRebalance.REBALANCE;
                    }
                }
            }
        }

        return (enabledExchanges, shouldRebalanceEnums);
    }
}
