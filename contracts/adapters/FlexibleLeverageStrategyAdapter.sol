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

import { BaseAdapter } from "../lib/BaseAdapter.sol";
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
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
 * protocol where module interactions are invoked via the IBaseManager contract. Any leveraged token can be constructed as long as the collateral and borrow
 * asset is available on Compound. This adapter contract also allows the operator to set an ETH reward to incentivize keepers calling the rebalance function at
 * different leverage thresholds.
 */
contract FlexibleLeverageStrategyAdapter is BaseAdapter {
    using Address for address;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Enums ============ */

    enum ShouldRebalance {
        NONE,                   // Indicates no rebalance action can be taken
        REBALANCE,              // Indicates rebalance() function can be successfully called
        ITERATE_REBALANCE,      // Indicates iterateRebalance() function can be successfully called
        RIPCORD                 // Indicates ripcord() function can be successfully called
    }

    /* ============ Structs ============ */

    struct ActionInfo {
        uint256 collateralPrice;                        // Price of underlying in precise units (10e18)
        uint256 borrowPrice;                            // Price of underlying in precise units (10e18)
        uint256 collateralBalance;                      // Balance of underlying held in Compound in base units (e.g. USDC 10e6)
        uint256 borrowBalance;                          // Balance of underlying borrowed from Compound in base units
        uint256 collateralValue;                        // Valuation in USD adjusted for decimals in precise units (10e18)
        uint256 borrowValue;                            // Valuation in USD adjusted for decimals in precise units (10e18)
        uint256 setTotalSupply;                         // Total supply of SetToken
    }

     struct LeverageInfo {
        ActionInfo action;
        uint256 currentLeverageRatio;                   // Current leverage ratio of Set
        uint256 slippageTolerance;                      // Allowable percent trade slippage in preciseUnits (1% = 10^16)
        uint256 twapMaxTradeSize;                       // Max trade size in collateral units allowed for rebalance action
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

    /* ============ Modifiers ============ */

    /**
     * Throws if rebalance is currently in TWAP`
     */
    modifier noRebalanceInProgress() {
        require(twapLeverageRatio == 0, "Rebalance is currently in progress");
        _;
    }

    /* ============ State Variables ============ */

    ContractSettings public strategy;               // Struct of contracts used in the strategy (SetToken, price oracles, leverage module etc)
    MethodologySettings public methodology;         // Struct containing methodology parameters
    ExecutionSettings public execution;             // Struct containing execution parameters
    IncentiveSettings public incentive;             // Struct containing incentive parameters for ripcord
    uint256 public twapLeverageRatio;               // Stored leverage ratio to keep track of target between TWAP rebalances
    uint256 public lastTradeTimestamp;              // Last rebalance timestamp. Must be past rebalance interval to rebalance

    /* ============ Constructor ============ */

    /**
     * Instantiate addresses, methodology parameters, execution parameters, and incentive parameters.
     * 
     * @param _manager              Address of IBaseManager contract
     * @param _strategy             Struct of contract addresses
     * @param _methodology          Struct containing methodology parameters
     * @param _execution            Struct containing execution parameters
     * @param _incentive            Struct containing incentive parameters for ripcord
     */
    constructor(
        IBaseManager _manager,
        ContractSettings memory _strategy,
        MethodologySettings memory _methodology,
        ExecutionSettings memory _execution,
        IncentiveSettings memory _incentive
    )
        public
        BaseAdapter(_manager)
    {
        strategy = _strategy;
        methodology = _methodology;
        execution = _execution;
        incentive = _incentive;

        _validateSettings(methodology, execution, incentive);
    }

    /* ============ External Functions ============ */

    /**
     * OPERATOR ONLY: Engage to target leverage ratio for the first time. SetToken will borrow debt position from Compound and trade for collateral asset. If target
     * leverage ratio is above max borrow or max trade size, then TWAP is kicked off. To complete engage if TWAP, any valid caller must call iterateRebalance until target
     * is met.
     */
    function engage() external onlyOperator {
        ActionInfo memory engageInfo = _createActionInfo();

        require(engageInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(engageInfo.collateralBalance > 0, "Collateral balance must be > 0");
        require(engageInfo.borrowBalance == 0, "Debt must be 0");

        LeverageInfo memory leverageInfo = LeverageInfo({
            action: engageInfo,
            currentLeverageRatio: PreciseUnitMath.preciseUnit(), // 1x leverage in precise units
            slippageTolerance: execution.slippageTolerance,
            twapMaxTradeSize: execution.twapMaxTradeSize
        });

        // Calculate total rebalance units and kick off TWAP if above max borrow or max trade size
        (
            uint256 chunkRebalanceNotional,
            uint256 totalRebalanceNotional
        ) = _lever(leverageInfo, methodology.targetLeverageRatio);

        _updateRebalanceState(
            chunkRebalanceNotional,
            totalRebalanceNotional,
            methodology.targetLeverageRatio
        );

        emit Engaged(
            leverageInfo.currentLeverageRatio,
            methodology.targetLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional
        );
    }

    /**
     * ONLY EOA AND ALLOWED CALLER: Rebalance according to flexible leverage methodology. If current leverage ratio is between the max and min bounds, then rebalance 
     * can only be called once the rebalance interval has elapsed since last timestamp. If outside the max and min, rebalance can be called anytime to bring leverage
     * ratio back to the max or min bounds. The methodology will determine whether to delever or lever.
     *
     * Note: If the calculated current leverage ratio is above the incentivized leverage ratio or in TWAP then rebalance cannot be called. Instead, you must call
     * ripcord() which is incentivized with a reward in Ether or iterateRebalance().
     */
     function rebalance() external onlyEOA onlyAllowedCaller(msg.sender) {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(execution.slippageTolerance, execution.twapMaxTradeSize);

        _validateNormalRebalance(leverageInfo, methodology.rebalanceInterval);
        _validateNonTWAP();

        uint256 newLeverageRatio = _calculateNewLeverageRatio(leverageInfo.currentLeverageRatio);

        (
            uint256 chunkRebalanceNotional,
            uint256 totalRebalanceNotional
        ) = _handleRebalance(leverageInfo, newLeverageRatio);

        _updateRebalanceState(chunkRebalanceNotional, totalRebalanceNotional, newLeverageRatio);

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
     */
    function iterateRebalance() external onlyEOA onlyAllowedCaller(msg.sender) {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(execution.slippageTolerance, execution.twapMaxTradeSize);

        _validateNormalRebalance(leverageInfo, execution.twapCooldownPeriod);
        _validateTWAP();

        uint256 chunkRebalanceNotional;
        uint256 totalRebalanceNotional;
        if (!_isAdvantageousTWAP(leverageInfo.currentLeverageRatio)) {
            (chunkRebalanceNotional, totalRebalanceNotional) = _handleRebalance(leverageInfo, twapLeverageRatio);
        }

        // If not advantageous, then rebalance is skipped and chunk and total rebalance notional are both 0, which means TWAP state is
        // cleared
        _updateIterateState(chunkRebalanceNotional, totalRebalanceNotional);

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
     */
    function ripcord() external onlyEOA {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(
            incentive.incentivizedSlippageTolerance, 
            incentive.incentivizedTwapMaxTradeSize
        );

        _validateRipcord(leverageInfo);

        ( uint256 chunkRebalanceNotional, ) = _delever(leverageInfo, methodology.maxLeverageRatio);

        _updateRipcordState();

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
     * collateral position and trade for debt position to repay Compound. If target leverage ratio is above max borrow or max trade size, then operator must
     * continue to call this function to complete repayment of loan. The function iterateRebalance will not work
     *
     * Note: due to slippage tolerance on trades, loan value may not be entirely repaid.
     */
    function disengage() external onlyOperator {
        LeverageInfo memory leverageInfo = _getAndValidateLeveragedInfo(execution.slippageTolerance, execution.twapMaxTradeSize);

        uint256 newLeverageRatio = PreciseUnitMath.preciseUnit();

        (
            uint256 chunkRebalanceNotional,
            uint256 totalRebalanceNotional
        ) = _delever(leverageInfo, newLeverageRatio);

        emit Disengaged(
            leverageInfo.currentLeverageRatio,
            newLeverageRatio,
            chunkRebalanceNotional,
            totalRebalanceNotional
        );
    }

    /**
     * ONLY EOA: Call gulp on the CompoundLeverageModule. Gulp will claim COMP from liquidity mining and sell for more collateral asset, which effectively distributes to
     * SetToken holders and reduces the interest rate paid for borrowing. Rebalance must not be in progress. Anyone callable
     */
    function gulp() external noRebalanceInProgress onlyEOA {
        bytes memory gulpCallData = abi.encodeWithSignature(
            "gulp(address,address,uint256,string,bytes)",
            address(strategy.setToken),
            strategy.collateralAsset,
            0,
            execution.exchangeName,
            execution.exchangeData
        );

        invokeManager(address(strategy.leverageModule), gulpCallData);
    }

    /**
     * OPERATOR ONLY: Set methodology settings and check new settings are valid. Note: Need to pass in existing parameters if only changing a few settings. Must not be
     * in a rebalance.
     *
     * @param _newMethodologySettings          Struct containing methodology parameters
     */
    function setMethodologySettings(MethodologySettings memory _newMethodologySettings) external onlyOperator noRebalanceInProgress {
        methodology = _newMethodologySettings;

        _validateSettings(methodology, execution, incentive);

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

        _validateSettings(methodology, execution, incentive);

        emit ExecutionSettingsUpdated(
            execution.unutilizedLeveragePercentage,
            execution.twapMaxTradeSize,
            execution.twapCooldownPeriod,
            execution.slippageTolerance,
            execution.exchangeName,
            execution.exchangeData
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

        _validateSettings(methodology, execution, incentive);

        emit IncentiveSettingsUpdated(
            incentive.etherReward,
            incentive.incentivizedLeverageRatio,
            incentive.incentivizedSlippageTolerance,
            incentive.incentivizedTwapCooldownPeriod,
            incentive.incentivizedTwapMaxTradeSize
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
     * and borrow asset are retrieved from the Compound Price Oracle.
     *
     * return currentLeverageRatio         Current leverage ratio in precise units (10e18)
     */
    function getCurrentLeverageRatio() public view returns(uint256) {
        ActionInfo memory currentLeverageInfo = _createActionInfo();

        return _calculateCurrentLeverageRatio(currentLeverageInfo.collateralValue, currentLeverageInfo.borrowValue);
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
     * return ShouldRebalance         Enum detailing whether to rebalance, iterateRebalance, ripcord or no action
     */
    function shouldRebalance() external view returns(ShouldRebalance) {
        uint256 currentLeverageRatio = getCurrentLeverageRatio();

        // If above ripcord threshold, then check if incentivized cooldown period has elapsed
        if (currentLeverageRatio >= incentive.incentivizedLeverageRatio) {
            if (lastTradeTimestamp.add(incentive.incentivizedTwapCooldownPeriod) < block.timestamp) {
                return ShouldRebalance.RIPCORD;
            }
        } else {
            // If TWAP, then check if the cooldown period has elapsed
            if (twapLeverageRatio > 0) {
                if (lastTradeTimestamp.add(execution.twapCooldownPeriod) < block.timestamp) {
                    return ShouldRebalance.ITERATE_REBALANCE;
                }
            } else {
                // If not TWAP, then check if the rebalance interval has elapsed OR current leverage is above max leverage OR current leverage is below
                // min leverage
                if (
                    block.timestamp.sub(lastTradeTimestamp) > methodology.rebalanceInterval
                    || currentLeverageRatio > methodology.maxLeverageRatio
                    || currentLeverageRatio < methodology.minLeverageRatio
                ) {
                    return ShouldRebalance.REBALANCE;
                }
            }
        }

        // If none of the above conditions are satisfied, then should not rebalance
        return ShouldRebalance.NONE;
    }

    /* ============ Internal Functions ============ */

    /**
     * Calculate notional rebalance quantity, whether to chunk rebalance based on max trade size and max borrow and invoke lever on CompoundLeverageModule
     *
     * return uint256           Calculated notional to trade
     * return uint256           Total notional to rebalance over TWAP
     */
     function _lever(
        LeverageInfo memory _leverageInfo,
        uint256 _newLeverageRatio
    )
        internal
        returns (uint256, uint256)
    {
        // Get total amount of collateral that needs to be rebalanced
        uint256 totalRebalanceNotional = _newLeverageRatio
            .sub(_leverageInfo.currentLeverageRatio)
            .preciseDiv(_leverageInfo.currentLeverageRatio)
            .preciseMul(_leverageInfo.action.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowCollateral(_leverageInfo.action, true);

        uint256 chunkRebalanceNotional = Math.min(Math.min(maxBorrow, totalRebalanceNotional), _leverageInfo.twapMaxTradeSize);

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_leverageInfo.action.setTotalSupply);

        uint256 borrowUnits = _calculateBorrowUnits(collateralRebalanceUnits, _leverageInfo.action);

        uint256 minReceiveCollateralUnits = _calculateMinCollateralReceiveUnits(collateralRebalanceUnits, _leverageInfo.slippageTolerance);

        bytes memory leverCallData = abi.encodeWithSignature(
            "lever(address,address,address,uint256,uint256,string,bytes)",
            address(strategy.setToken),
            strategy.borrowAsset,
            strategy.collateralAsset,
            borrowUnits,
            minReceiveCollateralUnits,
            execution.exchangeName,
            execution.exchangeData
        );

        invokeManager(address(strategy.leverageModule), leverCallData);

        return (chunkRebalanceNotional, totalRebalanceNotional);
    }

    /**
     * Calculate notional rebalance quantity, whether to chunk rebalance based on max trade size and max borrow. Invoke delever on CompoundLeverageModule.
     * 
     * return uint256           Calculated notional to trade
     * return uint256           Total notional to rebalance over TWAP
     */
    function _delever(
        LeverageInfo memory _leverageInfo,
        uint256 _newLeverageRatio
    )
        internal
        returns (uint256, uint256)
    {
        // Get total amount of collateral that needs to be rebalanced
        uint256 totalRebalanceNotional = _leverageInfo.currentLeverageRatio
            .sub(_newLeverageRatio)
            .preciseDiv(_leverageInfo.currentLeverageRatio)
            .preciseMul(_leverageInfo.action.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowCollateral(_leverageInfo.action, false);

        uint256 chunkRebalanceNotional = Math.min(Math.min(maxBorrow, totalRebalanceNotional), _leverageInfo.twapMaxTradeSize);

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_leverageInfo.action.setTotalSupply);

        uint256 minRepayUnits = _calculateMinRepayUnits(collateralRebalanceUnits, _leverageInfo.slippageTolerance, _leverageInfo.action);

        bytes memory deleverCallData = abi.encodeWithSignature(
            "delever(address,address,address,uint256,uint256,string,bytes)",
            address(strategy.setToken),
            strategy.collateralAsset,
            strategy.borrowAsset,
            collateralRebalanceUnits,
            minRepayUnits,
            execution.exchangeName,
            execution.exchangeData
        );

        invokeManager(address(strategy.leverageModule), deleverCallData);

        return (chunkRebalanceNotional, totalRebalanceNotional);
    }

    /**
     * Check whether to delever or lever based on the current vs new leverage ratios. Used in the rebalance() and iterateRebalance() functions
     */
    function _handleRebalance(LeverageInfo memory _leverageInfo, uint256 _newLeverageRatio) internal returns(uint256, uint256) {
        if (_newLeverageRatio < _leverageInfo.currentLeverageRatio) {
            return _delever(_leverageInfo, _newLeverageRatio); 
        } else {
            return _lever(_leverageInfo, _newLeverageRatio);
        }
    }

    /**
     * Create the leverage info struct to be used in internal functions
     *
     * return LeverageInfo                Struct containing ActionInfo and other data
     */
    function _getAndValidateLeveragedInfo(uint256 _slippageTolerance, uint256 _maxTradeSize) internal view returns(LeverageInfo memory) {
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
            twapMaxTradeSize: _maxTradeSize
        });
    }

    /**
     * Create the action info struct to be used in internal functions
     *
     * return ActionInfo                Struct containing data used by internal lever and delever functions
     */
    function _createActionInfo() internal view returns(ActionInfo memory) {
        ActionInfo memory rebalanceInfo;

        // IMPORTANT: Compound oracle returns prices adjusted for decimals. USDC is 6 decimals so $1 * 10^18 * 10^18 / 10^6 = 10^30
        rebalanceInfo.collateralPrice = strategy.priceOracle.getUnderlyingPrice(address(strategy.targetCollateralCToken));
        rebalanceInfo.borrowPrice = strategy.priceOracle.getUnderlyingPrice(address(strategy.targetBorrowCToken));

        // Calculate stored exchange rate which does not trigger a state update
        uint256 cTokenBalance = strategy.targetCollateralCToken.balanceOf(address(strategy.setToken));
        rebalanceInfo.collateralBalance = cTokenBalance.preciseMul(strategy.targetCollateralCToken.exchangeRateStored());
        rebalanceInfo.borrowBalance = strategy.targetBorrowCToken.borrowBalanceStored(address(strategy.setToken));
        rebalanceInfo.collateralValue = rebalanceInfo.collateralPrice.preciseMul(rebalanceInfo.collateralBalance);
        rebalanceInfo.borrowValue = rebalanceInfo.borrowPrice.preciseMul(rebalanceInfo.borrowBalance);
        rebalanceInfo.setTotalSupply = strategy.setToken.totalSupply();

        return rebalanceInfo;
    }

    /**
     * Validate settings in constructor and setters when updating.
     */
    function _validateSettings(
        MethodologySettings memory _methodology,
        ExecutionSettings memory _execution,
        IncentiveSettings memory _incentive
    )
        internal
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
        require (
            _execution.twapMaxTradeSize <= _incentive.incentivizedTwapMaxTradeSize,
            "TWAP max trade size must be less than incentivized TWAP max trade size"
        );
    }

    /**
     * Validate that current leverage is below incentivized leverage ratio and cooldown / rebalance period has elapsed or outsize max/min bounds. Used
     * in rebalance() and iterateRebalance() functions
     */
    function _validateNormalRebalance(LeverageInfo memory _leverageInfo, uint256 _coolDown) internal view {
        require(_leverageInfo.currentLeverageRatio < incentive.incentivizedLeverageRatio, "Must be below incentivized leverage ratio");
        require(
            block.timestamp.sub(lastTradeTimestamp) > _coolDown
            || _leverageInfo.currentLeverageRatio > methodology.maxLeverageRatio
            || _leverageInfo.currentLeverageRatio < methodology.minLeverageRatio,
            "Cooldown not elapsed or not valid leverage ratio"
        );
    }

    /**
     * Validate that current leverage is above incentivized leverage ratio and incentivized cooldown period has elapsed in ripcord()
     */
    function _validateRipcord(LeverageInfo memory _leverageInfo) internal view {
        require(_leverageInfo.currentLeverageRatio >= incentive.incentivizedLeverageRatio, "Must be above incentivized leverage ratio");
        // If currently in the midst of a TWAP rebalance, ensure that the cooldown period has elapsed
        require(lastTradeTimestamp.add(incentive.incentivizedTwapCooldownPeriod) < block.timestamp, "TWAP cooldown must have elapsed");
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
     * Calculate the new leverage ratio using the flexible leverage methodology. The methodology reduces the size of each rebalance by weighting
     * the current leverage ratio against the target leverage ratio by the recentering speed percentage. The lower the recentering speed, the slower
     * the leverage token will move towards the target leverage each rebalance.
     *
     * return uint256          New leverage ratio based on the flexible leverage methodology
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
        ( , uint256 collateralFactorMantissa, ) = strategy.comptroller.markets(address(strategy.targetCollateralCToken));

        uint256 netBorrowLimit = _actionInfo.collateralValue
            .preciseMul(collateralFactorMantissa)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(execution.unutilizedLeveragePercentage));

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
     * Derive the borrow units for lever. The units are calculated by the collateral units multiplied by collateral / borrow asset price. Compound oracle prices
     * already adjust for decimals in the token.
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
    function _calculateMinCollateralReceiveUnits(uint256 _collateralRebalanceUnits, uint256 _slippageTolerance) internal pure returns (uint256) {
        return _collateralRebalanceUnits.preciseMul(PreciseUnitMath.preciseUnit().sub(_slippageTolerance));
    }

    /**
     * Derive the min repay units from collateral units for delever. Units are calculated as target collateral rebalance units multiplied by slippage tolerance
     * and pair price (collateral oracle price / borrow oracle price). Compound oracle prices already adjust for decimals in the token.
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
     * Update last trade timestamp and if chunk rebalance size is less than total rebalance notional, store new leverage ratio to kick off TWAP. Used in
     * the engage() and rebalance() functions
     */
    function _updateRebalanceState(
        uint256 _chunkRebalanceNotional,
        uint256 _totalRebalanceNotional,
        uint256 _newLeverageRatio
    )
        internal
    {
        lastTradeTimestamp = block.timestamp;

        if (_chunkRebalanceNotional < _totalRebalanceNotional) {
            twapLeverageRatio = _newLeverageRatio;
        }
    }

    /**
     * Update last trade timestamp and if chunk rebalance size is equal to the total rebalance notional, end TWAP by clearing state. This function is used
     * in iterateRebalance()
     */
    function _updateIterateState(uint256 _chunkRebalanceNotional, uint256 _totalRebalanceNotional) internal {
        lastTradeTimestamp = block.timestamp;

        // If the chunk size is equal to the total notional meaning that rebalances are not chunked, then clear TWAP state.
        if (_chunkRebalanceNotional == _totalRebalanceNotional) {
            delete twapLeverageRatio;
        }        
    }

    /**
     * Update last trade timestamp and if currently in a TWAP, delete the TWAP state. Used in the ripcord() function.
     */
    function _updateRipcordState() internal {
        lastTradeTimestamp = block.timestamp;

        // If TWAP leverage ratio is stored, then clear state. This may happen if we are currently in a TWAP rebalance, and the leverage ratio moves above the
        // incentivized threshold for ripcord.
        if (twapLeverageRatio > 0) {
            delete twapLeverageRatio;
        }
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
}