/*
    Copyright 2020 Set Labs Inc.

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
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";
import { IController } from "../../interfaces/IController.sol";
import { IExchangeAdapter } from "../../interfaces/IExchangeAdapter.sol";
import { Invoke } from "../lib/Invoke.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IComptroller } from "../../interfaces/external/IComptroller.sol";
import { ICErc20 } from "../../interfaces/external/ICErc20.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";

/**
 * @title CompoundLeverageModule
 * @author Set Protocol
 *
 * Smart contract that enables leverage trading using Compound as the lending protocol. This module allows for multiple Compound leverage positions
 * in a SetToken. This does not allow borrowing of assets from Compound alone. Each asset is leveraged when using this module.
 * 
 *
 */
contract CompoundLeverageModule is ModuleBase, ReentrancyGuard {
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using SignedSafeMath for int256;
    using Position for uint256;
    using PreciseUnitMath for uint256;
    using PreciseUnitMath for int256;
    using Position for ISetToken;
    using Invoke for ISetToken;
    using AddressArrayUtils for address[];

    /* ============ Structs ============ */

    struct CompoundSettings {
        address[] collateralCTokens;             // Array of cToken collateral assets
        address[] borrowCTokens;                 // Array of cToken borrow assets
        address[] borrowAssets;                  // Array of underlying borrow assets
    }

    struct ActionInfo {
        ISetToken setToken;
        IExchangeAdapter exchangeAdapter;
        uint256 setTotalSupply;
        uint256 notionalSendQuantity;
        uint256 minNotionalReceiveQuantity;
        address collateralCTokenAsset;
        address borrowCTokenAsset;
        uint256 preTradeReceiveTokenBalance;
    }

    /* ============ Events ============ */

    event LeverageIncreased(
        ISetToken indexed _setToken,
        address indexed _borrowAsset,
        address indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalBorrowAmount,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    event LeverageDecreased(
        ISetToken indexed _setToken,
        address indexed _collateralAsset,
        address indexed _repayAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalRedeemAmount,
        uint256 _totalRepayAmount,
        uint256 _protocolFee
    );

    event CompGulped(
        ISetToken indexed _setToken,
        address indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalCompClaimed,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    event PositionsSynced(
        ISetToken indexed _setToken,
        address _caller
    );

    /* ============ Constants ============ */

    // 0 index stores protocol fee % on the controller, charged in the trade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    /* ============ State Variables ============ */

    // Mapping of underlying to CToken. If ETH, then map WETH to cETH
    mapping(address => address) public underlyingToCToken;
    // Weth contract
    address public weth;
    // cETH address
    address public cEther;
    // Compound Comptroller contract
    IComptroller public comptroller;
    // COMP token address
    address public compToken;

    // Mapping to efficiently check if cToken market for collateral asset is valid in SetToken
    mapping(ISetToken => mapping(address => bool)) public isCollateralCTokenEnabled;
    // Mapping to efficiently check if cToken market for borrow asset is valid in SetToken
    mapping(ISetToken => mapping(address => bool)) public isBorrowCTokenEnabled;
    // Mapping of enabled collateral and borrow cTokens for syncing positions
    mapping(ISetToken => CompoundSettings) internal compoundSettings;


    /* ============ Constructor ============ */

    /**
     * Instantiate addresses. Underlying to cToken mapping is created.
     * 
     * @param _controller               Address of controller contract
     * @param _compToken                Address of COMP token
     * @param _comptroller              Address of Compound Comptroller
     * @param _cEther                   Address of cEther contract
     * @param _weth                     Address of WETH contract
     */
    constructor(
        IController _controller,
        address _compToken,
        IComptroller _comptroller,
        address _cEther,
        address _weth
    )
        public
        ModuleBase(_controller)
    {
        compToken = _compToken;
        comptroller = _comptroller;
        cEther = _cEther;
        weth = _weth;

        ICErc20[] memory cTokens = comptroller.getAllMarkets();

        // Loop through cTokens
        for(uint256 i = 0; i < cTokens.length; i++) {
            if (address(cTokens[i]) == _cEther) {
                underlyingToCToken[_weth] = address(cTokens[i]);
            } else {
                address underlying = cTokens[i].underlying();
                underlyingToCToken[underlying] = address(cTokens[i]);
            }
        }
    }

    /* ============ External Functions ============ */

    /**
     * Increases leverage for a given collateral position using a specified borrow asset that is enabled
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAsset          Address of asset being borrowed for leverage
     * @param _collateralAsset      Address of collateral asset
     * @param _borrowQuantity       Quantity of asset to borrow
     * @param _minReceiveQuantity   Minimum amount of collateral asset to receive post trade
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     */
    function lever(
        ISetToken _setToken,
        address _borrowAsset,
        address _collateralAsset,
        uint256 _borrowQuantity,
        uint256 _minReceiveQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // Note: for levering up, send quantity is derived from borrow asset and receive quantity is derived from 
        // collateral asset
        ActionInfo memory leverInfo = _createActionInfo(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantity,
            _minReceiveQuantity,
            _tradeAdapterName,
            true
        );

        _validateCommon(leverInfo);

        _borrow(leverInfo.setToken, leverInfo.borrowCTokenAsset, leverInfo.notionalSendQuantity);

        (uint256 protocolFee, uint256 postTradeCollateralQuantity) = _trade(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            leverInfo.notionalSendQuantity,
            leverInfo.minNotionalReceiveQuantity,
            leverInfo.preTradeReceiveTokenBalance,
            leverInfo.exchangeAdapter,
            _tradeData
        );

        _mint(leverInfo.setToken, leverInfo.collateralCTokenAsset, _collateralAsset, postTradeCollateralQuantity);

        // Update SetToken positions
        _updateCollateralPosition(
            leverInfo.setToken,
            leverInfo.collateralCTokenAsset,
            _getCollateralPosition(
                leverInfo.setToken,
                leverInfo.collateralCTokenAsset,
                leverInfo.setTotalSupply
            )
        );

        _updateBorrowPosition(
            leverInfo.setToken,
            _borrowAsset,
            _getBorrowPosition(
                leverInfo.setToken,
                leverInfo.borrowCTokenAsset,
                _borrowAsset,
                leverInfo.setTotalSupply
            )
        );

        emit LeverageIncreased(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            leverInfo.exchangeAdapter,
            leverInfo.notionalSendQuantity,
            postTradeCollateralQuantity,
            protocolFee
        );
    }

    /**
     * Increases leverage for a given collateral position using a specified borrow asset that is enabled
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAsset      Address of collateral asset
     * @param _repayAsset           Address of asset being repaid
     * @param _redeemQuantity       Quantity of collateral asset to delever
     * @param _minRepayQuantity     Minimum amount of repay asset to receive post trade
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     */
    function delever(
        ISetToken _setToken,
        address _collateralAsset,
        address _repayAsset,
        uint256 _redeemQuantity,
        uint256 _minRepayQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // Note: for levering up, send quantity is derived from collateral asset and receive quantity is derived from 
        // repay asset
        ActionInfo memory deleverInfo = _createActionInfo(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantity,
            _minRepayQuantity,
            _tradeAdapterName,
            false
        );

        _validateCommon(deleverInfo);

        _redeem(deleverInfo.setToken, deleverInfo.collateralCTokenAsset, deleverInfo.notionalSendQuantity);

        (uint256 protocolFee, uint256 postTradeRepayQuantity) = _trade(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.notionalSendQuantity,
            deleverInfo.minNotionalReceiveQuantity,
            deleverInfo.preTradeReceiveTokenBalance,
            deleverInfo.exchangeAdapter,
            _tradeData
        );

        _repay(deleverInfo.setToken, deleverInfo.borrowCTokenAsset, _repayAsset, postTradeRepayQuantity);

        // Update SetToken positions
        _updateCollateralPosition(
            deleverInfo.setToken,
            deleverInfo.collateralCTokenAsset,
            _getCollateralPosition(deleverInfo.setToken, deleverInfo.collateralCTokenAsset, deleverInfo.setTotalSupply)
        );

        _updateBorrowPosition(
            deleverInfo.setToken,
            _repayAsset,
            _getBorrowPosition(deleverInfo.setToken, deleverInfo.borrowCTokenAsset, _repayAsset, deleverInfo.setTotalSupply)
        );

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            postTradeRepayQuantity,
            protocolFee
        );
    }

    /**
     * Claims COMP and trades for specified collateral asset
     *
     * @param _setToken                      Instance of the SetToken
     * @param _collateralAsset               Address of collateral asset
     * @param _minNotionalReceiveQuantity    Minimum total amount of collateral asset to receive post trade
     * @param _tradeAdapterName              Name of trade adapter
     * @param _tradeData                     Arbitrary data for trade
     */
    function gulp(
        ISetToken _setToken,
        address _collateralAsset,
        uint256 _minNotionalReceiveQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        ActionInfo memory gulpInfo = _createGulpInfoAndClaim(
            _setToken,
            _collateralAsset,
            _tradeAdapterName
        );

        uint256 protocolFee = 0;
        uint256 postTradeCollateralQuantity;
        // Skip trade if collateral asset is COMP
        if (_collateralAsset != compToken) {
            require(gulpInfo.notionalSendQuantity > 0, "Token to sell must be nonzero");

            (protocolFee, postTradeCollateralQuantity) = _trade(
                _setToken,
                compToken,
                _collateralAsset,
                gulpInfo.notionalSendQuantity,
                _minNotionalReceiveQuantity,
                gulpInfo.preTradeReceiveTokenBalance,
                gulpInfo.exchangeAdapter,
                _tradeData
            );
        } else {
            postTradeCollateralQuantity = gulpInfo.preTradeReceiveTokenBalance;
        }

        _mint(_setToken, gulpInfo.collateralCTokenAsset, _collateralAsset, postTradeCollateralQuantity);

        // Update SetToken positions
        _updateCollateralPosition(
            _setToken,
            gulpInfo.collateralCTokenAsset,
            _getCollateralPosition(_setToken, gulpInfo.collateralCTokenAsset, gulpInfo.setTotalSupply)
        );

        emit CompGulped(
            _setToken,
            _collateralAsset,
            gulpInfo.exchangeAdapter,
            gulpInfo.notionalSendQuantity,
            postTradeCollateralQuantity,
            protocolFee
        );
    }

    /**
     * Sync Set positions with Compound
     *
     * @param _setToken             Instance of the SetToken
     */
    function sync(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
        uint256 setTotalSupply = _setToken.totalSupply();

        // Loop through collateral assets
        for(uint i = 0; i < compoundSettings[_setToken].collateralCTokens.length; i++) {
            address collateralCToken = compoundSettings[_setToken].collateralCTokens[i];
            uint256 previousPositionUnit = _setToken.getDefaultPositionRealUnit(collateralCToken).toUint256();
            uint256 newPositionUnit = _getCollateralPosition(_setToken, collateralCToken, setTotalSupply);

            // If position units changed, then update. E.g. Position liquidated, and collateral position is in fact
            // less than what is tracked
            // Note: Accounts for if position does not exist on SetToken but is tracked in compoundSettings
            if (previousPositionUnit != newPositionUnit) {
              _updateCollateralPosition(_setToken, collateralCToken, newPositionUnit);
            }
        }

        // Loop through borrow assets
        for(uint i = 0; i < compoundSettings[_setToken].borrowCTokens.length; i++) {
            address borrowCToken = compoundSettings[_setToken].borrowCTokens[i];
            address borrowAsset = compoundSettings[_setToken].borrowAssets[i];

            int256 previousPositionUnit = _setToken.getExternalPositionRealUnit(borrowAsset, address(this));

            int256 newPositionUnit = _getBorrowPosition(
                _setToken,
                borrowCToken,
                borrowAsset,
                setTotalSupply
            );
            // If position units changed, then update. E.g. Interest is accrued or position is liquidated
            // and borrow position is repaid
            // Note: Accounts for if position does not exist on SetToken but is tracked in compoundSettings
            if (newPositionUnit != previousPositionUnit) {
                _updateBorrowPosition(_setToken, borrowAsset, newPositionUnit);
            }
        }

        emit PositionsSynced(_setToken, msg.sender);
    }


    /**
     * Initializes this module to the SetToken. Only callable by the SetToken's manager. Note: managers can enable
     * collateral and borrow assets that don't exist as positions on the SetToken
     *
     * @param _setToken             Instance of the SetToken to initialize
     * @param _collateralAssets     Underlying tokens to be enabled as collateral in the SetToken
     * @param _borrowAssets         Underlying tokens to be enabled as borrow in the SetToken
     */
    function initialize(
        ISetToken _setToken,
        address[] memory _collateralAssets,
        address[] memory _borrowAssets
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        address[] memory collateralCTokens = new address[](_collateralAssets.length);
        // Loop through collateral assets and set mapping
        for(uint256 i = 0; i < _collateralAssets.length; i++) {
            address cTokenAddress;
            if (_collateralAssets[i] == weth) {
                // Set as cETH if asset is WETH
                cTokenAddress = cEther;
            } else {
                cTokenAddress = underlyingToCToken[_collateralAssets[i]];
                require(cTokenAddress != address(0), "cToken must exist in Compound");
            }
            isCollateralCTokenEnabled[_setToken][cTokenAddress] = true;
            collateralCTokens[i] = cTokenAddress;
        }
        compoundSettings[_setToken].collateralCTokens = collateralCTokens;

        address[] memory borrowCTokens = new address[](_borrowAssets.length);
        // Loop through borrow assets 
        for(uint256 i = 0; i < _borrowAssets.length; i++) {
            address cTokenAddress;            
            if (_borrowAssets[i] == weth) {
                // Set as cETH if asset is WETH
                cTokenAddress = cEther;
            } else {
                cTokenAddress = underlyingToCToken[_borrowAssets[i]];
                require(cTokenAddress != address(0), "cToken must exist in Compound");
            }
            isBorrowCTokenEnabled[_setToken][cTokenAddress] = true;
            borrowCTokens[i] = cTokenAddress;
        }
        compoundSettings[_setToken].borrowCTokens = borrowCTokens;
        compoundSettings[_setToken].borrowAssets = _borrowAssets;

        // Initialize module before trying register
        _setToken.initializeModule();

        // Try if register exists on any of the modules
        syncRegister(_setToken);
        
        // Enable collateral and borrow assets on Compound. Note: if there is overlap between borrow cTokens and collateral cTokens, markets are entered with no issue
        _enterMarkets(_setToken, collateralCTokens);
        _enterMarkets(_setToken, borrowCTokens);
    }

    /**
     * Removes this module from the SetToken, via call by the SetToken. Compound Settings and manager enabled
     * cTokens are deleted
     */
    function removeModule() external override {
        ISetToken setToken = ISetToken(msg.sender);

        for (uint256 i = 0; i < compoundSettings[setToken].borrowCTokens.length; i++) {
            address cToken = compoundSettings[setToken].borrowCTokens[i];

            // Note: if there is an existing borrow balance, will revert and market cannot be exited on Compound
            _exitMarket(setToken, cToken);

            delete isBorrowCTokenEnabled[setToken][cToken];
        }

        for (uint256 i = 0; i < compoundSettings[setToken].collateralCTokens.length; i++) {
            address cToken = compoundSettings[setToken].collateralCTokens[i];

            _exitMarket(setToken, cToken);

            delete isCollateralCTokenEnabled[setToken][cToken];
        }
        
        delete compoundSettings[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregister(setToken) {} catch {}
        }
    }

    /**
     * Sync Compound markets with stored underlying to cToken mapping. Anyone callable
     */
    function syncCompoundMarkets() external {
        ICErc20[] memory cTokens = comptroller.getAllMarkets();

        // Loop through cTokens
        for(uint256 i = 0; i < cTokens.length; i++) {
            if (address(cTokens[i]) != cEther) {
                address underlying = cTokens[i].underlying();

                // If cToken is not in mapping, then add it
                if (underlyingToCToken[underlying] == address(0)) {
                    underlyingToCToken[underlying] = address(cTokens[i]);
                }
            }
        }
    }

    /**
     * Sync registration of this module on SetToken. Anyone callable
     *
     * @param _setToken             Instance of the SetToken
     */
    function syncRegister(ISetToken _setToken) public onlyValidAndInitializedSet(_setToken) {
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).register(_setToken) {} catch {}
        }
    }

    function addCollateralAsset(ISetToken _setToken, address _newCollateralAsset) external onlyManagerAndValidSet(_setToken) {
        address cToken = underlyingToCToken[_newCollateralAsset];
        require(cToken != address(0), "cToken must exist in Compound");
        require(!isCollateralCTokenEnabled[_setToken][cToken], "Collateral cToken is already enabled");
        
        // Note: Will only enter market if cToken is not enabled as a borrow asset as well
        if (!isBorrowCTokenEnabled[_setToken][cToken]) {
            address[] memory marketsToEnter = new address[](1);
            marketsToEnter[0] = cToken;
            _enterMarkets(_setToken, marketsToEnter);
        }

        isCollateralCTokenEnabled[_setToken][cToken] = true;
        compoundSettings[_setToken].collateralCTokens.push(cToken);
    }

    function removeCollateralAsset(ISetToken _setToken, address _collateralAsset) external onlyManagerAndValidSet(_setToken) {
        address cToken = underlyingToCToken[_collateralAsset];
        require(isCollateralCTokenEnabled[_setToken][cToken], "Collateral cToken is already not enabled");
        
        // Note: Will only exit market if cToken is not enabled as a borrow asset as well
        if (!isBorrowCTokenEnabled[_setToken][cToken]) {
            _exitMarket(_setToken, cToken);
        }

        isCollateralCTokenEnabled[_setToken][cToken] = false;
        compoundSettings[_setToken].collateralCTokens = compoundSettings[_setToken].collateralCTokens.remove(cToken);
    }

    function addBorrowAsset(ISetToken _setToken, address _newBorrowAsset) external onlyManagerAndValidSet(_setToken) {
        address cToken = underlyingToCToken[_newBorrowAsset];
        require(cToken != address(0), "cToken must exist in Compound");
        require(!isBorrowCTokenEnabled[_setToken][cToken], "Borrow cToken is already enabled");
        
        // Note: Will only enter market if cToken is not enabled as a borrow asset as well
        if (!isCollateralCTokenEnabled[_setToken][cToken]) {
            address[] memory marketsToEnter = new address[](1);
            marketsToEnter[0] = cToken;
            _enterMarkets(_setToken, marketsToEnter);
        }

        isBorrowCTokenEnabled[_setToken][cToken] = true;
        compoundSettings[_setToken].borrowCTokens.push(cToken);
        compoundSettings[_setToken].borrowAssets.push(_newBorrowAsset);
    }

    function removeBorrowAsset(ISetToken _setToken, address _borrowAsset) external onlyManagerAndValidSet(_setToken) {
        address cToken = underlyingToCToken[_borrowAsset];
        require(isBorrowCTokenEnabled[_setToken][cToken], "Borrow cToken is already not enabled");
        
        // Note: Will only exit market if cToken is not enabled as a collateral asset as well
        // If there is an existing borrow balance, will revert and market cannot be exited on Compound
        if (!isCollateralCTokenEnabled[_setToken][cToken]) {
            _exitMarket(_setToken, cToken);
        }

        isBorrowCTokenEnabled[_setToken][cToken] = false;
        compoundSettings[_setToken].borrowCTokens = compoundSettings[_setToken].borrowCTokens.remove(cToken);
        compoundSettings[_setToken].borrowAssets = compoundSettings[_setToken].borrowAssets.remove(_borrowAsset);
    }

    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external onlyModule(_setToken) {
        sync(_setToken);
    }

    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external onlyModule(_setToken) {
        sync(_setToken);
    }

    function componentIssueHook(ISetToken _setToken, uint256 _setTokenQuantity, address _component) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(_component, address(this));
        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMul(_setTokenQuantity);

        address cToken = underlyingToCToken[_component];

        _borrow(_setToken, cToken, notionalDebt);
    }

    function componentRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity, address _component) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(_component, address(this));
        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMul(_setTokenQuantity);

        address cToken = underlyingToCToken[_component];

        _repay(_setToken, cToken, _component, notionalDebt);
    }


    /* ============ External Getter Functions ============ */

    function getEnabledCollateralCTokens(ISetToken _setToken) external view returns(address[] memory) {
        return compoundSettings[_setToken].collateralCTokens;
    }

    function getEnabledBorrowCTokens(ISetToken _setToken) external view returns(address[] memory) {
        return compoundSettings[_setToken].borrowCTokens;
    }

    function getEnabledBorrowAssets(ISetToken _setToken) external view returns(address[] memory) {
        return compoundSettings[_setToken].borrowAssets;
    }

    /* ============ Internal Functions ============ */

    /**
     * Construct the ActionInfo struct for lever and delever
     */
    function _createActionInfo(
        ISetToken _setToken,
        address _sendToken,
        address _receiveToken,
        uint256 _sendQuantity,
        uint256 _minReceiveQuantity,
        string memory _tradeAdapterName,
        bool isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo;

        actionInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName));
        actionInfo.setToken = _setToken;
        actionInfo.collateralCTokenAsset = isLever ? underlyingToCToken[_receiveToken] : underlyingToCToken[_sendToken];
        actionInfo.borrowCTokenAsset = isLever ? underlyingToCToken[_sendToken] : underlyingToCToken[_receiveToken];
        actionInfo.setTotalSupply = _setToken.totalSupply();
        actionInfo.notionalSendQuantity = _sendQuantity.preciseMul(actionInfo.setTotalSupply);
        actionInfo.minNotionalReceiveQuantity = _minReceiveQuantity.preciseMul(actionInfo.setTotalSupply);
        // Snapshot pre trade receive token balance.
        actionInfo.preTradeReceiveTokenBalance = IERC20(_receiveToken).balanceOf(address(_setToken));

        return actionInfo;
    }

    /**
     * Construct the ActionInfo struct for gulp
     */
    function _createGulpInfoAndClaim(
        ISetToken _setToken,
        address _collateralAsset,
        string memory _tradeAdapterName
    )
        internal
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo;

        actionInfo.collateralCTokenAsset = underlyingToCToken[_collateralAsset];
        require(isCollateralCTokenEnabled[_setToken][actionInfo.collateralCTokenAsset], "Collateral cToken is not enabled");
        actionInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName));
        actionInfo.setTotalSupply = _setToken.totalSupply();
        // Snapshot COMP balances pre claim
        uint256 preClaimCompBalance = IERC20(compToken).balanceOf(address(_setToken));

        // Claim COMP
        _claim(_setToken);

        // Snapshot pre trade receive token balance.
        actionInfo.preTradeReceiveTokenBalance = IERC20(_collateralAsset).balanceOf(address(_setToken));
        // Calculate notional send quantity
        actionInfo.notionalSendQuantity = IERC20(compToken).balanceOf(address(_setToken)).sub(preClaimCompBalance);
            
        return actionInfo;
    }

    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(isCollateralCTokenEnabled[_actionInfo.setToken][_actionInfo.collateralCTokenAsset], "Collateral cToken is not enabled");
        require(isBorrowCTokenEnabled[_actionInfo.setToken][_actionInfo.borrowCTokenAsset], "Borrow cToken is not enabled");
        require(_actionInfo.collateralCTokenAsset != _actionInfo.borrowCTokenAsset, "Collateral and borrow assets must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Token to sell must be nonzero");
    }

    /**
     * Invoke enter markets from SetToken
     */
    function _enterMarkets(ISetToken _setToken, address[] memory _cTokens) internal {
        // enterMarkets(address[] _cTokens)
        bytes memory enterMarketsCallData = abi.encodeWithSignature("enterMarkets(address[])", _cTokens);
        uint256[] memory returnValues = abi.decode(
            _setToken.invoke(address(comptroller), 0, enterMarketsCallData),
            (uint256[])
        );
        for (uint256 i = 0; i < _cTokens.length; i++) {
            require(
                returnValues[i] == 0,
                "Entering market failed"
            );
        }
    }

    /**
     * Invoke exit market from SetToken
     */
    function _exitMarket(ISetToken _setToken, address _cToken) internal {
        // exitMarket(address _cToken)
        bytes memory exitMarketCallData = abi.encodeWithSignature("exitMarket(address)", _cToken);
        require(
            abi.decode(_setToken.invoke(address(comptroller), 0, exitMarketCallData), (uint256)) == 0,
            "Exiting market failed"
        );
    }

    /**
     * Invoke mint from SetToken
     */
    function _mint(ISetToken _setToken, address _cToken, address _underlyingToken, uint256 _mintNotional) internal {
        if (_cToken == cEther) {
            _setToken.invokeUnwrapWETH(weth, _mintNotional);

            // mint(). No return, reverts on error.
            bytes memory mintCEthCallData = abi.encodeWithSignature("mint()");
            _setToken.invoke(_cToken, _mintNotional, mintCEthCallData);
        } else {
            // Approve to cToken
            _setToken.invokeApprove(_underlyingToken, _cToken, _mintNotional);

            // mint(uint256 _mintAmount). Returns 0 if success
            bytes memory mintCallData = abi.encodeWithSignature("mint(uint256)", _mintNotional);
            require(
                abi.decode(_setToken.invoke(_cToken, 0, mintCallData), (uint256)) == 0,
                "Mint failed"
            );
        }
    }

    /**
     * Invoke redeem from SetToken
     */
    function _redeem(ISetToken _setToken, address _cToken, uint256 _redeemNotional) internal {
        // redeemUnderlying(uint256 _underlyingAmount)
        bytes memory redeemCallData = abi.encodeWithSignature("redeemUnderlying(uint256)", _redeemNotional);

        require(
            abi.decode(_setToken.invoke(_cToken, 0, redeemCallData), (uint256)) == 0,
            "Redeem failed"
        );

        if (_cToken == cEther) {
            _setToken.invokeWrapWETH(weth, _redeemNotional);
        }
    }

    /**
     * Invoke repay from SetToken
     */
    function _repay(ISetToken _setToken, address _cToken, address _underlyingToken, uint256 _repayNotional) internal {
        if (_cToken == cEther) {
            _setToken.invokeUnwrapWETH(weth, _repayNotional);

            // repay(). No return, revert on fail
            bytes memory repayCEthCallData = abi.encodeWithSignature("repayBorrow()");
            _setToken.invoke(_cToken, _repayNotional, repayCEthCallData);
        } else {
            // Approve to cToken
            _setToken.invokeApprove(_underlyingToken, _cToken, _repayNotional);
            // repay(uint256 _repayAmount)
            bytes memory repayCallData = abi.encodeWithSignature("repayBorrow(uint256)", _repayNotional);
            require(
                abi.decode(_setToken.invoke(_cToken, 0, repayCallData), (uint256)) == 0,
                "Repay failed"
            );
        }
    }

    /**
     * Invoke borrow from SetToken
     */
    function _borrow(ISetToken _setToken, address _cToken, uint256 _notionalBorrowQuantity) internal {
        // borrow(uint256 _borrowAmount). Note: Notional borrow quantity is in units of underlying asset
        bytes memory borrowCallData = abi.encodeWithSignature("borrow(uint256)", _notionalBorrowQuantity);

        require(
            abi.decode(_setToken.invoke(_cToken, 0, borrowCallData), (uint256)) == 0,
            "Borrow failed"
        );
        if (_cToken == cEther) {
            _setToken.invokeWrapWETH(weth, _notionalBorrowQuantity);
        }
    }

    /**
     * Invoke trade from SetToken
     */
    function _trade(
        ISetToken _setToken,
        address _sendToken,
        address _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        uint256 _preTradeReceiveTokenBalance,
        IExchangeAdapter _exchangeAdapter,
        bytes memory _data
    )
        internal
        returns(uint256, uint256)
    {
        _executeTrade(
            _setToken,
            _sendToken,
            _receiveToken,
            _notionalSendQuantity,
            _minNotionalReceiveQuantity,
            _exchangeAdapter,
            _data
        );

        uint256 receiveTokenQuantity = IERC20(_receiveToken).balanceOf(address(_setToken)).sub(_preTradeReceiveTokenBalance);
        require(
            receiveTokenQuantity >= _minNotionalReceiveQuantity,
            "Slippage greater than allowed"
        );

        // Accrue protocol fee
        uint256 protocolFeeTotal = _accrueProtocolFee(_setToken, _receiveToken, receiveTokenQuantity);

        return (protocolFeeTotal, receiveTokenQuantity.sub(protocolFeeTotal));
    }

    function _executeTrade(
        ISetToken _setToken,
        address _sendToken,
        address _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        IExchangeAdapter _exchangeAdapter,
        bytes memory _data
    )
        internal
    {
         _setToken.invokeApprove(
            _sendToken,
            _exchangeAdapter.getSpender(),
            _notionalSendQuantity
        );

        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _exchangeAdapter.getTradeCalldata(
            _sendToken,
            _receiveToken,
            address(_setToken),
            _notionalSendQuantity,
            _minNotionalReceiveQuantity,
            _data
        );

        _setToken.invoke(targetExchange, callValue, methodData);
    }

    function _accrueProtocolFee(ISetToken _setToken, address _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        // Accrue protocol fee
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        
        payProtocolFeeFromSetToken(_setToken, _receiveToken, protocolFeeTotal);

        return protocolFeeTotal;
    }

    /**
     * Invoke claim COMP from SetToken
     */
    function _claim(ISetToken _setToken) internal {
        // claimComp(address _holder)
        bytes memory claimCallData = abi.encodeWithSignature("claimComp(address)", address(_setToken));

        _setToken.invoke(address(comptroller), 0, claimCallData);
    }

    function _getCollateralPosition(ISetToken _setToken, address _cToken, uint256 _setTotalSupply) internal view returns (uint256) {
        uint256 collateralNotionalBalance = IERC20(_cToken).balanceOf(address(_setToken));
        return collateralNotionalBalance.preciseDiv(_setTotalSupply);
    }

    function _getBorrowPosition(ISetToken _setToken, address _cToken, address _underlyingToken, uint256 _setTotalSupply) internal returns (int256) {
        uint256 borrowNotionalBalance = ICErc20(_cToken).borrowBalanceCurrent(address(_setToken));
        // Round negative away from 0
        return borrowNotionalBalance.preciseDivCeil(_setTotalSupply).toInt256().mul(-1);
    }

    function _updateCollateralPosition(ISetToken _setToken, address _cToken, uint256 _newPositionUnit) internal {
        _setToken.editDefaultPosition(_cToken, _newPositionUnit);
    }

    function _updateBorrowPosition(ISetToken _setToken, address _underlyingToken, int256 _newPositionUnit) internal {
        _setToken.editExternalPosition(_underlyingToken, address(this), _newPositionUnit, "");
    }
}