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

import "hardhat/console.sol";




contract ExchangeIssuanceNotional is Ownable, ReentrancyGuard {

    using Address for address payable;
    using Address for address;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    struct IssuanceModuleData {
        bool isAllowed;
        bool isDebtIssuanceModule;
    }

    /* ============ Constants ============== */

    // Placeholder address to identify ETH where it is treated as if it was an ERC20 token
    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    address public immutable WETH;
    IController public immutable setController;
    IWrappedfCashFactory public immutable wrappedfCashFactory;
    INotionalTradeModule public immutable notionalTradeModule;
    address public immutable swapTarget;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient adress of the output tokens obtained for redemption
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier isValidModule(address _issuanceModule) {
        require(setController.isModule(_issuanceModule), "ExchangeIssuance: INVALID ISSUANCE MODULE");
         _;
    }

    constructor(
        address _weth,
        IController _setController,
        IWrappedfCashFactory _wrappedfCashFactory,
        INotionalTradeModule _notionalTradeModule,
        address _swapTarget
    )
        public
    {
        setController = _setController;

        WETH = _weth;
        wrappedfCashFactory = _wrappedfCashFactory;
        notionalTradeModule = _notionalTradeModule;
        swapTarget = _swapTarget;
    }

    /* ============ External Functions ============ */

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

    receive() external payable {
        // required for weth.withdraw() to work properly
        require(msg.sender == WETH, "ExchangeIssuance: Direct deposits not allowed");
    }

    /* ============ Public Functions ============ */


    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a SetToken during a
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     * @param _spender  Address of the spender which will be approved to spend token. (Must be a whitlisted issuance module)
     */
    function approveToken(IERC20 _token, address _spender) public  isValidModule(_spender) {
        _safeApprove(_token, _spender, type(uint256).max);
    }

    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     * @param _spender   Address of the spender which will be approved to spend token. (Must be a whitlisted issuance module)
     */
    function approveTokens(IERC20[] calldata _tokens, address _spender) external {
        for (uint256 i = 0; i < _tokens.length; i++) {
            approveToken(_tokens[i], _spender);
        }
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a SetToken. This function need to be called only once before the first time
     * this smart contract is used on any particular SetToken.
     *
     * @param _setToken          Address of the SetToken being initialized
     * @param _issuanceModule    Address of the issuance module which will be approved to spend component tokens.
     */
    function approveSetToken(ISetToken _setToken, address _issuanceModule) external {
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            approveToken(IERC20(components[i]), _issuanceModule);
        }
    }

    /**
     * Returns components and units but replaces wrappefCash positions with the corresponding amount of underlying token needed to mint 
     *
     */
    function getFilteredComponents(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _issuanceModule,
        bool _isDebtIssuance
    )
        public
        view
        returns (address[] memory filteredComponents, uint[] memory filteredUnits)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);

        filteredComponents = new address[](components.length);
        filteredUnits = new uint256[](components.length);
        uint j = 0;

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units;

            if(_isWrappedFCash(component)) {
                units = _getUnderlyingTokensForMint(IWrappedfCash(component), componentUnits[i]);
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

    function issueExactSetFromToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        bytes[] memory _componentQuotes,
        address _issuanceModule,
        bool _isDebtIssuance
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {

        _inputToken.safeTransferFrom(msg.sender, address(this), _maxAmountInputToken);
        _safeApprove(_inputToken, swapTarget, _maxAmountInputToken);
        uint256 inputTokenBalanceBefore = _inputToken.balanceOf(address(this));
        notionalTradeModule.redeemMaturedPositions(_setToken);

        _buyComponentsForInputToken(_setToken, _amountSetToken,  _componentQuotes, _inputToken, _issuanceModule, _isDebtIssuance);
        _mintWrappedFCashPositions(_setToken, _amountSetToken, _inputToken, _maxAmountInputToken, _issuanceModule, _isDebtIssuance);

        IBasicIssuanceModule(_issuanceModule).issue(_setToken, _amountSetToken, msg.sender);
        uint256 inputTokenBalanceAfter = _inputToken.balanceOf(address(this));
        uint256 totalInputTokenSpent = inputTokenBalanceBefore.sub(inputTokenBalanceAfter);

        require(totalInputTokenSpent <= _maxAmountInputToken, "ExchangeIssuance: OVERSPENT");

        _returnExcessInputToken(_inputToken, _maxAmountInputToken, totalInputTokenSpent);

        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _maxAmountInputToken, _amountSetToken);
        return totalInputTokenSpent;
    }

    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _amountSetToken,
        uint256 _minOutputReceive,
        address _issuanceModule,
        bool _isDebtIssuance
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {

        uint256 outputAmount;
        _redeemExactSet(_setToken, _amountSetToken, _issuanceModule);

        outputAmount = _redeemWrappedFCashPositions(_setToken, _amountSetToken, _outputToken, _issuanceModule, _isDebtIssuance);
        require(outputAmount >= _minOutputReceive, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");

        // Transfer sender output token
        _outputToken.safeTransfer(msg.sender, outputAmount);
        // Emit event
        emit ExchangeRedeem(msg.sender, _setToken, _outputToken, _amountSetToken, outputAmount);
        // Return output amount
        return outputAmount;
    }



    /**
     * Sets a max approval limit for an ERC20 token, provided the current allowance
     * is less than the required allownce.
     *
     * @param _token    Token to approve
     * @param _spender  Spender address to approve
     */
    function _safeApprove(IERC20 _token, address _spender, uint256 _requiredAllowance) internal {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < _requiredAllowance) {
            _token.safeIncreaseAllowance(_spender, type(uint256).max - allowance);
        }
    }

    function _redeemWrappedFCashPositions(
        ISetToken _setToken,
        uint256 _amountSetToken,
        IERC20 _outputToken,
        address _issuanceModule,
        bool _isDebtIssuance
    ) 
    internal
    returns (uint256 totalInputTokenObtained)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);

        uint256 outputTokenBalanceBefore = _outputToken.balanceOf(address(this));
        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];

            if(_isWrappedFCash(component)) {
                bool useUnderlying = _isUnderlying(IWrappedfCash(component), _outputToken);
                if(useUnderlying) {
                    IWrappedfCash(component).redeemToUnderlying(units, address(this), 0);
                } else {
                    IWrappedfCash(component).redeemToAsset(units, address(this), 0);
                }
            }
        }
        uint256 outputTokenBalanceAfter = _outputToken.balanceOf(address(this));
        totalInputTokenObtained = totalInputTokenObtained.add(outputTokenBalanceAfter.sub(outputTokenBalanceBefore));
    }

    function _mintWrappedFCashPositions(
        ISetToken _setToken,
        uint256 _amountSetToken,
        IERC20 _inputToken,
        uint256 _maxAmountInputToken,
        address _issuanceModule,
        bool _isDebtIssuance
    ) 
    internal
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];
            if(_isWrappedFCash(component)) {
                IERC20 underlyingToken = _getUnderlyingToken(IWrappedfCash(component));
                underlyingToken.approve(component, _maxAmountInputToken);
                IWrappedfCash(component).mintViaUnderlying(_maxAmountInputToken, uint88(units), address(this), 0);
            }
        }
    }

    function _getUnderlyingToken(
        IWrappedfCash _wrappedfCash
    ) 
    internal
    view 
    returns(IERC20 underlyingToken)
    {
        (underlyingToken,) = _wrappedfCash.getUnderlyingToken();
        if(address(underlyingToken) == ETH_ADDRESS) {
            underlyingToken = IERC20(WETH);
        }
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

    /**
     * @dev Checks if a given address is an fCash position that was deployed from the factory
     */
    function _isWrappedFCash(address _fCashPosition) internal view returns(bool){
        if(!_fCashPosition.isContract()) {
            return false;
        }

        //Had to add this gas limit since this call wasted all the gas when directed to WETH in unittests
        //TODO: Review
        try IWrappedfCash(_fCashPosition).getDecodedID{gas: 10000}() returns(uint16 _currencyId, uint40 _maturity){
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
     * @dev Returns boolean indicating if given paymentToken is the underlying of the given fCashPosition
     * @dev Reverts if given token is neither underlying nor asset token of the fCashPosition
     */
    function _isUnderlying(
        IWrappedfCash _fCashPosition,
        IERC20 _paymentToken
    )
    internal
    view
    returns(bool isUnderlying)
    {
        (IERC20 underlyingToken, IERC20 assetToken) = _getUnderlyingAndAssetTokens(_fCashPosition);
        isUnderlying = _paymentToken == underlyingToken;
        if(!isUnderlying) {
            require(_paymentToken == assetToken, "Token is neither asset nor underlying token");
        }
    }


    /**
     * @dev Returns both underlying and asset token address for given fCash position
     */
    function _getUnderlyingAndAssetTokens(IWrappedfCash _fCashPosition)
    internal
    view
    returns(IERC20 underlyingToken, IERC20 assetToken)
    {
        (underlyingToken,) = _fCashPosition.getUnderlyingToken();
        if(address(underlyingToken) == ETH_ADDRESS) {
            underlyingToken = IERC20(WETH);
        }
        (assetToken,,) = _fCashPosition.getAssetToken();
    }

    function _getUnderlyingTokensForMint(IWrappedfCash _fCashPosition, uint256 _fCashAmount)
    internal
    view
    returns(uint256)
    {
        return _fCashPosition.previewMint(_fCashAmount);
    }

    function _findComponent(address[] memory _components, address _toFind)
    internal
    view
    returns(uint256)
    {
        for(uint256 i = 0; i < _components.length; i++) {
            if(_components[i] == _toFind){
                return i + 1;
            }
        }
        return 0;
    }

    function _buyComponentsForInputToken(
        ISetToken _setToken,
        uint256 _amountSetToken,
        bytes[] memory _quotes,
        IERC20 _inputToken,
        address _issuanceModule,
        bool _isDebtIssuance
    ) 
    internal
    {
        uint256 componentAmountBought;

        console.log("Arguments:");
        console.logAddress(address(_setToken));
        console.logUint(_amountSetToken);
        (address[] memory components, uint256[] memory componentUnits) = getFilteredComponents(
            _setToken,
            _amountSetToken,
            _issuanceModule,
            _isDebtIssuance
        );

        console.log("Filtered components");
        console.logAddress(components[0]);
        console.logUint(componentUnits[0]);

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];

            if(component == address(0)){
                break;
            }

            // If the component is equal to the input token we don't have to trade
            if(component == address(_inputToken)) {
                componentAmountBought = units;
            }
            else {
                uint256 componentBalanceBefore = IERC20(component).balanceOf(address(this));
                _fillQuote(_quotes[i]);
                uint256 componentBalanceAfter = IERC20(component).balanceOf(address(this));
                componentAmountBought = componentBalanceAfter.sub(componentBalanceBefore);
                console.log("Component bought");
                console.logAddress(component);
                console.logUint(componentAmountBought);
                console.logUint(units);
                require(componentAmountBought >= units, "ExchangeIssuance: UNDERBOUGHT COMPONENT");
            }
        }
    }

    /**
     * Execute a 0x Swap quote
     *
     * @param _quote          Swap quote as returned by 0x API
     *
     */
    function _fillQuote(
        bytes memory _quote
    )
        internal
        
    {

        (bool success, bytes memory returndata) = swapTarget.call(_quote);

        // Forwarding errors including new custom errors
        // Taken from: https://ethereum.stackexchange.com/a/111187/73805
        if (!success) {
            if (returndata.length == 0) revert();
            assembly {
                revert(add(32, returndata), mload(returndata))
            }
        }

    }
}
