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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";

import { ISetToken } from "../interfaces/ISetToken.sol";
import { IComptroller } from "../interfaces/IComptroller.sol";
import { ICompoundLeverageModule } from "../interfaces/ICompoundLeverageModule.sol";
import { ICompoundPriceOracle } from "../interfaces/ICompoundPriceOracle.sol";
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { IICManagerV2 } from "../interfaces/IICManagerV2.sol";
import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { BaseAdapter } from "../lib/BaseAdapter.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

contract FlexibleLeverageStrategyAdapter is BaseAdapter {
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using Address for address;

    /* ============ Structs ============ */

    struct ActionInfo {
        uint256 collateralPrice;                   // Price of collateral asset in precise units (10e18)
        uint256 borrowPrice;                       // Price of borrow asset in precise units (10e18)
        uint256 collateralBalance;                 // Balance of collateral assets held in Compound
        uint256 borrowBalance;                     // Balance of borrow asset borrowed from Compound
        uint256 collateralValue;                   // Valuation of collateral asset in USD
        uint256 borrowValue;                       // Valuation of borrow asset in USD
        uint256 setTotalSupply;                    // Total supply of SetToken
    }

    struct TwapState {
        uint256 lastTWAPTradeTimestamp;            // Timestamp of last TWAP trade
        uint256 twapNewLeverageRatio;              // Stored new TWAP leverage ratio`
    }

    /* ============ Modifiers ============ */

    /**
     * Throws if rebalance is currently in TWAP`
     */
    modifier noRebalanceInProgress() {
        require(!isTWAP, "Rebalance is currently in progress");
        _;
    }

    /* ============ State Variables ============ */

    ISetToken public setToken;                              // Instance of levered SetToken
    ICompoundLeverageModule public leverageModule;          // Instance of Compound leverage module

    IComptroller public comptroller;                        // Instance of Comptroller
    ICompoundPriceOracle public priceOracle;                // Compound oracle feed

    ICErc20 public targetCollateralCToken;                  // Instance of target collateral cToken asset
    ICErc20 public targetBorrowCToken;                      // Instance of target borrow cToken asset
    address public collateralAsset;                         // Address of underlying collateral
    address public borrowAsset;                             // Address of underlying borrow asset
    uint256 public collateralAssetDecimals;                 // Decimals of collateral asset
    uint256 public borrowAssetDecimals;                     // Decimals of borrow asset
    
    uint256 public targetLeverageRatio;                     // Target leverage ratio
    uint256 public minLeverageRatio;                        // Min leverage ratio
    uint256 public maxLeverageRatio;                        // Max leverage ratio
    uint256 public recenteringSpeed;                        // Speed at which to rebalance back to target leverage
    uint256 public rebalanceInterval;                       // Rebalance interval in seconds

    uint256 public bufferPercentage;                        // Percent of max borrow left unutilized leverage
    uint256 public maxTradeSize;                            // Max trade size for TWAP in base units
    uint256 public twapCooldown;                            // Cooldown period for TWAP
    uint256 public slippageTolerance;                       // Slippage tolerance % in precise units to price min receive quantities

    uint256 public incentivizedMaxTradeSize;                // Max trade size for incentivized rebalances in collateral base units
    uint256 public incentivizedTwapCooldown;                // TWAP cooldown in seconds incentivized rebalances
    uint256 public incentivizedSlippageTolerance;           // Slippage tolerance percentage for incentivized rebalances
    uint256 public incentivizedTierTwoEthReward;            // Higher tier of ETH reward for incentivized rebalances
    uint256 public incentivizedTierOneEthReward;            // Lower tier of ETH reward for incentivized rebalances
    uint256 public incentivizedTierTwoLeverageRatio;        // Higher tier of leverage ratio for incentivized rebalances
    uint256 public incentivizedTierOneLeverageRatio;        // Lower tier of leverage ratio for incentivized rebalances

    string public exchangeName;                             // Name of exchange that is being used for leverage
    bytes public exchangeData;                              // Arbitrary exchange data passed into rebalance function

    bool public isTWAP;                                     // Check if it currently is rebalancing
    TwapState public twapState;                             // TWAP state struct
    uint256 public lastRebalanceTimestamp;                  // Last rebalance timestamp. Must be past rebalance interval to rebalance

    bool public isEngaged;                                  // Check if engaged

    /* ============ Constructor ============ */

    /**
     * Instantiate addresses, asset decmials, methodology parameters, execution parameters, and initial exchange name and data
     * 
     * @param _instances               Array of contract addresses
     * @param _assetDecimals           Decimals for collateral and borrow assets
     * @param _methodologyParams       Parameters of flexible leverage methodology
     * @param _executionParams         Trade execution parameters
     * @param _incentiveParams         Rebalance parameters for when leverage ratio exceeds threshold for incentives
     * @param _initialExchangeName     Initial exchange name for execution
     * @param _initialExchangeData     Arbitrary bytes used by exchange
     */
    constructor(
        address[9] memory _instances,
        uint256[2] memory _assetDecimals,
        uint256[5] memory _methodologyParams,
        uint256[4] memory _executionParams,
        uint256[7] memory _incentiveParams,
        string memory _initialExchangeName,
        bytes memory _initialExchangeData
    )
        public
    {
        setToken = ISetToken(_instances[0]);
        leverageModule = ICompoundLeverageModule(_instances[1]);
        manager = IICManagerV2(_instances[2]);
        comptroller = IComptroller(_instances[3]);
        priceOracle = ICompoundPriceOracle(_instances[4]);
        targetCollateralCToken = ICErc20(_instances[5]);
        targetBorrowCToken = ICErc20(_instances[6]);
        collateralAsset = _instances[7];
        borrowAsset = _instances[8];

        collateralAssetDecimals = _assetDecimals[0];
        borrowAssetDecimals = _assetDecimals[1];

        targetLeverageRatio = _methodologyParams[0];
        minLeverageRatio = _methodologyParams[1];
        maxLeverageRatio = _methodologyParams[2];
        recenteringSpeed = _methodologyParams[3];
        rebalanceInterval = _methodologyParams[4];

        bufferPercentage = _executionParams[0];
        maxTradeSize = _executionParams[1];
        twapCooldown = _executionParams[2];
        slippageTolerance = _executionParams[3];

        incentivizedMaxTradeSize = _incentiveParams[0];
        incentivizedTwapCooldown = _incentiveParams[1];
        incentivizedSlippageTolerance = _incentiveParams[2];
        incentivizedTierTwoEthReward = _incentiveParams[3];
        incentivizedTierOneEthReward = _incentiveParams[4];
        incentivizedTierTwoLeverageRatio = _incentiveParams[5];
        incentivizedTierOneLeverageRatio = _incentiveParams[6];

        exchangeName = _initialExchangeName;
        exchangeData = _initialExchangeData;
    }

    /* ============ External Functions ============ */

    /**
     * OPERATOR ONLY: Engage to target leverage. 
     */
    function engage() external onlyOperator {
        require(!isEngaged, "Must not be engaged");

        ActionInfo memory engageInfo = _createActionInfo();

        require(engageInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(engageInfo.borrowBalance == 0, "Debt must be 0");
        require(engageInfo.collateralBalance > 0, "Collateral balance must be > 0");

        _lever(
            PreciseUnitMath.preciseUnit(), // 1x leverage in precise units
            targetLeverageRatio,
            engageInfo
        );

        isEngaged = true;
        lastRebalanceTimestamp = block.timestamp;
    }

    /**
     * ONLY EOA: Rebalance according to flexible leverage methodology. Rebalance will calculate whether to call delever or lever depending on conditions. 
     * For delever, if above the tiered incentive leverage ratio, there will be an ETH reward for anyone that calls this function. Anyone callable.
     *
     * Note: There may be scenarios in a TWAP rebalance where delevering once does not bring the leverage ratio below the incentives threshold. In this case,
     * callers will continue to receive ETH rewards depending on the incentive tier
     */
    function rebalance() external onlyEOA {
        require(isEngaged, "Must be engaged");

        ActionInfo memory rebalanceInfo = _createActionInfo();

        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            rebalanceInfo.collateralValue,
            rebalanceInfo.borrowValue
        );

        // Validate if rebalance is ready, and set new rebalance timestamp
        _validateRebalanceAndSetTimestamp(currentLeverageRatio);

        uint256 newLeverageRatio = _calculateNewLeverageRatio(currentLeverageRatio);
        
        if (newLeverageRatio < currentLeverageRatio) {
            _delever(
                currentLeverageRatio,
                newLeverageRatio,
                rebalanceInfo
            );
        } else {
            _lever(
                currentLeverageRatio,
                newLeverageRatio,
                rebalanceInfo
            );
        }
    }

    /**
     * OPERATOR ONLY: Disengage strategy. Return leverage ratio to 1x and repay loan. Note: due to rounding on trades, loan value may not be entirely repaid
     */
    function disengage() external onlyOperator {
        require(isEngaged, "Must be engaged");

        ActionInfo memory disengageInfo = _createActionInfo();

        // Get current leverage ratio
        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            disengageInfo.collateralValue,
            disengageInfo.borrowValue
        );

        _delever(
            currentLeverageRatio,
            PreciseUnitMath.preciseUnit(),
            disengageInfo
        );

        isEngaged = false;
        lastRebalanceTimestamp = block.timestamp;
    }

    /**
     * ONLY EOA: Gulp COMP and sell for more collateral asset. Rebalance must not be in progress. Anyone callable
     */
    function gulp() external noRebalanceInProgress onlyEOA {
        bytes memory gulpCallData = abi.encodeWithSignature(
            "gulp(address,address,uint256,string,bytes)",
            address(setToken),
            collateralAsset,
            0,
            exchangeName,
            exchangeData
        );

        invokeManager(address(leverageModule), gulpCallData);
    }

    /**
     * OPERATOR ONLY: Set max trade size in collateral units. Rebalance must not be in progress
     *
     * @param _maxTradeSize           Max trade size in collateral units
     */
    function setMaxTradeSize(uint256 _maxTradeSize) external onlyOperator noRebalanceInProgress {
        maxTradeSize = _maxTradeSize;
    }

    /**
     * OPERATOR ONLY: Set slippage tolerance in percentage. Rebalance must not be in progress
     *
     * @param _slippageTolerance           Slippage tolerance in percentage in precise units (1% = 1e16)
     */
    function setSlippageTolerance(uint256 _slippageTolerance) external onlyOperator noRebalanceInProgress {
        slippageTolerance = _slippageTolerance;
    }

    /**
     * OPERATOR ONLY: Set exchange name. Rebalance must not be in progress
     *
     * @param _exchangeName           Name of new exchange to set
     */
    function setExchange(string memory _exchangeName) external onlyOperator noRebalanceInProgress {
        exchangeName = _exchangeName;
    }

    /**
     * OPERATOR ONLY: Set exchange data. Rebalance must not be in progress
     *
     * @param _exchangeData           Arbitrary exchange data
     */
    function setExchangeData(bytes memory _exchangeData) external onlyOperator noRebalanceInProgress {
        exchangeData = _exchangeData;
    }

    /**
     * OPERATOR ONLY: Set TWAP cooldown period. Rebalance must not be in progress
     *
     * @param _twapCooldown           New TWAP cooldown period for trade execution
     */
    function setCooldownPeriod(uint256 _twapCooldown) external onlyOperator noRebalanceInProgress {
        twapCooldown = _twapCooldown;
    }

    /**
     * OPERATOR ONLY: Set rebalance interval. Rebalance must not be in progress
     *
     * @param _rebalanceInterval      New rebalance interval
     */
    function setRebalanceInterval(uint256 _rebalanceInterval) external onlyOperator noRebalanceInProgress {
        rebalanceInterval = _rebalanceInterval;
    }

    /**
     * OPERATOR ONLY: Set buffer percentage. Rebalance must not be in progress
     *
     * @param _bufferPercentage       New buffer percentage
     */
    function setBufferPercentage(uint256 _bufferPercentage) external onlyOperator noRebalanceInProgress {
        bufferPercentage = _bufferPercentage;
    }

    /**
     * OPERATOR ONLY: Set recentering speed. Rebalance must not be in progress
     *
     * @param _recenteringSpeed       New recentering speed for methodology
     */
    function setRecenteringSpeed(uint256 _recenteringSpeed) external onlyOperator noRebalanceInProgress {
        recenteringSpeed = _recenteringSpeed;
    }

    /**
     * OPERATOR ONLY: Set min leverage ratio. Rebalance must not be in progress
     *
     * @param _minLeverageRatio       New min leverage ratio for methodology
     */
    function setMinLeverageRatio(uint256 _minLeverageRatio) external onlyOperator noRebalanceInProgress {
        minLeverageRatio = _minLeverageRatio;
    }

    /**
     * OPERATOR ONLY: Set max leverage ratio. Rebalance must not be in progress
     *
     * @param _maxLeverageRatio       New max leverage ratio for methodology
     */
    function setMaxLeverageRatio(uint256 _maxLeverageRatio) external onlyOperator noRebalanceInProgress {
        maxLeverageRatio = _maxLeverageRatio;
    }

    /**
     * OPERATOR ONLY: Set max trade size in collateral units for when rebalance is incentivized. Rebalance must not be in progress
     *
     * @param _incentivizedMaxTradeSize           Max trade size in collateral units
     */
    function setIncentivizedMaxTradeSize(uint256 _incentivizedMaxTradeSize) external onlyOperator noRebalanceInProgress {
        incentivizedMaxTradeSize = _incentivizedMaxTradeSize;
    }

    /**
     * OPERATOR ONLY: Set cooldown period in seconds for when rebalance is incentivized. Rebalance must not be in progress
     *
     * @param _incentivizedTwapCooldown           TWAP cooldown period in seconds
     */
    function setIncentivizedCooldownPeriod(uint256 _incentivizedTwapCooldown) external onlyOperator noRebalanceInProgress {
        incentivizedTwapCooldown = _incentivizedTwapCooldown;
    }

    /**
     * OPERATOR ONLY: Set tier one ETH reward when rebalance is incentivized. Rebalance must not be in progress
     *
     * @param _incentivizedTierOneEthReward           Amount of Ether
     */
    function setIncentivizedTierOneReward(uint256 _incentivizedTierOneEthReward) external onlyOperator noRebalanceInProgress {
        incentivizedTierOneEthReward = _incentivizedTierOneEthReward;
    }

    /**
     * OPERATOR ONLY: Set tier two ETH reward when rebalance is incentivized. Rebalance must not be in progress
     *
     * @param _incentivizedTierTwoEthReward           Amount of Ether
     */
    function setIncentivizedTierTwoReward(uint256 _incentivizedTierTwoEthReward) external onlyOperator noRebalanceInProgress {
        incentivizedTierTwoEthReward = _incentivizedTierTwoEthReward;
    }

    /**
     * OPERATOR ONLY: Set leverage ratio require for lower tier of ETH rewards. Rebalance must not be in progress
     *
     * @param _incentivizedTierOneLeverageRatio           Leverage ratio required to receive lower tier of ETH rewards
     */
    function setIncentivizedTierOneLeverageRatio(uint256 _incentivizedTierOneLeverageRatio) external onlyOperator noRebalanceInProgress {
        incentivizedTierOneLeverageRatio = _incentivizedTierOneLeverageRatio;
    }

    /**
     * OPERATOR ONLY: Set leverage ratio require for higher tier of ETH rewards. Rebalance must not be in progress
     *
     * @param _incentivizedTierTwoLeverageRatio           Leverage ratio required to receive higher tier of ETH rewards
     */
    function setIncentivizedTierTwoLeverageRatio(uint256 _incentivizedTierTwoLeverageRatio) external onlyOperator noRebalanceInProgress {
        incentivizedTierTwoLeverageRatio = _incentivizedTierTwoLeverageRatio;
    }

    /**
     * OPERATOR ONLY: Set slippage tolerance for when rebalance is incentivized. Rebalance must not be in progress
     *
     * @param _incentivizedSlippageTolerance           Slippage tolerance in percentage in precise units. (1% = 1e16)
     */
    function setIncentivizedSlippageTolerance(uint256 _incentivizedSlippageTolerance) external onlyOperator noRebalanceInProgress {
        incentivizedSlippageTolerance = _incentivizedSlippageTolerance;
    }

    /**
     * OPERATOR ONLY: Transfer entire balance of ETH incentives in this contract to operator
     */
    function withdrawEthIncentivesBalance() external onlyOperator noRebalanceInProgress {
        msg.sender.transfer(address(this).balance);
    }

    receive() external payable {}

    /* ============ External Getter Functions ============ */

    /**
     * Get current leverage ratio. Note: uses borrow balance and exchange rate that is stored versus current.
     */
    function getCurrentLeverageRatio() external view returns(uint256) {
        uint256 collateralPrice = priceOracle.getUnderlyingPrice(address(targetCollateralCToken));
        uint256 borrowPrice = priceOracle.getUnderlyingPrice(address(targetBorrowCToken));

        // Use stored values which conform to view function
        uint256 cTokenBalance = targetCollateralCToken.balanceOf(address(setToken));
        uint256 exchangeRateStored = targetCollateralCToken.exchangeRateStored();
        uint256 collateralBalance = cTokenBalance.preciseMul(exchangeRateStored);
        uint256 borrowBalance = targetBorrowCToken.borrowBalanceStored(address(setToken));

        uint256 collateralValue = collateralPrice.preciseMul(collateralBalance).preciseDiv(10 ** collateralAssetDecimals);
        uint256 borrowValue = borrowPrice.preciseMul(borrowBalance).preciseDiv(10 ** borrowAssetDecimals);

        return _calculateCurrentLeverageRatio(collateralValue, borrowValue);
    }

    /* ============ Internal Functions ============ */

    /**
     * Calculate notional rebalance quantity, whether to use TWAP and max borrow. Invoke lever on CompoundLeverageModule.
     */
    function _lever(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        ActionInfo memory _actionInfo
    )
        internal
    {
        uint256 totalRebalanceNotional = _newLeverageRatio
            .sub(_currentLeverageRatio)
            .preciseDiv(_currentLeverageRatio)
            .preciseMul(_actionInfo.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowInCollateral(_actionInfo, true);

        uint256 collateralRebalanceUnits = _calculateCollateralUnitsAndUpdateTWAP(
            maxBorrow,
            totalRebalanceNotional,
            _newLeverageRatio,
            maxTradeSize,
            _actionInfo
        );

        uint256 borrowUnits = _calculateBorrowUnits(collateralRebalanceUnits, _actionInfo);

        uint256 minReceiveUnits = _calculateMinReceiveUnits(collateralRebalanceUnits);

        bytes memory leverCallData = abi.encodeWithSignature(
            "lever(address,address,address,uint256,uint256,string,bytes)",
            address(setToken),
            borrowAsset,
            collateralAsset,
            borrowUnits,
            minReceiveUnits,
            exchangeName,
            exchangeData
        );

        invokeManager(address(leverageModule), leverCallData);
    }

    /**
     * Calculate notional rebalance quantity, whether to use TWAP and max borrow. Invoke delever on CompoundLeverageModule.
     * 
     * Note: if the current leverage ratio is above the highest tier of incentives, then transfer the tier two ETH reward to caller. If 
     * the current leverage ratio is above the lower tier of incentives, then transfer the tier one ETH reward to caller.
     */
    function _delever(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        ActionInfo memory _actionInfo
    )
        internal
    {
        uint256 totalRebalanceNotional = _currentLeverageRatio
            .sub(_newLeverageRatio)
            .preciseDiv(_currentLeverageRatio)
            .preciseMul(_actionInfo.collateralBalance);

        uint256 maxBorrow = _calculateMaxBorrowInCollateral(_actionInfo, false);

        // Calculate collateral units and min repay units and whether rebalance should be incentivized
        uint256 rebalanceIncentive = 0;
        uint256 collateralRebalanceUnits;
        uint256 minRepayUnits;
        if (_currentLeverageRatio > incentivizedTierTwoLeverageRatio) {
            (collateralRebalanceUnits, minRepayUnits) = _calculateDeleverUnits(
                maxBorrow,
                totalRebalanceNotional,
                _newLeverageRatio,
                incentivizedMaxTradeSize,
                incentivizedSlippageTolerance,
                _actionInfo
            );

            rebalanceIncentive = incentivizedTierTwoEthReward;
        } else if (_currentLeverageRatio > incentivizedTierOneLeverageRatio) {
            (collateralRebalanceUnits, minRepayUnits) = _calculateDeleverUnits(
                maxBorrow,
                totalRebalanceNotional,
                _newLeverageRatio,
                incentivizedMaxTradeSize,
                incentivizedSlippageTolerance,
                _actionInfo
            );

            rebalanceIncentive = incentivizedTierOneEthReward;
        } else {
            (collateralRebalanceUnits, minRepayUnits) = _calculateDeleverUnits(
                maxBorrow,
                totalRebalanceNotional,
                _newLeverageRatio,
                maxTradeSize,
                slippageTolerance,
                _actionInfo
            );
        }

        bytes memory deleverCallData = abi.encodeWithSignature(
            "delever(address,address,address,uint256,uint256,string,bytes)",
            address(setToken),
            collateralAsset,
            borrowAsset,
            collateralRebalanceUnits,
            minRepayUnits,
            exchangeName,
            exchangeData
        );

        invokeManager(address(leverageModule), deleverCallData);

        // Transfer rebalance incentive if ETH balance exists on contract. If the ETH balance on this contract is less than required
        // incentive quantity, then transfer contract balance instead to prevent reverts.
        if (rebalanceIncentive > 0) {
            rebalanceIncentive < address(this).balance ? msg.sender.transfer(rebalanceIncentive) : msg.sender.transfer(address(this).balance);
        }
    }

    function _createActionInfo() internal returns(ActionInfo memory) {
        ActionInfo memory rebalanceInfo;

        rebalanceInfo.collateralPrice = priceOracle.getUnderlyingPrice(address(targetCollateralCToken));
        rebalanceInfo.borrowPrice = priceOracle.getUnderlyingPrice(address(targetBorrowCToken));
        rebalanceInfo.collateralBalance = targetCollateralCToken.balanceOfUnderlying(address(setToken));
        rebalanceInfo.borrowBalance = targetBorrowCToken.borrowBalanceStored(address(setToken));
        rebalanceInfo.collateralValue = rebalanceInfo.collateralPrice.preciseMul(rebalanceInfo.collateralBalance).preciseDiv(10 ** collateralAssetDecimals);
        rebalanceInfo.borrowValue = rebalanceInfo.borrowPrice.preciseMul(rebalanceInfo.borrowBalance).preciseDiv(10 ** borrowAssetDecimals);
        rebalanceInfo.setTotalSupply = setToken.totalSupply();

        return rebalanceInfo;
    }

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

    function _validateRebalanceAndSetTimestamp(uint256 _currentLeverageRatio) internal {
        if (isTWAP && _currentLeverageRatio > incentivizedTierOneLeverageRatio) {
            // If TWAP and current leverage ratio is ABOVE the threshold for incentivization, then validate that the incentivized cooldown period has elapsed
            require(
                block.timestamp.sub(twapState.lastTWAPTradeTimestamp) >= incentivizedTwapCooldown,
                "TWAP cooldown not yet elapsed for incentivized rebalance"
            );
        } else if (isTWAP && _currentLeverageRatio <= incentivizedTierOneLeverageRatio) {
            // If TWAP and current leverage ratio is BELOW the threshold for incentivization, then validate that the non incentivized cooldown period has elapsed
            require(
                block.timestamp.sub(twapState.lastTWAPTradeTimestamp) >= twapCooldown,
                "TWAP cooldown not yet elapsed"
            );
        } else {
            // If there is no TWAP then validate that the rebalance interval has elapsed OR current leverage ratio is above max OR current leverage ratio is below min
            require(
                block.timestamp.sub(lastRebalanceTimestamp) > rebalanceInterval
                || _currentLeverageRatio > maxLeverageRatio
                || _currentLeverageRatio < minLeverageRatio,
                "Rebalance interval not yet elapsed"
            );

            // Update last rebalance timestamp if a new rebalance. Note: If leverage ratio is outside max and min leverage ratio bounds,
            // the rebalance interval check is bypassed and last rebalance timestamp is updated, so it is difficult to predict the next rebalance
            lastRebalanceTimestamp = block.timestamp;
        }
    }

    function _calculateNewLeverageRatio(uint256 _currentLeverageRatio) internal view returns(uint256) {
        uint256 newLeverageRatio;
        if (isTWAP) {
            newLeverageRatio = twapState.twapNewLeverageRatio;
        } else {
            uint256 a = targetLeverageRatio.preciseMul(recenteringSpeed);
            uint256 b = PreciseUnitMath.preciseUnit().sub(recenteringSpeed).preciseMul(_currentLeverageRatio);
            uint256 c = a.add(b);
            uint256 d = Math.min(c, maxLeverageRatio);
            newLeverageRatio = Math.max(minLeverageRatio, d);
        }

        return newLeverageRatio;
    }

    function _calculateMaxBorrowInCollateral(ActionInfo memory _actionInfo, bool _isLever) internal view returns(uint256) {
        ( , uint256 accountLiquidity, ) = comptroller.getAccountLiquidity(address(setToken));

        if (_isLever) {
            return accountLiquidity
                .preciseMul(PreciseUnitMath.preciseUnit().sub(bufferPercentage))
                .preciseDiv(_actionInfo.collateralPrice)
                .preciseMul(10 ** collateralAssetDecimals); // Normalize decimals
        } else {
            uint256 limitAdjust = accountLiquidity.add(_actionInfo.borrowValue).preciseMul(bufferPercentage);
            return _actionInfo.collateralBalance
                .mul(accountLiquidity.sub(limitAdjust))
                .preciseMul(PreciseUnitMath.preciseUnit().sub(bufferPercentage))
                .div(accountLiquidity.add(_actionInfo.borrowValue).sub(limitAdjust));
        }
    }

    function _calculateCollateralUnitsAndUpdateTWAP(
        uint256 _maxBorrow,
        uint256 _totalRebalanceNotional,
        uint256 _newLeverageRatio,
        uint256 _maxTradeSize,
        ActionInfo memory _actionInfo
    )
        internal
        returns(uint256)
    {
        uint256 chunkRebalanceNotional = Math.min(_maxBorrow, _totalRebalanceNotional);
        
        if (chunkRebalanceNotional > _maxTradeSize) {
            // If greater than max trade size, set the chunk rebalance notional
            chunkRebalanceNotional = _maxTradeSize;

            _updateTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= _maxTradeSize && _maxBorrow < _totalRebalanceNotional) {
            // Check if below TWAP threshold and max borrow amount is less than total rebalance notional
            _updateTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= _maxTradeSize && _maxBorrow >= _totalRebalanceNotional) {
            _removeTWAPState();
        }

        return chunkRebalanceNotional.preciseDiv(_actionInfo.setTotalSupply);
    }

    function _calculateDeleverUnits(
        uint256 _maxBorrow,
        uint256 _totalRebalanceNotional,
        uint256 _newLeverageRatio,
        uint256 _maxTradeSize,
        uint256 _slippageTolerance,
        ActionInfo memory _actionInfo
    )
        internal
        returns(uint256, uint256)
    {
        uint256 collateralRebalanceUnits = _calculateCollateralUnitsAndUpdateTWAP(
            _maxBorrow,
            _totalRebalanceNotional,
            _newLeverageRatio,
            _maxTradeSize,
            _actionInfo
        );

        uint256 minRepayUnits = _calculateMinRepayUnits(collateralRebalanceUnits, _slippageTolerance, _actionInfo);

        return (collateralRebalanceUnits, minRepayUnits);
    }


    function _updateTWAPState(uint256 _newLeverageRatio) internal {
        if (isTWAP) {
            twapState.lastTWAPTradeTimestamp = block.timestamp;
        } else {
            isTWAP = true;
            twapState.twapNewLeverageRatio = _newLeverageRatio;
            twapState.lastTWAPTradeTimestamp = block.timestamp;
        }
    }

    function _removeTWAPState() internal {
        if (isTWAP) {
            isTWAP = false;
            delete twapState;
        }
    }

    function _calculateBorrowUnits(uint256 _collateralRebalanceUnits, ActionInfo memory _actionInfo) internal view returns (uint256) {
        uint256 pairPrice = _actionInfo.collateralPrice.preciseDiv(_actionInfo.borrowPrice);
        return _collateralRebalanceUnits
            .preciseDiv(10 ** collateralAssetDecimals)
            .preciseMul(pairPrice)
            .preciseMul(10 ** borrowAssetDecimals);
    }

    function _calculateMinReceiveUnits(uint256 _collateralRebalanceUnits) internal view returns (uint256) {
        return _collateralRebalanceUnits.preciseMul(PreciseUnitMath.preciseUnit().sub(slippageTolerance));
    }

    function _calculateMinRepayUnits(uint256 _collateralRebalanceUnits, uint256 _slippageTolerance, ActionInfo memory _actionInfo) internal view returns (uint256) {
        uint256 pairPrice = _actionInfo.collateralPrice.preciseDiv(_actionInfo.borrowPrice);

        return _collateralRebalanceUnits
            .preciseDiv(10 ** collateralAssetDecimals)
            .preciseMul(pairPrice)
            .preciseMul(10 ** borrowAssetDecimals)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(_slippageTolerance));
    }
}