pragma solidity ^0.6.10;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IIndexModule } from "../interfaces/IIndexModule.sol";
import { IStreamingFeeModule } from "../interfaces/IStreamingFeeModule.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { TimeLockUpgrade } from "../lib/TimeLockUpgrade.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

contract ICManager is TimeLockUpgrade, MutualUpgrade {
    using Address for address;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    /* ============ Events ============ */

    event FeesAccrued(
        uint256 _totalFees,
        uint256 _operatorTake,
        uint256 _methodologistTake
    );

    /* ============ Modifiers ============ */

    /**
     * Throws if the sender is not the SetToken operator
     */
    modifier onlyOperator() {
        require(msg.sender == operator, "Must be operator");
        _;
    }

    /**
     * Throws if the sender is not the SetToken methodologist
     */
    modifier onlyMethodologist() {
        require(msg.sender == methodologist, "Must be methodologist");
        _;
    }

    /* ============ State Variables ============ */

    // Instance of SetToken
    ISetToken public setToken;

    // Address of IndexModule for managing rebalances
    IIndexModule public indexModule;

    // Address of StreamingFeeModule
    IStreamingFeeModule public feeModule;

    // Address of operator
    address public operator;

    // Address of methodologist
    address public methodologist;

    // Percent in 1e18 of streamingFees sent to operator
    uint256 public operatorFeeSplit;

    /* ============ Constructor ============ */

    constructor(
        ISetToken _setToken,
        IIndexModule _indexModule,
        IStreamingFeeModule _feeModule,
        address _operator,
        address _methodologist,
        uint256 _operatorFeeSplit
    )
        public
    {
        require(
            _operatorFeeSplit <= PreciseUnitMath.preciseUnit(),
            "Operator Fee Split must be less than 1e18"
        );
        
        setToken = _setToken;
        indexModule = _indexModule;
        feeModule = _feeModule;
        operator = _operator;
        methodologist = _methodologist;
        operatorFeeSplit = _operatorFeeSplit;
    }

    /* ============ External Functions ============ */

    /**
     * OPERATOR ONLY: Start rebalance in IndexModule. Set new target units, zeroing out any units for components being removed from index.
     * Log position multiplier to adjust target units in case fees are accrued.
     *
     * @param _newComponents                    Array of new components to add to allocation
     * @param _newComponentsTargetUnits         Array of target units at end of rebalance for new components, maps to same index of component
     * @param _oldComponentsTargetUnits         Array of target units at end of rebalance for old component, maps to same index of component,
     *                                              if component being removed set to 0.
     * @param _positionMultiplier               Position multiplier when target units were calculated, needed in order to adjust target units
     *                                              if fees accrued
     */
    function startRebalance(
        address[] calldata _newComponents,
        uint256[] calldata _newComponentsTargetUnits,
        uint256[] calldata _oldComponentsTargetUnits,
        uint256 _positionMultiplier
    )
        external
        onlyOperator
    {
        indexModule.startRebalance(_newComponents, _newComponentsTargetUnits, _oldComponentsTargetUnits, _positionMultiplier);
    }

    /**
     * OPERATOR ONLY: Set trade maximums for passed components
     *
     * @param _components            Array of components
     * @param _tradeMaximums         Array of trade maximums mapping to correct component
     */
    function setTradeMaximums(
        address[] calldata _components,
        uint256[] calldata _tradeMaximums
    )
        external
        onlyOperator
    {
        indexModule.setTradeMaximums(_components, _tradeMaximums);
    }

    /**
     * OPERATOR ONLY: Set exchange for passed components
     *
     * @param _components        Array of components
     * @param _exchanges         Array of exchanges mapping to correct component, uint256 used to signify exchange
     */
    function setAssetExchanges(
        address[] calldata _components,
        uint256[] calldata _exchanges
    )
        external
        onlyOperator
    {
        indexModule.setExchanges(_components, _exchanges);
    }

    /**
     * OPERATOR ONLY: Set exchange for passed components
     *
     * @param _components           Array of components
     * @param _coolOffPeriods       Array of cool off periods to correct component
     */
    function setCoolOffPeriods(
        address[] calldata _components,
        uint256[] calldata _coolOffPeriods
    )
        external
        onlyOperator
    {
        indexModule.setCoolOffPeriods(_components, _coolOffPeriods);
    }

    /**
     * OPERATOR ONLY: Toggle ability for passed addresses to trade from current state 
     *
     * @param _traders           Array trader addresses to toggle status
     * @param _statuses          Booleans indicating if matching trader can trade
     */
    function updateTraderStatus(
        address[] calldata _traders,
        bool[] calldata _statuses
    )
        external
        onlyOperator
    {
        indexModule.updateTraderStatus(_traders, _statuses);
    }

    /**
     * OPERATOR ONLY: Toggle whether anyone can trade, bypassing the traderAllowList
     *
     * @param _status           Boolean indicating if anyone can trade
     */
    function updateAnyoneTrade(bool _status) external onlyOperator {
        indexModule.updateAnyoneTrade(_status);
    }

    /**
     * Accrue fees from streaming fee module and transfer tokens to operator / methodologist addresses based on fee split
     */
    function accrueFeeAndDistribute() public {
        feeModule.accrueFee(setToken);

        uint256 setTokenBalance = setToken.balanceOf(address(this));

        uint256 operatorTake = setTokenBalance.preciseMul(operatorFeeSplit);
        uint256 methodologistTake = setTokenBalance.sub(operatorTake);

        setToken.transfer(operator, operatorTake);

        setToken.transfer(methodologist, methodologistTake);

        emit FeesAccrued(setTokenBalance, operatorTake, methodologistTake);
    }

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Update the SetToken manager address. Operator and Methodologist must each call
     * this function to execute the update.
     *
     * @param _newManager           New manager address
     */
    function updateManager(address _newManager) external mutualUpgrade(operator, methodologist) {
        setToken.setManager(_newManager);
    }

    /**
     * OPERATOR ONLY: Add a new module to the SetToken.
     *
     * @param _module           New module to add
     */
    function addModule(address _module) external onlyOperator {
        setToken.addModule(_module);
    }

    /**
     * OPERATOR ONLY: Interact with a module registered on the SetToken. Cannot be used to call functions in the
     * fee module, due to ability to bypass methodologist permissions to update streaming fee.
     *
     * @param _module           Module to interact with
     * @param _data             Byte data of function to call in module
     */
    function interactModule(address _module, bytes calldata _data) external onlyOperator {
        require(_module != address(feeModule), "Must not be fee module");

        // Invoke call to module, assume value will always be 0
        _module.functionCallWithValue(_data, 0);
    }

    /**
     * OPERATOR ONLY: Remove a new module from the SetToken.
     *
     * @param _module           Module to remove
     */
    function removeModule(address _module) external onlyOperator {
        setToken.removeModule(_module);
    }

    /**
     * METHODOLOGIST ONLY: Update the streaming fee for the SetToken. Subject to timelock period agreed upon by the
     * operator and methodologist
     *
     * @param _newFee           New streaming fee percentage
     */
    function updateStreamingFee(uint256 _newFee) external timeLockUpgrade onlyMethodologist {
        feeModule.updateStreamingFee(setToken, _newFee);
    }

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Update the fee recipient address. Operator and Methodologist must each call
     * this function to execute the update.
     *
     * @param _newFeeRecipient           New fee recipient address
     */
    function updateFeeRecipient(address _newFeeRecipient) external mutualUpgrade(operator, methodologist) {
        feeModule.updateFeeRecipient(setToken, _newFeeRecipient);
    }

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Update the fee split percentage. Operator and Methodologist must each call
     * this function to execute the update.
     *
     * @param _newFeeSplit           New fee split percentage
     */
    function updateFeeSplit(uint256 _newFeeSplit) external mutualUpgrade(operator, methodologist) {    
        require(
            _newFeeSplit <= PreciseUnitMath.preciseUnit(),
            "Operator Fee Split must be less than 1e18"
        );

        // Accrue fee to operator and methodologist prior to new fee split
        accrueFeeAndDistribute();
        operatorFeeSplit = _newFeeSplit;
    }

    /**
     * OPERATOR ONLY: Update the index module
     *
     * @param _newIndexModule           New index module
     */
    function updateIndexModule(IIndexModule _newIndexModule) external onlyOperator {
        indexModule = _newIndexModule;
    }

    /**
     * METHODOLOGIST ONLY: Update the methodologist address
     *
     * @param _newMethodologist           New methodologist address
     */
    function updateMethodologist(address _newMethodologist) external onlyMethodologist {
        methodologist = _newMethodologist;
    }

    /**
     * OPERATOR ONLY: Update the operator address
     *
     * @param _newOperator           New operator address
     */
    function updateOperator(address _newOperator) external onlyOperator {
        operator = _newOperator;
    }

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Update the timelock period for updating the streaming fee percentage.
     * Operator and Methodologist must each call this function to execute the update.
     *
     * @param _newTimeLockPeriod           New timelock period in seconds
     */
    function setTimeLockPeriod(uint256 _newTimeLockPeriod) external override mutualUpgrade(operator, methodologist) {
        timeLockPeriod = _newTimeLockPeriod;
    }
}