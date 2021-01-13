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
    using AddressArrayUtils for address[];

    /* ============ Structs ============ */

    struct ActionInfo {
        uint256 collateralPrice;
        uint256 borrowPrice;
        uint256 collateralBalance;
        uint256 borrowBalance;
        uint256 collateralValue;
        uint256 borrowValue;
        uint256 setTotalSupply;
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

    modifier onlyEOA() {
        require(msg.sender == tx.origin, "Caller must be EOA Address");
        _;
    }

    /* ============ State Variables ============ */

    ISetToken public setToken; // Instance of levered SetToken
    ICompoundLeverageModule public compoundLeverageModule; // Instance of Compound leverage module

    IComptroller public comptroller; // Instance of Comptroller
    ICompoundPriceOracle public compoundPriceOracle; // Compound oracle feed

    ICErc20 public targetCollateralCToken; // Instance of target collateral cToken asset
    ICErc20 public targetBorrowCToken; // Instance of target borrow cToken asset
    address public collateralAsset; // Address of underlying collateral
    address public borrowAsset; // Address of underlying borrow asset
    uint256 public collateralAssetDecimals; // Decimals of collateral asset
    uint256 public borrowAssetDecimals; // Decimals of borrow asset
    
    uint256 public targetLeverageRatio; // Target leverage ratio
    uint256 public minLeverageRatio; // Min leverage ratio
    uint256 public maxLeverageRatio; // Max leverage ratio
    uint256 public recenteringSpeed; // Speed at which to rebalance back to target leverage
    uint256 public rebalanceInterval; // Rebalance interval in seconds

    uint256 public bufferPercentage; // Percent of max borrow left unutilized leverage
    uint256 public maxTradeSize; // Max trade size for TWAP in base units
    uint256 public twapCooldown; // Cooldown period for TWAP
    uint256 public slippageTolerance; // Slippage tolerance % in precise units to price min receive quantities

    string public exchangeName; // Name of exchange that is being used for leverage
    bytes public exchangeData; // Arbitrary exchange data passed into rebalance function

    bool public isTWAP; // Check if it currently is rebalancing
    TwapState public twapState; // TWAP state struct
    uint256 public lastRebalanceTimestamp; // Last rebalance timestamp. Must be past rebalance interval to rebalance

    bool public isEngaged;

    /* ============ Constructor ============ */

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
     * OPERATOR ONLY: Engage to target leverage
     *
     */
    function engage() external onlyOperator {
        require(!isEngaged, "Must not be engaged");

        ActionInfo memory engageInfo = _createActionInfo();

        require(engageInfo.setTotalSupply > 0, "SetToken must have > 0 supply");
        require(engageInfo.borrowBalance == 0, "Debt must be 0");
        require(engageInfo.collateralBalance > 0, "Collateral balance must be > 0");

        ( , uint256 accountLiquidity, ) = comptroller.getAccountLiquidity(address(setToken));

        uint256 maxBorrowInCollateral = accountLiquidity
            .preciseMul(PreciseUnitMath.preciseUnit().sub(bufferPercentage))
            .preciseDiv(engageInfo.collateralPrice)
            .preciseMul(10 ** collateralAssetDecimals); // Normalize decimals

        _lever(
            PreciseUnitMath.preciseUnit(), // 1x leverage in precise units
            targetLeverageRatio,
            engageInfo.collateralBalance,
            maxBorrowInCollateral,
            engageInfo.collateralPrice.preciseDiv(engageInfo.borrowPrice),
            engageInfo.setTotalSupply
        );

        isEngaged = true;
        lastRebalanceTimestamp = block.timestamp;
    }

    /**
     * ONLY EOA: Rebalance according to flexible leverage methodology. Anyone callable.
     *
     */
    function rebalance() external onlyEOA {
        require(isEngaged, "Must be engaged");

        ActionInfo memory rebalanceInfo = _createActionInfo();

        // Get current leverage ratio
        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            rebalanceInfo.collateralValue,
            rebalanceInfo.borrowValue
        );

        uint256 newLeverageRatio = _validateAndCalculateNewLeverageRatio(currentLeverageRatio);


        ( , uint256 accountLiquidity, ) = comptroller.getAccountLiquidity(address(setToken));
        if (newLeverageRatio < currentLeverageRatio) {
            uint256 maxBorrowInCollateral = rebalanceInfo.collateralBalance
                .mul(rebalanceInfo.borrowValue)
                .preciseMul(PreciseUnitMath.preciseUnit().sub(bufferPercentage))
                .div(accountLiquidity.add(rebalanceInfo.borrowValue))
                .preciseMul(10 ** collateralAssetDecimals); // Normalize decimals

            _delever(
                currentLeverageRatio,
                newLeverageRatio,
                rebalanceInfo.collateralBalance,
                maxBorrowInCollateral,
                rebalanceInfo.collateralPrice.preciseDiv(rebalanceInfo.borrowPrice),
                rebalanceInfo.setTotalSupply
            );
        } else {
            uint256 maxBorrowInCollateral = accountLiquidity
                .preciseMul(PreciseUnitMath.preciseUnit().sub(bufferPercentage))
                .preciseDiv(rebalanceInfo.collateralPrice)
                .preciseMul(10 ** collateralAssetDecimals); // Normalize decimals

            _lever(
                currentLeverageRatio,
                newLeverageRatio,
                rebalanceInfo.collateralBalance,
                maxBorrowInCollateral,
                rebalanceInfo.collateralPrice.preciseDiv(rebalanceInfo.borrowPrice),
                rebalanceInfo.setTotalSupply
            );
        }
    }

    /**
     * OPERATOR ONLY: Disengage and repay loan
     *
     */
    function disengage() external onlyOperator {
        require(isEngaged, "Must be engaged");

        ActionInfo memory disengageInfo = _createActionInfo();

        // Get current leverage ratio
        uint256 currentLeverageRatio = _calculateCurrentLeverageRatio(
            disengageInfo.collateralValue,
            disengageInfo.borrowValue
        );

        ( , uint256 accountLiquidity, ) = comptroller.getAccountLiquidity(address(setToken));
        uint256 maxBorrowInCollateral = disengageInfo.collateralBalance
            .mul(disengageInfo.borrowValue)
            .preciseMul(PreciseUnitMath.preciseUnit().sub(bufferPercentage))
            .div(accountLiquidity.add(disengageInfo.borrowValue))
            .preciseMul(10 ** collateralAssetDecimals); // Normalize decimals
        _delever(
            currentLeverageRatio,
            PreciseUnitMath.preciseUnit(),
            disengageInfo.collateralBalance,
            maxBorrowInCollateral,
            disengageInfo.collateralPrice.preciseDiv(disengageInfo.borrowPrice),
            disengageInfo.setTotalSupply
        );

        isEngaged = false;
        lastRebalanceTimestamp = block.timestamp;
    }

    /**
     * ONLY EOA: Gulp COMP. Rebalance must not be in progress
     *
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
     * OPERATOR ONLY: Set max trade size
     *
     */
    function setMaxTradeSize(uint256 _maxTradeSize) external onlyOperator noRebalanceInProgress {
        maxTradeSize = _maxTradeSize;
    }

    /**
     * OPERATOR ONLY: Set exchange name
     *
     */
    function setExchange(string memory _exchangeName) external onlyOperator noRebalanceInProgress {
        exchangeName = _exchangeName;
    }

    /**
     * OPERATOR ONLY: Set exchange data
     *
     */
    function setExchangeData(bytes memory _exchangeData) external onlyOperator noRebalanceInProgress {
        exchangeData = _exchangeData;
    }

    /**
     * OPERATOR ONLY: Set TWAP cooldown period
     *
     */
    function setCooldownPeriod(uint256 _twapCooldown) external onlyOperator noRebalanceInProgress {
        twapCooldown = _twapCooldown;
    }

    /**
     * OPERATOR ONLY: Set rebalance interval
     *
     */
    function setRebalanceInterval(uint256 _rebalanceInterval) external onlyOperator noRebalanceInProgress {
        rebalanceInterval = _rebalanceInterval;
    }

    /**
     * OPERATOR ONLY: Set buffer percentage
     *
     */
    function setBufferPercentage(uint256 _bufferPercentage) external onlyOperator noRebalanceInProgress {
        bufferPercentage = _bufferPercentage;
    }

    /**
     * OPERATOR ONLY: Set recentering speed
     *
     */
    function setRecenteringSpeed(uint256 _recenteringSpeed) external onlyOperator noRebalanceInProgress {
        recenteringSpeed = _recenteringSpeed;
    }

    /**
     * OPERATOR ONLY: Set min leverage ratio
     *
     */
    function setMinLeverageRatio(uint256 _minLeverageRatio) external onlyOperator noRebalanceInProgress {
        minLeverageRatio = _minLeverageRatio;
    }

    /**
     * OPERATOR ONLY: Set max leverage ratio
     *
     */
    function setMaxLeverageRatio(uint256 _maxLeverageRatio) external onlyOperator noRebalanceInProgress {
        maxLeverageRatio = _maxLeverageRatio;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Get current leverage ratio
     *
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

    function _lever(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        uint256 _collateralBalance,
        uint256 _maxBorrow,
        uint256 _pairPrice,
        uint256 _setTotalSupply
    )
        internal
    {
        uint256 totalRebalanceNotional = _newLeverageRatio
            .sub(_currentLeverageRatio)
            .preciseDiv(_currentLeverageRatio)
            .preciseMul(_collateralBalance);

        uint256 chunkRebalanceNotional = Math.min(_maxBorrow, totalRebalanceNotional);
        // If the chunk notional rebalance size is greater than max trade size
        if (chunkRebalanceNotional > maxTradeSize) {
            chunkRebalanceNotional = maxTradeSize;

            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && _maxBorrow < totalRebalanceNotional) {
            // Check if below TWAP threshold and max borrow amount is less than total rebalance notional
            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && _maxBorrow >= totalRebalanceNotional) {
            _removeTWAPState();
        }

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_setTotalSupply);

        uint256 borrowUnits = collateralRebalanceUnits
            .preciseDiv(10 ** collateralAssetDecimals)
            .preciseMul(_pairPrice)
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

    function _delever(
        uint256 _currentLeverageRatio,
        uint256 _newLeverageRatio,
        uint256 _collateralBalance,
        uint256 _maxBorrow,
        uint256 _pairPrice,
        uint256 _setTotalSupply
    )
        internal
    {
        uint256 totalRebalanceNotional = _currentLeverageRatio
            .sub(_newLeverageRatio)
            .preciseDiv(_currentLeverageRatio)
            .preciseMul(_collateralBalance);

        uint256 chunkRebalanceNotional = Math.min(_maxBorrow, totalRebalanceNotional);
        // If the chunk notional rebalance size is greater than max trade size
        if (chunkRebalanceNotional > maxTradeSize) {
            chunkRebalanceNotional = maxTradeSize;

            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && _maxBorrow < totalRebalanceNotional) {
            // Check if below TWAP threshold and max borrow amount is less than total rebalance notional
            _setTWAPState(_newLeverageRatio);
        } else if (chunkRebalanceNotional <= maxTradeSize && _maxBorrow >= totalRebalanceNotional) {
            _removeTWAPState();
        }

        uint256 collateralRebalanceUnits = chunkRebalanceNotional.preciseDiv(_setTotalSupply);

        uint256 minRepayUnits = collateralRebalanceUnits
            .preciseDiv(10 ** collateralAssetDecimals)
            .preciseMul(_pairPrice)
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