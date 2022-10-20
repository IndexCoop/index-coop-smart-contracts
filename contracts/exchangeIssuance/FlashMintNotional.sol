/*
    Copyright 2022 Index Cooperative
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
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { INotionalTradeModule } from "../interfaces/INotionalTradeModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWrappedfCash } from "../interfaces/IWrappedfCash.sol";
import { IWrappedfCashFactory } from "../interfaces/IWrappedfCashFactory.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { DEXAdapter } from "./DEXAdapter.sol";





/**
 * @title FlashMintNotional
 * @author Index Coop
 *
 * Contract for issuing and redeeming a Set Token that contains wrappedfCash position
 * Includes (in the issuance case):
 *    - Matching fCash components to their underlying asset
 *    - Swapping input token to underlying asset
 *    - Minting fCash positions from underlying asset
 *    - Issuing set token   
 */
contract FlashMintNotional is Ownable, ReentrancyGuard {

    using Address for address payable;
    using Address for address;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;
    using DEXAdapter for DEXAdapter.Addresses;

    struct TradeData {
        ISetToken setToken;
        uint256 amountSetToken;
        IERC20 paymentToken;
        uint256 limitAmount;
        address issuanceModule;
        bool isDebtIssuance;
        uint256 slippage;
        bool redeemMaturedPositions;
    }

    /* ============ Constants ============== */

    // Placeholder address to identify ETH where it is treated as if it was an ERC20 token
    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    IController public immutable setController;
    IWrappedfCashFactory public immutable wrappedfCashFactory;
    INotionalTradeModule public immutable notionalTradeModule;
    DEXAdapter.Addresses public addresses;
    uint256 public decodedIdGasLimit;

    /* ============ Events ============ */

    event FlashMint(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event FlashRedeem(
        address indexed _recipient,     // The recipient adress of the output tokens obtained for redemption
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier isValidModule(address _issuanceModule) {
        require(setController.isModule(_issuanceModule), "FlashMint: INVALID ISSUANCE MODULE");
         _;
    }

    /**
    * Sets various contract addresses and gas limit for getDecodedId call
    * 
    * @param _weth                  Address of wrapped native token
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _wrappedfCashFactory   Factory contract creating new fCash wrappers
    * @param _notionalTradeModule   Module used to make sure matured positions are redeemed
    * @param _quickRouter           Address of quickswap router
    * @param _sushiRouter           Address of sushiswap router
    * @param _uniV3Router           Address of uniswap v3 router
    * @param _uniV3Quoter           Address of uniswap v3 quoter
    * @param _curveAddressProvider  Contract to get current implementation address of curve registry
    * @param _curveCalculator       Contract to calculate required input to receive given output in curve (for exact output swaps)
    * @param _decodedIdGasLimit     Gas limit for call to getDecodedID
    */
    constructor(
        address _weth,
        IController _setController,
        IWrappedfCashFactory _wrappedfCashFactory,
        INotionalTradeModule _notionalTradeModule,
        address _quickRouter,
        address _sushiRouter,
        address _uniV3Router,
        address _uniV3Quoter,
        address _curveAddressProvider,
        address _curveCalculator,
        uint256 _decodedIdGasLimit
    )
        public
    {
        setController = _setController;

        wrappedfCashFactory = _wrappedfCashFactory;
        notionalTradeModule = _notionalTradeModule;

        addresses.weth = _weth;
        addresses.quickRouter = _quickRouter;
        addresses.sushiRouter = _sushiRouter;
        addresses.uniV3Router = _uniV3Router;
        addresses.uniV3Quoter = _uniV3Quoter;
        addresses.curveAddressProvider = _curveAddressProvider;
        addresses.curveCalculator = _curveCalculator;

        decodedIdGasLimit = _decodedIdGasLimit;
    }

    /* ============ Public Functions ============ */


    /**
     * Returns component positions required for issuance 
     *
     * @param _issuanceModule    Address of issuance Module to use 
     * @param _isDebtIssuance    Flag indicating wether given issuance module is a debt issuance module
     * @param _setToken          Set token to issue
     * @param _amountSetToken    Amount of set token to issue
     */
    function getRequiredIssuanceComponents(address _issuanceModule, bool _isDebtIssuance, ISetToken _setToken, uint256 _amountSetToken) public view returns(address[] memory components, uint256[] memory positions) {
        if(_isDebtIssuance) { 
            (components, positions, ) = IDebtIssuanceModule(_issuanceModule).getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);
        }
        else {
            (components, positions) = IBasicIssuanceModule(_issuanceModule).getRequiredComponentUnitsForIssue(_setToken, _amountSetToken);
        }
    }

    /**
     * Returns component positions required for Redemption 
     *
     * @param _issuanceModule    Address of issuance Module to use 
     * @param _isDebtIssuance    Flag indicating wether given issuance module is a debt issuance module
     * @param _setToken          Set token to issue
     * @param _amountSetToken    Amount of set token to issue
     */
    function getRequiredRedemptionComponents(address _issuanceModule, bool _isDebtIssuance, ISetToken _setToken, uint256 _amountSetToken) public view returns(address[] memory components, uint256[] memory positions) {
        if(_isDebtIssuance) { 
            (components, positions, ) = IDebtIssuanceModule(_issuanceModule).getRequiredComponentRedemptionUnits(_setToken, _amountSetToken);
        }
        else {
            components = _setToken.getComponents();
            positions = new uint256[](components.length);
            for(uint256 i = 0; i < components.length; i++) {
                uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(components[i]));
                positions[i] = unit.preciseMul(_amountSetToken);
            }
        }
    }

    /* ============ External Functions ============ */

    /**
     * @dev Update gas limit of call to getDecodedID in _isWrappedFCash
     * @param _decodedIdGasLimit   New gas limit for call to getDecodedID
     */
    function updateDecodedIdGasLimit(uint256 _decodedIdGasLimit) external onlyOwner {
        require(_decodedIdGasLimit != 0, "DecodedIdGasLimit cannot be zero");
        decodedIdGasLimit = _decodedIdGasLimit;
    }

    /**
     * Withdraw slippage to selected address
     *
     * @param _tokens    Addresses of tokens to withdraw, specifiy ETH_ADDRESS to withdraw ETH
     * @param _to        Address to send the tokens to
     */
    function withdrawTokens(IERC20[] calldata _tokens, address payable _to) external onlyOwner payable {
        for(uint256 i = 0; i < _tokens.length; i++) {
            if(address(_tokens[i]) == ETH_ADDRESS){
                _to.sendValue(address(this).balance);
            }
            else{
                _tokens[i].safeTransfer(_to, _tokens[i].balanceOf(address(this)));
            }
        }
    }


    /**
     * Returns components and units but replaces wrappefCash positions with the corresponding amount of underlying token needed to mint 
     *
     * @param _setToken          Address of the set token to redeem
     * @param _amountSetToken    Amount of set token to redeem
     * @param _issuanceModule    Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance    Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage          Relative slippage (with 18 decimals) to subtract from wrappedfCash's estimated redemption amount to allow for approximation error
     */
    function getFilteredComponentsRedemption(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage

    )
        external
        view
        returns (address[] memory filteredComponents, uint[] memory filteredUnits)
    {
        return _getFilteredComponentsRedemption(_setToken, _amountSetToken, _issuanceModule, _isDebtIssuance, _slippage);
    }

    /**
     * Returns filtered components after redeeming matured positions
     * THIS METHOD SHOULD ONLY BE CALLED WITH STATICCALL
     *
     * @param _setToken          Address of the set token to redeem
     * @param _amountSetToken    Amount of set token to redeem
     * @param _issuanceModule    Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance    Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage          Relative slippage (with 18 decimals) to subtract from wrappedfCash's estimated redemption amount to allow for approximation error
     */
    function getFilteredComponentsRedemptionAfterMaturityRedemption(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage
    )
        external
        returns (address[] memory filteredComponents, uint[] memory filteredUnits)
    {
        notionalTradeModule.redeemMaturedPositions(_setToken);
        return _getFilteredComponentsRedemption(_setToken, _amountSetToken, _issuanceModule, _isDebtIssuance, _slippage);
    }


    /**
     * Returns components and units but replaces wrappefCash positions with the corresponding amount of underlying token needed to mint 
     *
     * @param _setToken          Address of the set token to issue
     * @param _amountSetToken    Amount of set token to issue
     * @param _issuanceModule    Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance    Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage          Relative slippage (with 18 decimals) to add to wrappedfCash's estimated issuance cost to allow for approximation error
     */
    function getFilteredComponentsIssuance(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage
    )
        external
        view
        returns (address[] memory filteredComponents, uint[] memory filteredUnits)
    {
        (filteredComponents, filteredUnits, ) = _getFilteredComponentsIssuance(_setToken, _amountSetToken, _issuanceModule, _isDebtIssuance, _slippage);
    }

    /**
     * Returns filtered components after redeeming matured positions
     * THIS METHOD SHOULD ONLY BE CALLED WITH STATICCALL
     *
     * @param _setToken          Address of the set token to issue
     * @param _amountSetToken    Amount of set token to issue
     * @param _issuanceModule    Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance    Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage          Relative slippage (with 18 decimals) to add to wrappedfCash's estimated issuance cost to allow for approximation error
     */
    function getFilteredComponentsIssuanceAfterMaturityRedemption(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage

    )
        external
        returns (address[] memory filteredComponents, uint[] memory filteredUnits)
    {
        notionalTradeModule.redeemMaturedPositions(_setToken);
        (filteredComponents, filteredUnits, ) =  _getFilteredComponentsIssuance(_setToken, _amountSetToken, _issuanceModule, _isDebtIssuance, _slippage);

    }

    /**
     * Issue set token for ETH
     *
     * @param _setToken                  Address of the set token to issue
     * @param _amountSetToken            Amount of set token to issue
     * @param _swapData                  Swap data for each element of the filtered components in the same order as returned by getFilteredComponentsIssuance
     * @param _issuanceModule            Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance            Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage                  Relative slippage (with 18 decimals) to add to wrappedfCash's estimated issuance cost to allow for approximation error
     * @param _redeemMaturedPositions    Set to false to skip redeeming matured positions and save gas, wich will fail if there are any matured positions
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        DEXAdapter.SwapData[] memory _swapData,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage,
        bool _redeemMaturedPositions
    )
        isValidModule(_issuanceModule)
        external
        payable
        nonReentrant
        returns (uint256)
    {

        IWETH(addresses.weth).deposit{value: msg.value}();
        TradeData memory tradeData = TradeData(
            _setToken,
            _amountSetToken,
            IERC20(addresses.weth),
            msg.value,
            _issuanceModule,
            _isDebtIssuance,
            _slippage,
            _redeemMaturedPositions
        );
        uint256 totalInputTokenSpent = _issueExactSetFromToken(tradeData,  _swapData);
        uint256 amountTokenReturn = msg.value.sub(totalInputTokenSpent);
        if (amountTokenReturn > 0) {
            IWETH(addresses.weth).withdraw(amountTokenReturn);
            payable(msg.sender).transfer(amountTokenReturn);
        }
        return totalInputTokenSpent;
    }

    /**
     * Issue set token for ERC20 Token
     *
     * @param _setToken                  Address of the set token to issue
     * @param _amountSetToken            Amount of set token to issue
     * @param _inputToken                Address of the input token to spent
     * @param _maxAmountInputToken       Maximum amount of input token to spent
     * @param _swapData                  Configuration of swaps from input token to each element of the filtered components in the same order as returned by getFilteredComponentsIssuance
     * @param _issuanceModule            Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance            Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage                  Relative slippage (with 18 decimals) to add to wrappedfCash's estimated issuance cost to allow for approximation error
     * @param _redeemMaturedPositions    Set to false to skip redeeming matured positions and save gas, wich will fail if there are any matured positions
     */
    function issueExactSetFromToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData[] memory _swapData,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage,
        bool _redeemMaturedPositions
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {

        _inputToken.safeTransferFrom(msg.sender, address(this), _maxAmountInputToken);
        TradeData memory tradeData = TradeData(
            _setToken,
            _amountSetToken,
            _inputToken,
            _maxAmountInputToken,
            _issuanceModule,
            _isDebtIssuance,
            _slippage,
            _redeemMaturedPositions
        );
        uint256 totalInputTokenSpent = _issueExactSetFromToken(tradeData, _swapData);
        _returnExcessInputToken(_inputToken, _maxAmountInputToken, totalInputTokenSpent);
        return totalInputTokenSpent;
    }

    /**
     * Redeem set token for selected output token
     *
     * @param _setToken                  Address of the set token to redeem
     * @param _amountSetToken            Amount of set token to redeem
     * @param _outputToken               Address of the output token to spent
     * @param _minOutputReceive          Minimum amount of output token to receive
     * @param _swapData                  Configuration of swaps from each element of the filtered components to the output token in the same order as returned by getFilteredComponentsIssuance
     * @param _issuanceModule            Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance            Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage                  Relative slippage (with 18 decimals) to subtract from wrappedfCash's estimated redemption amount to allow for approximation error
     * @param _redeemMaturedPositions    Set to false to skip redeeming matured positions and save gas, wich will fail if there are any matured positions
     */
    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _amountSetToken,
        uint256 _minOutputReceive,
        DEXAdapter.SwapData[] memory _swapData,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage,
        bool _redeemMaturedPositions
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {

        TradeData memory tradeData = TradeData(
            _setToken,
            _amountSetToken,
            _outputToken,
            _minOutputReceive,
            _issuanceModule,
            _isDebtIssuance,
            _slippage,
            _redeemMaturedPositions
        );
        uint256 outputAmount = _redeemExactSetForToken(tradeData, _swapData);
        _outputToken.safeTransfer(msg.sender, outputAmount);
        return outputAmount;
    }

    /**
     * Redeem set token for eth
     *
     * @param _setToken                  Address of the set token to redeem
     * @param _amountSetToken            Amount of set token to redeem
     * @param _minOutputReceive          Minimum amount of output token to receive
     * @param _swapData                  Configuration of swaps from each element of the filtered components to the output token in the same order as returned by getFilteredComponentsIssuance
     * @param _issuanceModule            Address of the issuance module to use for getting raw list of components and units
     * @param _isDebtIssuance            Boolean indicating wether given issuance module is an instance of Debt- or BasicIssuanceModule
     * @param _slippage                  Relative slippage (with 18 decimals) to subtract from wrappedfCash's estimated redemption amount to allow for approximation error
     * @param _redeemMaturedPositions    Set to false to skip redeeming matured positions and save gas, wich will fail if there are any matured positions
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minOutputReceive,
        DEXAdapter.SwapData[] memory _swapData,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage,
        bool _redeemMaturedPositions
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {

        
        TradeData memory tradeData = TradeData(
            _setToken,
            _amountSetToken,
            IERC20(addresses.weth),
            _minOutputReceive,
            _issuanceModule,
            _isDebtIssuance,
            _slippage,
            _redeemMaturedPositions
        );
        uint256 outputAmount = _redeemExactSetForToken(tradeData, _swapData);
        IWETH(addresses.weth).withdraw(outputAmount);
        payable(msg.sender).transfer(outputAmount);
        return outputAmount;
    }

    /* ============ Internal Functions ============ */


    /**
     * Transfer in input token, swap for components, mint fCash positions and issue set
     */
    function _issueExactSetFromToken(
        TradeData memory _tradeData,
        DEXAdapter.SwapData[] memory _swapData
    )
        internal
        returns (uint256)
    {

        uint256 inputTokenBalanceBefore = _tradeData.paymentToken.balanceOf(address(this));
        if(_tradeData.redeemMaturedPositions) {
            notionalTradeModule.redeemMaturedPositions(_tradeData.setToken);
        }

        (address[] memory componentsBought, uint256[] memory amountsBought, uint256[] memory mappingToFilteredComponents) =  _buyComponentsForInputToken(
            _tradeData,
            _swapData
        );

        _mintWrappedFCashPositions(
            _tradeData,
            componentsBought,
            amountsBought,
            mappingToFilteredComponents
        );

        IBasicIssuanceModule(_tradeData.issuanceModule).issue(_tradeData.setToken, _tradeData.amountSetToken, msg.sender);

        require(inputTokenBalanceBefore.sub(_tradeData.paymentToken.balanceOf(address(this))) <= _tradeData.limitAmount, "FlashMint: OVERSPENT");

        emit FlashMint(msg.sender, _tradeData.setToken, _tradeData.paymentToken, _tradeData.limitAmount, _tradeData.amountSetToken);
        return inputTokenBalanceBefore.sub(_tradeData.paymentToken.balanceOf(address(this)));
    }

    /**
     * Redeem set, redeem fCash components, sell received tokens for output token and transfer proceds to the caller
     */
    function _redeemExactSetForToken(
        TradeData memory _tradeData,
        DEXAdapter.SwapData[] memory _swapData
    )
        internal
        returns (uint256)
    {

        uint256 outputTokenBalanceBefore = _tradeData.paymentToken.balanceOf(address(this));
        if(_tradeData.redeemMaturedPositions) {
            notionalTradeModule.redeemMaturedPositions(_tradeData.setToken);
        }
        _redeemExactSet(_tradeData.setToken, _tradeData.amountSetToken, _tradeData.issuanceModule);

        _redeemWrappedFCashPositions(_tradeData);
        _sellComponentsForOutputToken(_tradeData, _swapData);

        uint256 outputAmount = _tradeData.paymentToken.balanceOf(address(this)).sub(outputTokenBalanceBefore);

        require(outputAmount >= _tradeData.limitAmount, "FlashMint: UNDERBOUGHT");
        // Emit event
        emit FlashRedeem(msg.sender, _tradeData.setToken, _tradeData.paymentToken, _tradeData.amountSetToken, outputAmount);
        // Return output amount
        return outputAmount;
    }


    /**
     * Sells all components (after redemption of fCash positions) for the output token
     */
    function _sellComponentsForOutputToken(
        TradeData memory _tradeData,
        DEXAdapter.SwapData[] memory _swapData
    )
        internal
    {
        (address[] memory components, uint256[] memory componentUnits) = _getFilteredComponentsRedemption(
            _tradeData.setToken,
            _tradeData.amountSetToken,
            _tradeData.issuanceModule,
            _tradeData.isDebtIssuance,
            _tradeData.slippage
        );

        require(components.length == _swapData.length, "Components / Swapdata mismatch");

        for (uint256 i = 0; i < components.length; i++) {
            uint256 maxAmountSell = componentUnits[i];
            address component = components[i];
            // Component Address being zero means the filtered list is finished and all remaining components are 0 as well
            if(component == address(0)){
                break;
            }

            // If the component is equal to the output token we don't have to trade
            if(component != address(_tradeData.paymentToken)) {
                addresses.swapExactTokensForTokens(maxAmountSell, 0, _swapData[i]);
            }

        }
    }

    /**
     * Redeem all fCash positions for the underlying token
     */
    function _redeemWrappedFCashPositions(
        TradeData memory _tradeData
    ) 
    internal
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(
            _tradeData.issuanceModule,
            _tradeData.isDebtIssuance,
            _tradeData.setToken,
            _tradeData.amountSetToken
        );

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];

            if(_isWrappedFCash(component)) {
                IWrappedfCash(component).redeemToUnderlying(units, address(this), 0);
            }
        }
    }

    /**
     * Mint all fCash positions from the underlying token
     */
    function _mintWrappedFCashPositions(
        TradeData memory _tradeData,
        address[] memory componentsBought,
        uint256[] memory amountsAvailable,
        uint256[] memory mappingToFilteredComponents
    ) 
    internal
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(
            _tradeData.issuanceModule,
            _tradeData.isDebtIssuance,
            _tradeData.setToken,
            _tradeData.amountSetToken
        );

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];
            if(_isWrappedFCash(component)) {
                IERC20 underlyingToken = _getUnderlyingToken(IWrappedfCash(component));
                uint256 componentIndex = mappingToFilteredComponents[i];
                uint256 amountAvailable = amountsAvailable[componentIndex];
                underlyingToken.safeApprove(component, amountAvailable);
                uint256 underlyingBalanceBefore = underlyingToken.balanceOf(address(this));

                IWrappedfCash(component).mintViaUnderlying(amountAvailable, uint88(units), address(this), 0);

                uint256 amountSpent = underlyingBalanceBefore.sub(underlyingToken.balanceOf(address(this)));
                amountsAvailable[componentIndex] = amountsAvailable[componentIndex].sub(amountSpent);
            }
            IERC20(component).safeApprove(_tradeData.issuanceModule, units);
        }
    }

    /**
     * Get underlying token of fCash positions returning weth address in case underlying is eth
     */
    function _getUnderlyingToken(
        IWrappedfCash _wrappedfCash
    ) 
    internal
    view 
    returns(IERC20)
    {
        (IERC20 underlyingToken, bool isEth) = _wrappedfCash.getToken(true);
        if(isEth) {
            underlyingToken = IERC20(addresses.weth);
        }
        return underlyingToken;
    }



    /**
     * Transfers given amount of set token from the sender and redeems it for underlying components.
     * Obtained component tokens are sent to this contract. 
     *
     * @param _setToken     Address of the SetToken to be redeemed
     * @param _amount       Amount of SetToken to be redeemed
     */
    function _redeemExactSet(ISetToken _setToken, uint256 _amount, address _issuanceModule) internal returns (uint256) {
        _setToken.safeTransferFrom(msg.sender, address(this), _amount);
        _setToken.safeApprove(_issuanceModule, _amount);
        IBasicIssuanceModule(_issuanceModule).redeem(_setToken, _amount, address(this));
    }

    /**
     * Returns excess input token
     *
     * @param _inputToken         Address of the input token to return
     * @param _receivedAmount     Amount received by the caller
     * @param _spentAmount        Amount spent for issuance
     */
    function _returnExcessInputToken(IERC20 _inputToken, uint256 _receivedAmount, uint256 _spentAmount) internal {
        uint256 amountTokenReturn = _receivedAmount.sub(_spentAmount);
        if (amountTokenReturn > 0) {
            _inputToken.safeTransfer(msg.sender,  amountTokenReturn);
        }
    }

    /**
     * @dev Checks if a given address is an fCash position that was deployed from the factory
     */
    function _isWrappedFCash(address _fCashPosition) internal view returns(bool){
        if(!_fCashPosition.isContract()) {
            return false;
        }

        //Had to add this gas limit since this call wasted all the gas when directed to WETH in unittests
        try IWrappedfCash(_fCashPosition).getDecodedID{gas: decodedIdGasLimit}() returns(uint16 _currencyId, uint40 _maturity){
            try wrappedfCashFactory.computeAddress(_currencyId, _maturity) returns(address _computedAddress){
                return _fCashPosition == _computedAddress;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    /**
     * @dev Returns estimated amount of underlying tokens spent on minting given amount of fCash, adding given slippage percentage
     */
    function _getUnderlyingTokensForMint(IWrappedfCash _fCashPosition, uint256 _fCashAmount, uint256 _slippage)
    internal
    view
    returns(uint256)
    {
        return _fCashPosition.previewMint(_fCashAmount).mul(1 ether + _slippage).div(1 ether);
    }

    /**
     * @dev Returns estimated amount of underlying tokens returned on redeeming given amount of fCash, subtracting given slippage percentage
     */
    function _getUnderlyingTokensForRedeem(IWrappedfCash _fCashPosition, uint256 _fCashAmount, uint256 _slippage)
    internal
    view
    returns(uint256)
    {
        return _fCashPosition.previewRedeem(_fCashAmount).mul(1 ether - _slippage).div(1 ether);
    }

    /**
     * @dev Helper method to find a given address in the list. Returns index+1 if found, 0 if not found.
     */
    function _findComponent(address[] memory _components, address _toFind)
    internal
    pure
    returns(uint256)
    {
        for(uint256 i = 0; i < _components.length; i++) {
            if(_components[i] == _toFind){
                return i + 1;
            }
        }
        return 0;
    }

    /**
     * @dev Swaps input token for required amounts of filtered components
     */
    function _buyComponentsForInputToken(
        TradeData memory _tradeData,
        DEXAdapter.SwapData[] memory _swapData
    ) 
    internal
    returns(address[] memory, uint256[] memory, uint256[] memory)
    {
        (address[] memory components, uint256[] memory componentUnits, uint256[] memory mappingToFilteredComponents) = _getFilteredComponentsIssuance(
            _tradeData.setToken,
            _tradeData.amountSetToken,
            _tradeData.issuanceModule,
            _tradeData.isDebtIssuance,
            _tradeData.slippage
        );

        require(components.length == _swapData.length, "Components / Swapdata mismatch");

        uint256[] memory boughtAmounts = new uint256[](components.length);

        for (uint256 i = 0; i < components.length; i++) {
            if(components[i] == address(0)){
                break;
            }

            // If the component is equal to the input token we don't have to trade
            if(components[i] != address(_tradeData.paymentToken)) {
                uint256 componentBalanceBefore = IERC20(components[i]).balanceOf(address(this));
                addresses.swapTokensForExactTokens(componentUnits[i], _tradeData.limitAmount, _swapData[i]);
                boughtAmounts[i] = IERC20(components[i]).balanceOf(address(this)).sub(componentBalanceBefore);
            } else {
                boughtAmounts[i] = componentUnits[i];
            }
        }

        return(components, boughtAmounts, mappingToFilteredComponents);
    }

    /**
     * @dev Returns expected of components received upon set tokens redemption, replacing fCash position with equivalent amount of underlying token
     */
    function _getFilteredComponentsRedemption(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage
    )
        internal
        view
        returns (address[] memory filteredComponents, uint[] memory filteredUnits)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);

        filteredComponents = new address[](components.length);
        filteredUnits = new uint256[](components.length);
        uint j = 0;

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units;

            if(_isWrappedFCash(component)) {
                units = _getUnderlyingTokensForRedeem(IWrappedfCash(component), componentUnits[i], _slippage);
                IERC20 underlyingToken = _getUnderlyingToken(IWrappedfCash(component));
                component = address(underlyingToken);
            }
            else {
                units = componentUnits[i];
            }

            uint256 componentIndex = _findComponent(filteredComponents, component);
            if(componentIndex > 0){
                filteredUnits[componentIndex - 1] = filteredUnits[componentIndex - 1].add(units);
            } else {
                filteredComponents[j] = component;
                filteredUnits[j] = units;
                j++;
            }
        }
    }

    /**
     * @dev Returns expected of components spent upon set tokens issuance, replacing fCash position with equivalent amount of underlying token
     */
    function _getFilteredComponentsIssuance(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance,
        uint256 _slippage
    )
        internal
        view
        returns (address[] memory filteredComponents, uint[] memory filteredUnits, uint256[] memory mappingToFilteredComponent)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);

        filteredComponents = new address[](components.length);
        filteredUnits = new uint256[](components.length);
        mappingToFilteredComponent = new uint256[](components.length);
        uint j = 0;

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units;

            if(_isWrappedFCash(component)) {
                units = _getUnderlyingTokensForMint(IWrappedfCash(component), componentUnits[i], _slippage);
                IERC20 underlyingToken = _getUnderlyingToken(IWrappedfCash(component));
                component = address(underlyingToken);
            }
            else {
                units = componentUnits[i];
            }

            uint256 componentIndex = _findComponent(filteredComponents, component);
            if(componentIndex > 0){
                filteredUnits[componentIndex - 1] = filteredUnits[componentIndex - 1].add(units);
                mappingToFilteredComponent[i] = componentIndex - 1;
            } else {
                filteredComponents[j] = component;
                filteredUnits[j] = units;
                mappingToFilteredComponent[i] = j;
                j++;
            }
        }
    }

    /**
     * @dev Fallback method to enable receiving eth when withrdawing from weth contract
     */
    receive() external payable {
        // required for weth.withdraw() to work properly
        require(msg.sender == addresses.weth, "FlashMint: Direct deposits not allowed");
    }

}
