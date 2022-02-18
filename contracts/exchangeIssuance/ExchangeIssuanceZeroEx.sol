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
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


contract ExchangeIssuanceZeroEx is Ownable, ReentrancyGuard {

    using Address for address payable;
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
        address _swapTarget
    )
        public
    {
        setController = _setController;

        WETH = _weth;
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
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _inputToken            Address of the input token
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _maxAmountInputToken   Maximum amount of input tokens to be used to issue SetTokens.
    * @param _componentQuotes       The encoded 0x transactions to execute 
    *
    * @return totalInputTokenSold   Amount of input token spent for issuance
    */
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

        uint256 totalInputTokenSold = _buyComponentsForInputToken(_setToken, _amountSetToken,  _componentQuotes, _inputToken, _issuanceModule, _isDebtIssuance);
        require(totalInputTokenSold <= _maxAmountInputToken, "ExchangeIssuance: OVERSPENT TOKEN");

        IBasicIssuanceModule(_issuanceModule).issue(_setToken, _amountSetToken, msg.sender);

        _returnExcessInputToken(_inputToken, _maxAmountInputToken, totalInputTokenSold);

        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _maxAmountInputToken, _amountSetToken);
        return totalInputTokenSold;
    }


    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _componentQuotes       The encoded 0x transactions to execute
    *
    * @return amountEthReturn       Amount of ether returned to the caller
    */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        bytes[] memory _componentQuotes,
        address _issuanceModule,
        bool _isDebtIssuance
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        payable
        returns (uint256)
    {
        require(msg.value > 0, "ExchangeIssuance: NO ETH SENT");

        IWETH(WETH).deposit{value: msg.value}();
        _safeApprove(IERC20(WETH), swapTarget, msg.value);

        uint256 totalEthSold = _buyComponentsForInputToken(_setToken, _amountSetToken, _componentQuotes, IERC20(WETH), _issuanceModule, _isDebtIssuance);

        require(totalEthSold <= msg.value, "ExchangeIssuance: OVERSPENT ETH");
        IBasicIssuanceModule(_issuanceModule).issue(_setToken, _amountSetToken, msg.sender);

        uint256 amountEthReturn = msg.value.sub(totalEthSold);
        if (amountEthReturn > 0) {
            IWETH(WETH).withdraw(amountEthReturn);
            payable(msg.sender).sendValue(amountEthReturn);
        }

        emit ExchangeIssue(msg.sender, _setToken, IERC20(ETH_ADDRESS), totalEthSold, _amountSetToken);
        return amountEthReturn; 
    }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _outputToken          Address of output token
     * @param _amountSetToken       Amount SetTokens to redeem
     * @param _minOutputReceive     Minimum amount of output token to receive
     * @param _componentQuotes      The encoded 0x transactions execute (components -> WETH).
     * @param _issuanceModule       Address of issuance Module to use 
     * @param _isDebtIssuance       Flag indicating wether given issuance module is a debt issuance module
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _amountSetToken,
        uint256 _minOutputReceive,
        bytes[] memory _componentQuotes,
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

        outputAmount = _sellComponentsForOutputToken(_setToken, _amountSetToken, _componentQuotes, _outputToken, _issuanceModule, _isDebtIssuance);
        require(outputAmount >= _minOutputReceive, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");

        // Transfer sender output token
        _outputToken.safeTransfer(msg.sender, outputAmount);
        // Emit event
        emit ExchangeRedeem(msg.sender, _setToken, _outputToken, _amountSetToken, outputAmount);
        // Return output amount
        return outputAmount;
    }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _amountSetToken       Amount SetTokens to redeem
     * @param _minEthReceive        Minimum amount of Eth to receive
     * @param _componentQuotes      The encoded 0x transactions execute
     * @param _issuanceModule       Address of issuance Module to use 
     * @param _isDebtIssuance       Flag indicating wether given issuance module is a debt issuance module
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minEthReceive,
        bytes[] memory _componentQuotes,
        address _issuanceModule,
        bool _isDebtIssuance
    )
        isValidModule(_issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {
        _redeemExactSet(_setToken, _amountSetToken, _issuanceModule);
        uint ethAmount = _sellComponentsForOutputToken(_setToken, _amountSetToken, _componentQuotes, IERC20(WETH), _issuanceModule, _isDebtIssuance);
        require(ethAmount >= _minEthReceive, "ExchangeIssuance: INSUFFICIENT WETH RECEIVED");

        IWETH(WETH).withdraw(ethAmount);
        (payable(msg.sender)).sendValue(ethAmount);

        emit ExchangeRedeem(msg.sender, _setToken, IERC20(ETH_ADDRESS), _amountSetToken, ethAmount);
        return ethAmount;
         
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

    /**
     * Issues an exact amount of SetTokens using WETH.
     * Acquires SetToken components by executing the 0x swaps whose callata is passed in _quotes.
     * Uses the acquired components to issue the SetTokens.
     *
     * @param _setToken             Address of the SetToken being issued
     * @param _amountSetToken       Amount of SetTokens to be issued
     * @param _quotes               The encoded 0x transaction calldata to execute against the 0x ExchangeProxy
     * @param _inputToken           Token to use to pay for issuance. Must be the sellToken of the 0x trades.
     * @param _issuanceModule       Issuance module to use for set token issuance.
     *
     * @return totalInputTokenSold  Total amount of input token spent on this issuance
     */
    function _buyComponentsForInputToken(
        ISetToken _setToken,
        uint256 _amountSetToken,
        bytes[] memory _quotes,
        IERC20 _inputToken,
        address _issuanceModule,
        bool _isDebtIssuance
    ) 
    internal
    returns (uint256 totalInputTokenSold)
    {
        uint256 componentAmountBought;

        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);

        uint256 inputTokenBalanceBefore = _inputToken.balanceOf(address(this));
        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];

            // If the component is equal to the input token we don't have to trade
            if(component == address(_inputToken)) {
                totalInputTokenSold = totalInputTokenSold.add(units);
                componentAmountBought = units;
            }
            else {
                uint256 componentBalanceBefore = IERC20(component).balanceOf(address(this));
                _fillQuote(_quotes[i]);
                uint256 componentBalanceAfter = IERC20(component).balanceOf(address(this));
                componentAmountBought = componentBalanceAfter.sub(componentBalanceBefore);
                require(componentAmountBought >= units, "ExchangeIssuance: UNDERBOUGHT COMPONENT");
            }
        }
        uint256 inputTokenBalanceAfter = _inputToken.balanceOf(address(this));
        totalInputTokenSold = totalInputTokenSold.add(inputTokenBalanceBefore.sub(inputTokenBalanceAfter));
    }

    /**
     * Redeems a given list of SetToken components for given token.
     *
     * @param _setToken             The set token being swapped.
     * @param _amountSetToken       The amount of set token being swapped.
     * @param _swaps                An array containing ZeroExSwap swaps.
     * @param _outputToken          The token for which to sell the index components must be the same as the buyToken that was specified when generating the swaps
     * @param _issuanceModule    Address of issuance Module to use 
     * @param _isDebtIssuance    Flag indicating wether given issuance module is a debt issuance module
     *
     * @return totalOutputTokenBought  Total amount of output token received after liquidating all SetToken components
     */
    function _sellComponentsForOutputToken(ISetToken _setToken, uint256 _amountSetToken, bytes[] memory _swaps, IERC20 _outputToken, address _issuanceModule, bool _isDebtIssuance)
        internal
        returns (uint256 totalOutputTokenBought)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(_issuanceModule, _isDebtIssuance, _setToken, _amountSetToken);
        uint256 outputTokenBalanceBefore = _outputToken.balanceOf(address(this));
        for (uint256 i = 0; i < _swaps.length; i++) {
            uint256 maxAmountSell = componentUnits[i];

            uint256 componentAmountSold;

            // If the component is equal to the output token we don't have to trade
            if(components[i] == address(_outputToken)) {
                totalOutputTokenBought = totalOutputTokenBought.add(maxAmountSell);
                componentAmountSold = maxAmountSell;
            }
            else {
                _safeApprove(IERC20(components[i]), address(swapTarget), maxAmountSell);
                uint256 componentBalanceBefore = IERC20(components[i]).balanceOf(address(this));
                _fillQuote(_swaps[i]);
                uint256 componentBalanceAfter = IERC20(components[i]).balanceOf(address(this));
                componentAmountSold = componentBalanceBefore.sub(componentBalanceAfter);
                require(maxAmountSell >= componentAmountSold, "ExchangeIssuance: OVERSOLD COMPONENT");
            }

        }
        uint256 outputTokenBalanceAfter = _outputToken.balanceOf(address(this));
        totalOutputTokenBought = totalOutputTokenBought.add(outputTokenBalanceAfter.sub(outputTokenBalanceBefore));
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
}
