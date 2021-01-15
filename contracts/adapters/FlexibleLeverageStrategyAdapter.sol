pragma solidity ^0.6.10;

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

    /**
     * Throws if caller is a contract
     */
    modifier onlyEOA() {
        require(msg.sender == tx.origin, "Caller must be EOA Address");
        _;
    }

    /* ============ State Variables ============ */

    ISetToken public setToken;                              // Instance of levered SetToken
    ICompoundLeverageModule public compoundLeverageModule;  // Instance of Compound leverage module

    IComptroller public comptroller;                        // Instance of Comptroller
    ICompoundPriceOracle public compoundPriceOracle;        // Compound oracle feed

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
     * @param _initialExchangeName     Initial exchange name for execution
     * @param _initialExchangeData     Arbitrary bytes used by exchange
     */
    constructor(
        address[9] memory _instances,
        uint256[2] memory _assetDecimals,
        uint256[5] memory _methodologyParams,
        uint256[4] memory _executionParams,
        string memory _initialExchangeName,
        bytes memory _initialExchangeData
    )
        public
    {
        setToken = ISetToken(_instances[0]);
        compoundLeverageModule = ICompoundLeverageModule(_instances[1]);
        manager = IICManagerV2(_instances[2]);
        comptroller = IComptroller(_instances[3]);
        compoundPriceOracle = ICompoundPriceOracle(_instances[4]);
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
     * ONLY EOA: Rebalance according to flexible leverage methodology. Anyone callable.
     */
    function rebalance() external onlyEOA {
        require(isEngaged, "Must be engaged");

        ActionInfo memory rebalanceInfo = _createActionInfo();

        // Get current leverage ratio
        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            rebalanceInfo.collateralValue,
            rebalanceInfo.borrowValue
        );

        // Validate rebalance and calculate new leverage ratio
        uint256 newLeverageRatio = _validateAndCalculateNewLeverageRatio(currentLeverageRatio);
        
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
     * ONLY EOA: Gulp COMP and sell for more collateral. Rebalance must not be in progress. Anyone callable
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

        invokeManager(address(compoundLeverageModule), gulpCallData);
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

    /* ============ External Getter Functions ============ */

    /**
     * Get current leverage ratio. Note: uses borrow balance and exchange rate that is stored versus current.
     */
    function getCurrentLeverageRatio() external view returns(uint256) {
        uint256 collateralPrice = compoundPriceOracle.getUnderlyingPrice(address(targetCollateralCToken));
        uint256 borrowPrice = compoundPriceOracle.getUnderlyingPrice(address(targetBorrowCToken));

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

        uint256 chunkRebalanceNotional = Math.min(maxBorrow, totalRebalanceNotional);
        
        // If the chunk notional rebalance size is greater than max trade size
        if (chunkRebalanceNotional > maxTradeSize) {
            chunkRebalanceNotional = maxTradeSize;

            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && maxBorrow < totalRebalanceNotional) {
            // Check if below TWAP threshold and max borrow amount is less than total rebalance notional
            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && maxBorrow >= totalRebalanceNotional) {
            _removeTWAPState();
        }

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_actionInfo.setTotalSupply);

        uint256 pairPrice = _actionInfo.collateralPrice.preciseDiv(_actionInfo.borrowPrice);
        uint256 borrowUnits = collateralRebalanceUnits
            .preciseDiv(10 ** collateralAssetDecimals)
            .preciseMul(pairPrice)
            .preciseMul(10 ** borrowAssetDecimals);
        uint256 minReceiveUnits = collateralRebalanceUnits.preciseMul(PreciseUnitMath.preciseUnit().sub(slippageTolerance));

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

        invokeManager(address(compoundLeverageModule), leverCallData);
    }

    /**
     * Calculate notional rebalance quantity, whether to use TWAP and max borrow. Invoke delever on CompoundLeverageModule.
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
        uint256 chunkRebalanceNotional = Math.min(maxBorrow, totalRebalanceNotional);
        
        // If the chunk notional rebalance size is greater than max trade size
        if (chunkRebalanceNotional > maxTradeSize) {
            chunkRebalanceNotional = maxTradeSize;

            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && maxBorrow < totalRebalanceNotional) {
            // Check if below TWAP threshold and max borrow amount is less than total rebalance notional
            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && maxBorrow >= totalRebalanceNotional) {
            _removeTWAPState();
        }

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_actionInfo.setTotalSupply);

        uint256 pairPrice = _actionInfo.collateralPrice.preciseDiv(_actionInfo.borrowPrice);
        uint256 minRepayUnits = collateralRebalanceUnits
            .preciseDiv(10 ** collateralAssetDecimals)
            .preciseMul(pairPrice)
            .preciseMul(10 ** borrowAssetDecimals)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(slippageTolerance));

        bytes memory leverCallData = abi.encodeWithSignature(
            "delever(address,address,address,uint256,uint256,string,bytes)",
            address(setToken),
            collateralAsset,
            borrowAsset,
            collateralRebalanceUnits,
            minRepayUnits,
            exchangeName,
            exchangeData
        );

        invokeManager(address(compoundLeverageModule), leverCallData);
    }

    function _createActionInfo() internal returns(ActionInfo memory) {
        ActionInfo memory rebalanceInfo;

        rebalanceInfo.collateralPrice = compoundPriceOracle.getUnderlyingPrice(address(targetCollateralCToken));
        rebalanceInfo.borrowPrice = compoundPriceOracle.getUnderlyingPrice(address(targetBorrowCToken));
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

    function _validateAndCalculateNewLeverageRatio(uint256 _currentLeverageRatio) internal returns(uint256) {
        uint256 newLeverageRatio;
        if (isTWAP) {
            require(
                block.timestamp.sub(twapState.lastTWAPTradeTimestamp) >= twapCooldown,
                "TWAP cooldown not yet elapsed"
            );
            newLeverageRatio = twapState.twapNewLeverageRatio;
        } else {
            require(
                block.timestamp.sub(lastRebalanceTimestamp) > rebalanceInterval
                || _currentLeverageRatio > maxLeverageRatio
                || _currentLeverageRatio < minLeverageRatio,
                "Rebalance interval not yet elapsed"
            );

            uint256 a = _currentLeverageRatio.preciseMul(recenteringSpeed);
            uint256 b = PreciseUnitMath.preciseUnit().sub(recenteringSpeed).preciseMul(targetLeverageRatio);
            uint256 c = a.add(b);
            uint256 d = Math.min(c, maxLeverageRatio);
            newLeverageRatio = Math.max(minLeverageRatio, d);
            lastRebalanceTimestamp = block.timestamp;
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

    function _setTWAPState(uint256 _newLeverageRatio) internal {
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
}