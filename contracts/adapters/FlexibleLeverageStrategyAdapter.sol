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
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { BaseAdapter } from "../lib/BaseAdapter.sol";
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { IICManagerV2 } from "../interfaces/IICManagerV2.sol";
import { IComptroller } from "../interfaces/IComptroller.sol";
import { ICompoundLeverageModule } from "../interfaces/ICompoundLeverageModule.sol";
import { ICompoundPriceOracle } from "../interfaces/ICompoundPriceOracle.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title FlexibleLeverageStrategyAdapter
 * @author Set Protocol
 *
 * Smart contract that enables trustless leverage tokens using the flexible leverage methodology. This adapter is paired with the CompoundLeverageModule from Set
 * protocol where module interactions are invoked via the ICManagerV2 contract. Any leveraged token can be constructed as long as the collateral and borrow
 * asset is available on Compound. This adapter contract also allows the operator to set an ETH reward to incentivize keepers calling the rebalance function at
 * different leverage thresholds.
 *
 */
contract FlexibleLeverageStrategyAdapter is BaseAdapter {
    using Address for address;
    using AddressArrayUtils for address[];
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Enums ============ */

    enum ShouldRebalance {
        NONE,
        REBALANCE,
        RIPCORD
    }

    /* ============ Structs ============ */

    struct ActionInfo {
        uint256 collateralPrice;                   // Price of underlying in precise units (10e18)
        uint256 borrowPrice;                       // Price of underlying in precise units (10e18)
        uint256 collateralBalance;                 // Balance of underlying held in Compound in base units (e.g. USDC 10e6)
        uint256 borrowBalance;                     // Balance of underlying borrowed from Compound in base units
        uint256 collateralValue;                   // Valuation in USD adjusted for decimals in precise units (10e18)
        uint256 borrowValue;                       // Valuation in USD adjusted for decimals in precise units (10e18)
        uint256 setTotalSupply;                    // Total supply of SetToken
    }

    struct ContractSettings {
        ISetToken setToken;                              // Instance of leverage token
        ICompoundLeverageModule leverageModule;          // Instance of Compound leverage module
        IComptroller comptroller;                        // Instance of Compound Comptroller
        ICompoundPriceOracle priceOracle;                // Compound open oracle feed that returns prices accounting for decimals. e.g. USDC 6 decimals = 10^18 * 10^18 / 10^6
        ICErc20 targetCollateralCToken;                  // Instance of target collateral cToken asset
        ICErc20 targetBorrowCToken;                      // Instance of target borrow cToken asset
        address collateralAsset;                         // Address of underlying collateral
        address borrowAsset;                             // Address of underlying borrow asset
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
        uint256 twapMaxTradeSize;                        // Max trade size in collateral base units
        uint256 twapCooldownPeriod;                      // Cooldown period required since last trade timestamp in seconds
        uint256 slippageTolerance;                       // % in precise units to price min token receive amount from trade quantities
        string exchangeName;                             // Name of exchange that is being used for leverage
        bytes exchangeData;                              // Arbitrary exchange data passed into rebalance function
    }

    struct IncentiveSettings {
        uint256 etherReward;                             // ETH reward for incentivized rebalances
        uint256 incentivizedLeverageRatio;               // Leverage ratio for incentivized rebalances
        uint256 incentivizedSlippageTolerance;           // Slippage tolerance percentage for incentivized rebalances
        uint256 incentivizedTwapCooldownPeriod;          // TWAP cooldown in seconds for incentivized rebalances
        uint256 incentivizedTwapMaxTradeSize;            // Max trade size for incentivized rebalances in collateral base units
    }

    /* ============ Events ============ */

    event Engaged(address indexed _setToken, uint256 _currentLeverageRatio, uint256 _newLeverageRatio);
    event Rebalance(
        address indexed _setToken,
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        address _caller
    );
    event RipcordCalled(
        address indexed _setToken,
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        address _caller
    );
    event Disengaged(address indexed _setToken, uint256 _currentLeverageRatio, uint256 _newLeverageRatio);
    event MethodologySettingsUpdated(
        uint256 _targetLeverageRatio,
        uint256 _minLeverageRatio,
        uint256 _maxLeverageRatio,
        uint256 _recenteringSpeed,
        uint256 _rebalanceInterval
    );
    event ExecutionSettingsUpdated(
        uint256 _unutilizedLeveragePercentage,
        uint256 _twapMaxTradeSize,
        uint256 _twapCooldownPeriod,
        uint256 _slippageTolerance,
        string _exchangeName,
        bytes _exchangeData
    );
    event IncentiveSettingsUpdated(
        uint256 _etherReward,
        uint256 _incentivizedLeverageRatio,
        uint256 _incentivizedSlippageTolerance,
        uint256 _incentivizedTwapCooldownPeriod,
        uint256 _incentivizedTwapMaxTradeSize
    );

    event TraderStatusUpdated(address indexed _trader, bool _status);
    event AnyoneTradeUpdated(bool indexed _status);

    /* ============ Modifiers ============ */

    /**
     * Throws if rebalance is currently in TWAP`
     */
    modifier noRebalanceInProgress() {
        require(twapLeverageRatio == 0, "Rebalance is currently in progress");
        _;
    }

    /* ============ State Variables ============ */

    ContractSettings public contractSettings;               // Struct containing contract addresses
    MethodologySettings public methodologySettings;         // Struct containing methodology parameters
    ExecutionSettings public executionSettings;             // Struct containing execution parameters
    IncentiveSettings public incentiveSettings;             // Struct containing incentive parameters for ripcord
    uint256 public twapLeverageRatio;                       // Stored leverage ratio to keep track of target between TWAP rebalances
    uint256 public lastTradeTimestamp;                      // Last rebalance timestamp. Must be past rebalance interval to rebalance

    /* ============ Constructor ============ */

    /**
     * Instantiate addresses, methodology parameters, execution parameters, and incentive parameters.
     * 
     * @param _manager                      Address of ICManagerV2 contract
     * @param _contractSettings             Struct containing contract addresses
     * @param _methodologySettings          Struct containing methodology parameters
     * @param _executionSettings            Struct containing execution parameters
     * @param _incentiveSettings            Struct containing incentive parameters for ripcord
     */
    constructor(
        IICManagerV2 _manager,
        ContractSettings memory _contractSettings,
        MethodologySettings memory _methodologySettings,
        ExecutionSettings memory _executionSettings,
        IncentiveSettings memory _incentiveSettings
    ) public {
        manager = _manager;
        contractSettings = _contractSettings;
        methodologySettings = _methodologySettings;
        executionSettings = _executionSettings;
        incentiveSettings = _incentiveSettings;

        _validateSettings(methodologySettings, executionSettings, incentiveSettings);
    }

    /* ============ External Functions ============ */

    /**
     * OPERATOR ONLY: Engage to target leverage ratio for the first time. SetToken will borrow debt position from Compound and trade for collateral asset. If target
     * leverage ratio is above max borrow or max trade size, then TWAP is kicked off. To complete engage if TWAP, you must call rebalance until target
     * is met.
     */
    function engage() external onlyOperator {
        ActionInfo memory engageInfo = _createActionInfo();

        require(engageInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(engageInfo.collateralBalance > 0, "Collateral balance must be > 0");
        require(engageInfo.borrowBalance == 0, "Debt must be 0");

        // Calculate total rebalance units and kick off TWAP if above max borrow or max trade size
        _lever(
            PreciseUnitMath.preciseUnit(), // 1x leverage in precise units
            methodologySettings.targetLeverageRatio,
            engageInfo
        );
    }

    /**
     * ONLY EOA AND ALLOWED TRADER: Rebalance according to flexible leverage methodology. If current leverage ratio is between the max and min bounds, then rebalance 
     * can only be called once the rebalance interval has elapsed since last timestamp. If outside the max and min, rebalance can be called anytime to bring leverage
     * ratio back to the max or min bounds. The methodology will determine whether to delever or lever.
     *
     * Note: If the calculated current leverage ratio is above the incentivized leverage ratio then rebalance cannot be called. Instead, you must call ripcord() which
     * is incentivized with a reward in Ether
     */
    function rebalance() external onlyEOA onlyAllowedCaller(msg.sender) {

        ActionInfo memory rebalanceInfo = _createActionInfo();
        require(rebalanceInfo.borrowBalance > 0, "Borrow balance must exist");

        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            rebalanceInfo.collateralValue,
            rebalanceInfo.borrowValue
        );

        // Ensure that when leverage exceeds incentivized threshold, only ripcord can be called to prevent potential state inconsistencies
        require(currentLeverageRatio < incentiveSettings.incentivizedLeverageRatio, "Must call ripcord");

        uint256 newLeverageRatio;
        if (twapLeverageRatio != 0) {
            // IMPORTANT: If currently in TWAP and price has moved advantageously. For delever, this means the current leverage ratio has dropped
            // below the TWAP leverage ratio and for lever, this means the current leverage ratio has gone above the TWAP leverage ratio. 
            // Update state and exit the function, skipping additional calculations and trade.
            if (_updateStateAndExitIfAdvantageous(currentLeverageRatio)) {
                return;
            }

            // If currently in the midst of a TWAP rebalance, ensure that the cooldown period has elapsed
            require(lastTradeTimestamp.add(executionSettings.twapCooldownPeriod) < block.timestamp, "Cooldown period must have elapsed");

            newLeverageRatio = twapLeverageRatio;
        } else {
            require(
                block.timestamp.sub(lastTradeTimestamp) > methodologySettings.rebalanceInterval
                || currentLeverageRatio > methodologySettings.maxLeverageRatio
                || currentLeverageRatio < methodologySettings.minLeverageRatio,
                "Rebalance interval not yet elapsed"
            );
            newLeverageRatio = _calculateNewLeverageRatio(currentLeverageRatio);
        }
        
        if (newLeverageRatio < currentLeverageRatio) {
            _delever(
                currentLeverageRatio,
                newLeverageRatio,
                rebalanceInfo,
                executionSettings.slippageTolerance,
                executionSettings.twapMaxTradeSize
            );
        } else {
            // In the case newLeverageRatio is equal to currentLeverageRatio (which only occurs if we're exactly at the target), the trade quantity
            // will be calculated as 0 and will revert in the CompoundLeverageModule.
            _lever(
                currentLeverageRatio,
                newLeverageRatio,
                rebalanceInfo
            );
        }
    }

    /**
     * ONLY EOA: In case the current leverage ratio exceeds the incentivized leverage threshold, the ripcord function can be called by anyone to return leverage ratio
     * back to the max leverage ratio. This function typically would only be called during times of high downside volatility and / or normal keeper malfunctions. The caller
     * of ripcord() will receive a reward in Ether. The ripcord function uses it's own TWAP cooldown period, slippage tolerance and TWAP max trade size which are typically
     * looser than in the rebalance() function.
     */
    function ripcord() external onlyEOA {
        // If currently in the midst of a TWAP rebalance, ensure that the cooldown period has elapsed
        if (twapLeverageRatio != 0) {
            require(
                lastTradeTimestamp.add(incentiveSettings.incentivizedTwapCooldownPeriod) < block.timestamp,
                "Incentivized cooldown period must have elapsed"
            );
        }

        ActionInfo memory ripcordInfo = _createActionInfo();
        require(ripcordInfo.borrowBalance > 0, "Borrow balance must exist");

        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            ripcordInfo.collateralValue,
            ripcordInfo.borrowValue
        );

        // Ensure that current leverage ratio must be greater than leverage threshold
        require(currentLeverageRatio >= incentiveSettings.incentivizedLeverageRatio, "Must be above incentivized leverage ratio");
        
        _delever(
            currentLeverageRatio,
            methodologySettings.maxLeverageRatio, // The target new leverage ratio is always the max leverage ratio
            ripcordInfo,
            incentiveSettings.incentivizedSlippageTolerance,
            incentiveSettings.incentivizedTwapMaxTradeSize
        );

        _transferEtherRewardToCaller(incentiveSettings.etherReward);
    }

    /**
     * OPERATOR ONLY: Return leverage ratio to 1x and delever to repay loan. This can be used for upgrading or shutting down the strategy.
     *
     * Note: due to rounding on trades, loan value may not be entirely repaid.
     */
    function disengage() external onlyOperator {
        ActionInfo memory disengageInfo = _createActionInfo();

        require(disengageInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(disengageInfo.collateralBalance > 0, "Collateral balance must be > 0");
        require(disengageInfo.borrowBalance > 0, "Borrow balance must exist");

        // Get current leverage ratio
        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            disengageInfo.collateralValue,
            disengageInfo.borrowValue
        );

        _delever(
            currentLeverageRatio,
            PreciseUnitMath.preciseUnit(), // This is reducing back to a leverage ratio of 1
            disengageInfo,
            executionSettings.slippageTolerance,
            executionSettings.twapMaxTradeSize
        );
    }

    /**
     * ONLY EOA: Call gulp on the CompoundLeverageModule. Gulp will claim COMP from liquidity mining and sell for more collateral asset, which effectively distributes to
     * SetToken holders and reduces the interest rate paid for borrowing. Rebalance must not be in progress. Anyone callable
     */
    function gulp() external noRebalanceInProgress onlyEOA {
        bytes memory gulpCallData = abi.encodeWithSignature(
            "gulp(address,address,uint256,string,bytes)",
            address(contractSettings.setToken),
            contractSettings.collateralAsset,
            0,
            executionSettings.exchangeName,
            executionSettings.exchangeData
        );

        invokeManager(address(contractSettings.leverageModule), gulpCallData);
    }

    /**
     * OPERATOR ONLY: Set methodology settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newMethodologySettings          Struct containing methodology parameters
     */
    function setMethodologySettings(MethodologySettings memory _newMethodologySettings) external onlyOperator noRebalanceInProgress {
        methodologySettings = _newMethodologySettings;

        _validateSettings(methodologySettings, executionSettings, incentiveSettings);

        emit MethodologySettingsUpdated(
            methodologySettings.targetLeverageRatio,
            methodologySettings.minLeverageRatio,
            methodologySettings.maxLeverageRatio,
            methodologySettings.recenteringSpeed,
            methodologySettings.rebalanceInterval
        );
    }

    /**
     * OPERATOR ONLY: Set execution settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newExecutionSettings          Struct containing execution parameters
     */
    function setExecutionSettings(ExecutionSettings memory _newExecutionSettings) external onlyOperator noRebalanceInProgress {
        executionSettings = _newExecutionSettings;

        _validateSettings(methodologySettings, executionSettings, incentiveSettings);

        emit ExecutionSettingsUpdated(
            executionSettings.unutilizedLeveragePercentage,
            executionSettings.twapMaxTradeSize,
            executionSettings.twapCooldownPeriod,
            executionSettings.slippageTolerance,
            executionSettings.exchangeName,
            executionSettings.exchangeData
        );
    }

    /**
     * OPERATOR ONLY: Set incentive settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newIncentiveSettings          Struct containing incentive parameters
     */
    function setIncentiveSettings(IncentiveSettings memory _newIncentiveSettings) external onlyOperator noRebalanceInProgress {
        incentiveSettings = _newIncentiveSettings;

        _validateSettings(methodologySettings, executionSettings, incentiveSettings);

        emit IncentiveSettingsUpdated(
            incentiveSettings.etherReward,
            incentiveSettings.incentivizedLeverageRatio,
            incentiveSettings.incentivizedSlippageTolerance,
            incentiveSettings.incentivizedTwapCooldownPeriod,
            incentiveSettings.incentivizedTwapMaxTradeSize
        );
    }
    
    /**
     * OPERATOR ONLY: Withdraw entire balance of ETH in this contract to operator. Rebalance must not be in progress
     */
    function withdrawEtherBalance() external onlyOperator noRebalanceInProgress {
        msg.sender.transfer(address(this).balance);
    }

    /**
     * OPERATOR ONLY: Toggle ability for passed addresses to trade from current state 
     *
     * @param _traders           Array trader addresses to toggle status
     */
    function updateTraderStatus(address[] calldata _traders, bool[] calldata _statuses) external onlyOperator noRebalanceInProgress {
        require(_traders.length == _statuses.length, "Array length mismatch");
        require(_traders.length > 0, "Array length must be > 0");
        require(!_traders.hasDuplicate(), "Cannot duplicate traders");

        for (uint256 i = 0; i < _traders.length; i++) {
            address trader = _traders[i];
            bool status = _statuses[i];
            callAllowList[trader] = status;
            emit TraderStatusUpdated(trader, status);
        }
    }

    /**
     * OPERATOR ONLY: Toggle whether anyone can trade, bypassing the traderAllowList 
     *
     * @param _status           Boolean indicating whether to allow anyone trade
     */
    function updateAnyoneTrade(bool _status) external onlyOperator noRebalanceInProgress {
        anyoneCallable = _status;
        emit AnyoneTradeUpdated(_status);
    }

    receive() external payable {}

    /* ============ External Getter Functions ============ */

    /**
     * Get current leverage ratio. Current leverage ratio is defined as the USD value of the collateral divided by the USD value of the SetToken. Prices for collateral
     * and borrow asset are retrieved from the Compound Price Oracle.
     *
     * return currentLeverageRatio         Current leverage ratio in precise units (10e18)
     */
    function getCurrentLeverageRatio() public view returns(uint256) {
        ActionInfo memory currentLeverageInfo = _createActionInfo();

        return _calculateCurrentLeverageRatio(currentLeverageInfo.collateralValue, currentLeverageInfo.borrowValue);
    }

    /**
     * Get current Ether incentive for when current leverage ratio exceeds incentivized leverage ratio and ripcord can be called
     *
     * return etherReward               Quantity of ETH reward in base units (10e18)
     */
    function getCurrentEtherIncentive() external view returns(uint256) {
        uint256 currentLeverageRatio = getCurrentLeverageRatio();

        if (currentLeverageRatio >= incentiveSettings.incentivizedLeverageRatio) {
            // If ETH reward is below the balance on this contract, then return ETH balance on contract instead
            return incentiveSettings.etherReward < address(this).balance ? incentiveSettings.etherReward : address(this).balance;
        } else {
            return 0;
        }
    }

    /**
     * Helper that checks if conditions are met for rebalance or ripcord. Returns an enum with 0 = no rebalance, 1 = call rebalance(), 2 = call ripcord()
     *
     * return ShouldRebalance         Enum detailing whether to rebalance, ripcord or no action
     */
    function shouldRebalance() external view returns(ShouldRebalance) {
        uint256 currentLeverageRatio = getCurrentLeverageRatio();

        // Check TWAP states first for ripcord and regular rebalances
        if (twapLeverageRatio != 0) {
            // Check incentivized cooldown period has elapsed for ripcord
            if (
                currentLeverageRatio >= incentiveSettings.incentivizedLeverageRatio
                && lastTradeTimestamp.add(incentiveSettings.incentivizedTwapCooldownPeriod) < block.timestamp
            ) {
                return ShouldRebalance.RIPCORD;
            }

            // Check cooldown period has elapsed for rebalance
            if (
                currentLeverageRatio < incentiveSettings.incentivizedLeverageRatio
                && lastTradeTimestamp.add(executionSettings.twapCooldownPeriod) < block.timestamp
            ) {
                return ShouldRebalance.REBALANCE;
            }
        } else {
            // If not TWAP, then check that current leverage is above ripcord threshold
            if (currentLeverageRatio >= incentiveSettings.incentivizedLeverageRatio) {
                return ShouldRebalance.RIPCORD;
            }

            // If not TWAP, then check that either rebalance interval has elapsed, current leverage is above max or current leverage is below min
            if (
                block.timestamp.sub(lastTradeTimestamp) > methodologySettings.rebalanceInterval
                || currentLeverageRatio > methodologySettings.maxLeverageRatio
                || currentLeverageRatio < methodologySettings.minLeverageRatio
            ) {
                return ShouldRebalance.REBALANCE;
            }
        }

        // If none of the above conditions are satisfied, then should not rebalance
        return ShouldRebalance.NONE;
    }

    /* ============ Internal Functions ============ */

    /**
     * Calculate notional rebalance quantity, whether to chunk rebalance based on max trade size and max borrow. Invoke lever on CompoundLeverageModule.
     * All state update on this contract will be at the end in the updateTradeState function. The new leverage ratio will be stored as the TWAP leverage
     * ratio if the chunk size is not equal to total notional and new leverage ratio is not equal to the existing TWAP leverage ratio. If chunk size is
     * the same as calculated total notional, then clear the TWAP leverage ratio state.
     */
    function _lever(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        ActionInfo memory _actionInfo
    )
        internal
    {
        // Get total amount of collateral that needs to be rebalanced
        uint256 totalRebalanceNotional = _newLeverageRatio
            .sub(_currentLeverageRatio)
            .preciseDiv(_currentLeverageRatio)
            .preciseMul(_actionInfo.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowCollateral(_actionInfo, true);

        uint256 chunkRebalanceNotional = Math.min(Math.min(maxBorrow, totalRebalanceNotional), executionSettings.twapMaxTradeSize);

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_actionInfo.setTotalSupply);

        uint256 borrowUnits = _calculateBorrowUnits(collateralRebalanceUnits, _actionInfo);

        uint256 minReceiveUnits = _calculateMinCollateralReceiveUnits(collateralRebalanceUnits);

        bytes memory leverCallData = abi.encodeWithSignature(
            "lever(address,address,address,uint256,uint256,string,bytes)",
            address(contractSettings.setToken),
            contractSettings.borrowAsset,
            contractSettings.collateralAsset,
            borrowUnits,
            minReceiveUnits,
            executionSettings.exchangeName,
            executionSettings.exchangeData
        );

        invokeManager(address(contractSettings.leverageModule), leverCallData);

        _updateTradeState(chunkRebalanceNotional, totalRebalanceNotional, _newLeverageRatio);
    }

    /**
     * Calculate notional rebalance quantity, whether to chunk rebalance based on max trade size and max borrow. Invoke delever on CompoundLeverageModule.
     * For ripcord, the slippage tolerance, and TWAP max trade size use the incentivized parameters.
     */
    function _delever(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        ActionInfo memory _actionInfo,
        uint256 _slippageTolerance,
        uint256 _twapMaxTradeSize
    )
        internal
    {
        // Get total amount of collateral that needs to be rebalanced
        uint256 totalRebalanceNotional = _currentLeverageRatio
            .sub(_newLeverageRatio)
            .preciseDiv(_currentLeverageRatio)
            .preciseMul(_actionInfo.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowCollateral(_actionInfo, false);

        uint256 chunkRebalanceNotional = Math.min(Math.min(maxBorrow, totalRebalanceNotional), _twapMaxTradeSize);

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_actionInfo.setTotalSupply);

        uint256 minRepayUnits = _calculateMinRepayUnits(collateralRebalanceUnits, _slippageTolerance, _actionInfo);

        bytes memory deleverCallData = abi.encodeWithSignature(
            "delever(address,address,address,uint256,uint256,string,bytes)",
            address(contractSettings.setToken),
            contractSettings.collateralAsset,
            contractSettings.borrowAsset,
            collateralRebalanceUnits,
            minRepayUnits,
            executionSettings.exchangeName,
            executionSettings.exchangeData
        );

        invokeManager(address(contractSettings.leverageModule), deleverCallData);

        _updateTradeState(chunkRebalanceNotional, totalRebalanceNotional, _newLeverageRatio);
    }

    /**
     * If in the midst of a TWAP rebalance (twapLeverageRatio is nonzero), check if current leverage ratio has move advantageously
     * and update state and skip rest of trade execution. For levering (twapLeverageRatio < targetLeverageRatio), check if the current
     * leverage ratio surpasses the stored TWAP leverage ratio. For delever (twapLeverageRatio > targetLeverageRatio), check if the
     * current leverage ratio has dropped below the stored TWAP leverage ratio. In both cases, update the trade state and return true.
     *
     * return bool          Boolean indicating if we should skip the rest of the rebalance execution
     */
    function _updateStateAndExitIfAdvantageous(uint256 _currentLeverageRatio) internal returns (bool) {
        if (
            (twapLeverageRatio < methodologySettings.targetLeverageRatio && _currentLeverageRatio >= twapLeverageRatio) 
            || (twapLeverageRatio > methodologySettings.targetLeverageRatio && _currentLeverageRatio <= twapLeverageRatio)
        ) {
            // Update trade timestamp and delete TWAP leverage ratio. Setting chunk and total rebalance notional to 0 will delete
            // TWAP state
            _updateTradeState(0, 0, 0);

            return true;
        } else {
            return false;
        }
    }

    /**
     * Update state on this strategy adapter to track last trade timestamp and whether to clear TWAP leverage ratio or store new TWAP
     * leverage ratio. There are 3 cases to consider:
     * - End TWAP / regular rebalance: if chunk size is equal to total notional, then rebalances are not chunked and clear TWAP state.
     * - Start TWAP: If chunk size is different from total notional and the new leverage ratio is not already stored, then set TWAP ratio.
     * - Continue TWAP: If chunk size is different from total notional, and new leverage ratio is already stored, then do not set the new 
     * TWAP ratio.
     */
    function _updateTradeState(
        uint256 _chunkRebalanceNotional,
        uint256 _totalRebalanceNotional,
        uint256 _newLeverageRatio
    )
        internal
    {
        lastTradeTimestamp = block.timestamp;

        // If the chunk size is equal to the total notional meaning that rebalances are not chunked, then clear TWAP state.
        if (_chunkRebalanceNotional == _totalRebalanceNotional) {
            delete twapLeverageRatio;
        }

        // If currently in the midst of TWAP, the new leverage ratio will already have been set to the twapLeverageRatio 
        // in the rebalance() function and this check will be skipped.
        if(_chunkRebalanceNotional != _totalRebalanceNotional && _newLeverageRatio != twapLeverageRatio) {
            twapLeverageRatio = _newLeverageRatio;
        }
    }

    /**
     * Transfer ETH reward to caller of the ripcord function. If the ETH balance on this contract is less than required 
     * incentive quantity, then transfer contract balance instead to prevent reverts.
     */
    function _transferEtherRewardToCaller(uint256 _etherReward) internal {
        _etherReward < address(this).balance ? msg.sender.transfer(_etherReward) : msg.sender.transfer(address(this).balance);
    }

    /**
     * Create the action info struct to be used in internal functions
     *
     * return ActionInfo                Struct containing data used by internal lever and delever functions
     */
    function _createActionInfo() internal view returns(ActionInfo memory) {
        ActionInfo memory rebalanceInfo;

        // IMPORTANT: Compound oracle returns prices adjusted for decimals. USDC is 6 decimals so $1 * 10^18 * 10^18 / 10^6 = 10^30
        rebalanceInfo.collateralPrice = contractSettings.priceOracle.getUnderlyingPrice(address(contractSettings.targetCollateralCToken));
        rebalanceInfo.borrowPrice = contractSettings.priceOracle.getUnderlyingPrice(address(contractSettings.targetBorrowCToken));

        // Calculate stored exchange rate which does not trigger a state update
        uint256 cTokenBalance = contractSettings.targetCollateralCToken.balanceOf(address(contractSettings.setToken));
        rebalanceInfo.collateralBalance = cTokenBalance.preciseMul(contractSettings.targetCollateralCToken.exchangeRateStored());
        rebalanceInfo.borrowBalance = contractSettings.targetBorrowCToken.borrowBalanceStored(address(contractSettings.setToken));
        rebalanceInfo.collateralValue = rebalanceInfo.collateralPrice.preciseMul(rebalanceInfo.collateralBalance);
        rebalanceInfo.borrowValue = rebalanceInfo.borrowPrice.preciseMul(rebalanceInfo.borrowBalance);
        rebalanceInfo.setTotalSupply = contractSettings.setToken.totalSupply();

        return rebalanceInfo;
    }

    /**
     * Calculate the new leverage ratio using the flexible leverage methodology. The methodology reduces the size of each rebalance by weighting
     * the current leverage ratio against the target leverage ratio by the recentering speed percentage. The lower the recentering speed, the slower
     * the leverage token will move towards the target leverage each rebalance.
     *
     * return uint256          New leverage ratio based on the flexible leverage methodology
     */
    function _calculateNewLeverageRatio(uint256 _currentLeverageRatio) internal view returns(uint256) {
        // CLRt+1 = max(MINLR, min(MAXLR, CLRt * (1 - RS) + TLR * RS))
        uint256 a = methodologySettings.targetLeverageRatio.preciseMul(methodologySettings.recenteringSpeed);
        uint256 b = PreciseUnitMath.preciseUnit().sub(methodologySettings.recenteringSpeed).preciseMul(_currentLeverageRatio);
        uint256 c = a.add(b);
        uint256 d = Math.min(c, methodologySettings.maxLeverageRatio);
        return Math.max(methodologySettings.minLeverageRatio, d);
    }

    /**
     * Calculate the max borrow / repay amount allowed in collateral units for lever / delever. This is due to overcollateralization requirements on
     * assets deposited in lending protocols for borrowing.
     * 
     * For lever, max borrow is calculated as:
     * (Net borrow limit in USD - existing borrow value in USD) / collateral asset price adjusted for decimals
     *
     * For delever, max borrow is calculated as:
     * Collateral balance in base units * (net borrow limit in USD - existing borrow value in USD) / net borrow limit in USD
     *
     * Net borrow limit is calculated as:
     * The collateral value in USD * Compound collateral factor * (1 - unutilized leverage %)
     *
     * return uint256          Max borrow notional denominated in collateral asset
     */
    function _calculateMaxBorrowCollateral(ActionInfo memory _actionInfo, bool _isLever) internal view returns(uint256) {
        // Retrieve collateral factor which is the % increase in borrow limit in precise units (75% = 75 * 1e16)
        ( , uint256 collateralFactorMantissa, ) = contractSettings.comptroller.markets(address(contractSettings.targetCollateralCToken));

        uint256 netBorrowLimit = _actionInfo.collateralValue
            .preciseMul(collateralFactorMantissa)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(executionSettings.unutilizedLeveragePercentage));

        if (_isLever) {
            return netBorrowLimit
                .sub(_actionInfo.borrowValue)
                .preciseDiv(_actionInfo.collateralPrice);
        } else {
            return _actionInfo.collateralBalance
                .preciseMul(netBorrowLimit.sub(_actionInfo.borrowValue))
                .preciseDiv(netBorrowLimit);
        }
    }

    /**
     * Derive the borrow units for lever. The units are calculated by the collateral units multiplied by collateral / borrow asset price adjusted
     * for decimals.
     *
     * return uint256           Position units to borrow
     */
    function _calculateBorrowUnits(uint256 _collateralRebalanceUnits, ActionInfo memory _actionInfo) internal pure returns (uint256) {
        return _collateralRebalanceUnits.preciseMul(_actionInfo.collateralPrice).preciseDiv(_actionInfo.borrowPrice);
    }

    /**
     * Calculate the min receive units in collateral units for lever. Units are calculated as target collateral rebalance units multiplied by slippage tolerance
     *
     * return uint256           Min position units to receive after lever trade
     */
    function _calculateMinCollateralReceiveUnits(uint256 _collateralRebalanceUnits) internal view returns (uint256) {
        return _collateralRebalanceUnits.preciseMul(PreciseUnitMath.preciseUnit().sub(executionSettings.slippageTolerance));
    }

    /**
     * Derive the min repay units from collateral units for delever. Units are calculated as target collateral rebalance units multiplied by slippage tolerance
     * and pair price (collateral oracle price / borrow oracle price) adjusted for decimals.
     *
     * return uint256           Min position units to repay in borrow asset
     */
    function _calculateMinRepayUnits(uint256 _collateralRebalanceUnits, uint256 _slippageTolerance, ActionInfo memory _actionInfo) internal pure returns (uint256) {
        return _collateralRebalanceUnits
            .preciseMul(_actionInfo.collateralPrice)
            .preciseDiv(_actionInfo.borrowPrice)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(_slippageTolerance));
    }

     /**
     * Validate settings in constructor and setters when updating.
     */
    function _validateSettings(
        MethodologySettings memory _methodologySettings,
        ExecutionSettings memory _executionSettings,
        IncentiveSettings memory _incentiveSettings
    )
        internal
        pure
    {
        require (
            _methodologySettings.minLeverageRatio <= _methodologySettings.targetLeverageRatio,
            "Must be valid min leverage"
        );
        require (
            _methodologySettings.maxLeverageRatio >= _methodologySettings.targetLeverageRatio,
            "Must be valid max leverage"
        );
        require (
            _methodologySettings.recenteringSpeed <= PreciseUnitMath.preciseUnit() && _methodologySettings.recenteringSpeed > 0,
            "Must be valid recentering speed"
        );
        require (
            _executionSettings.unutilizedLeveragePercentage <= PreciseUnitMath.preciseUnit(),
            "Unutilized leverage must be <100%"
        );
        require (
            _executionSettings.slippageTolerance <= PreciseUnitMath.preciseUnit(),
            "Slippage tolerance must be <100%"
        );
        require (
            _incentiveSettings.incentivizedSlippageTolerance <= PreciseUnitMath.preciseUnit(),
            "Incentivized slippage tolerance must be <100%"
        );
        require (
            _incentiveSettings.incentivizedLeverageRatio >= _methodologySettings.maxLeverageRatio,
            "Incentivized leverage ratio must be > max leverage ratio"
        );
        require (
            _methodologySettings.rebalanceInterval >= _executionSettings.twapCooldownPeriod,
            "Rebalance interval must be greater than TWAP cooldown period"
        );
        require (
            _executionSettings.twapCooldownPeriod >= _incentiveSettings.incentivizedTwapCooldownPeriod,
            "TWAP cooldown must be greater than incentivized TWAP cooldown"
        );
        require (
            _executionSettings.twapMaxTradeSize <= _incentiveSettings.incentivizedTwapMaxTradeSize,
            "TWAP max trade size must be less than incentivized TWAP max trade size"
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
}