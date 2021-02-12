/*
    Copyright 2021 Index Cooperative
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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IUniswapV2Factory } from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import { IUniswapV2Router02 } from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { SushiswapV2Library } from "../../external/contracts/SushiswapV2Library.sol";
import { UniswapV2Library } from "../../external/contracts/UniswapV2Library.sol";

/**
 * @title ExchangeIssuance
 * @author Index Coop
 *
 * Contract for issuing and redeeming any SetToken using ETH or an ERC20 as the paying/receiving currency.
 * All swaps are done using the best price found on Uniswap or Sushiswap.
 *
 */
contract ExchangeIssuance is ReentrancyGuard {
    
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;
    
    /* ============ Enums ============ */
    
    enum Exchange { Uniswap, Sushiswap }
    
    /* ============ State Variables ============ */

    IUniswapV2Router02 private uniRouter;
    address private uniFactory;
    IUniswapV2Router02 private sushiRouter;
    address private sushiFactory;
    
    IController private setController;
    IBasicIssuanceModule private basicIssuanceModule;
    address private WETH;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        address indexed _inputToken,    // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        address indexed _outputToken,   // The addres of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );
    
    /* ============ Modifiers ============ */
    
    modifier isSetToken(ISetToken _setToken) {
         require(setController.isSet(address(_setToken)), "ExchangeIssuance: INVALID SET");
         _;
    }
    
    /* ============ Constructor ============ */

    constructor(
        address _uniFactory,
        IUniswapV2Router02 _uniRouter, 
        address _sushiFactory, 
        IUniswapV2Router02 _sushiRouter, 
        IController _setController,
        IBasicIssuanceModule _basicIssuanceModule
    )
        public
    {
        uniFactory = _uniFactory;
        uniRouter = _uniRouter;

        sushiFactory = _sushiFactory;
        sushiRouter = _sushiRouter;

        WETH = uniRouter.WETH();
        setController = _setController;
        basicIssuanceModule = _basicIssuanceModule;
        IERC20(WETH).safeApprove(address(uniRouter), PreciseUnitMath.maxUint256());
        IERC20(WETH).safeApprove(address(sushiRouter), PreciseUnitMath.maxUint256());
    }
    
    /* ============ Public Functions ============ */
    
    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a SetToken during a 
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     */
    function approveToken(IERC20 _token) public {
        _safeApprove(_token, address(uniRouter));
        _safeApprove(_token, address(sushiRouter));
        _safeApprove(_token, address(basicIssuanceModule));
    }

    /* ============ External Functions ============ */
    
    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     */
    function approveTokens(IERC20[] calldata _tokens) external {
        for (uint256 i = 0; i < _tokens.length; i++)
            approveToken(_tokens[i]);
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a SetToken. This function need to be called only once before the first time
     * this smart contract is used on any particular SetToken.
     *
     * @param _setToken    Address of the SetToken being initialized
     */
    function approveSetToken(ISetToken _setToken) external {
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++)
            approveToken(IERC20(components[i]));
    }

    /**
     * Issues SetTokens for an exact amount of input ERC20 tokens.
     * The ERC20 token must be approved by the sender to this contract. 
     *
     * @param _setToken         Address of the SetToken being issued
     * @param _inputToken       Address of input token
     * @param _amountInput      Amount of the input token / ether to spend
     * @param _minSetReceive    Minimum amount of SetTokens to receive. Prevents unnecessary slippage.
     */
    function issueSetForExactToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountInput,
        uint256 _minSetReceive
    )   
        isSetToken(_setToken)
        external
        nonReentrant
    {   
        require(_amountInput > 0, "ExchangeIssuance: INVALID INPUTS");
        
        _inputToken.safeTransferFrom(msg.sender, address(this), _amountInput);
        
        if(address(_inputToken) != WETH) 
           _swapTokenForWETH(_inputToken, _amountInput);

        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive);
        
        emit ExchangeIssue(msg.sender, _setToken, address(_inputToken), _amountInput, setTokenAmount);
    }
    
    /**
     * Issues SetTokens for an exact amount of input ether.
     * 
     * @param _setToken         Address of the SetToken to be issued
     * @param _minSetReceive    Minimum amount of SetTokens to receive. Prevents unnecessary slippage.
     */
    function issueSetForExactETH(
        ISetToken _setToken,
        uint256 _minSetReceive
    )
        isSetToken(_setToken)
        external
        payable
        nonReentrant
    {
        require(msg.value > 0, "ExchangeIssuance: INVALID INPUTS");
        
        IWETH(WETH).deposit{value: msg.value}();
        
        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive);
        
        emit ExchangeIssue(msg.sender, _setToken, address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE), msg.value, setTokenAmount);   
    }
    
    /**
    * Issues an exact amount of SetTokens for given amount of input ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _inputToken            Address of the input token
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _maxAmountInputToken   Maximum amount of input tokens to be used to issue SetTokens
    */
    function issueExactSetFromToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        require(_amountSetToken > 0 && _maxAmountInputToken > 0, "ExchangeIssuance: INVALID INPUTS");
        
        _inputToken.safeTransferFrom(msg.sender, address(this), _maxAmountInputToken);
        
        uint256 initETHAmount = address(_inputToken) == WETH
            ? _maxAmountInputToken
            :  _swapTokenForWETH(_inputToken, _maxAmountInputToken);
        
        uint256 amountETHSpent = _issueExactSetFromWETH(_setToken, _amountSetToken);
        
        uint256 amountETHReturn = initETHAmount.sub(amountETHSpent);
        
        uint256 amountTokenReturn;
        if(address(_inputToken) == WETH)
            amountTokenReturn = amountETHReturn;
        else {
            // Get max amount of tokens with the available WETH balance
            (, Exchange exchange) = _getMaxTokenForExactToken(amountETHReturn, WETH, address(_inputToken));
            amountTokenReturn = _swapExactTokensForTokens(exchange, WETH, address(_inputToken), amountETHReturn);
        }
        
        if (amountTokenReturn > 0)
            _inputToken.safeTransfer(msg.sender, amountTokenReturn);
        
        emit ExchangeIssue(msg.sender, _setToken, address(_inputToken), _maxAmountInputToken.sub(amountTokenReturn), _amountSetToken);
    }
    
    /**
    * Issues an exact amount of SetTokens using a given amount of ether.
    *
    * @param _setToken          Address of the SetToken being issued
    * @param _amountSetToken    Amount of SetTokens to issue
    */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken
    )
        isSetToken(_setToken)
        external
        payable
        nonReentrant
    {
        require(msg.value > 0 && _amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");
        
        IWETH(WETH).deposit{value: msg.value}();
        
        uint256 amountEth = _issueExactSetFromWETH(_setToken, _amountSetToken);
        
        uint256 returnAmount = msg.value.sub(amountEth);
        
        if(returnAmount > 0) {
            IWETH(WETH).withdraw(returnAmount);
            msg.sender.transfer(returnAmount);    
        }
        
        emit ExchangeIssue(msg.sender, _setToken, address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE), amountEth, _amountSetToken);
    }
    
    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _outputToken          Address of output token
     * @param _amountSetToRedeem    Amount SetTokens to redeem
     * @param _minOutputReceive     Minimum amount of output token to receive
     */
    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _amountSetToRedeem,
        uint256 _minOutputReceive
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        require(_amountSetToRedeem > 0, "ExchangeIssuance: INVALID INPUTS");
        
        uint256 amountEthOut = _redeemExactSetForWETH(_setToken, _amountSetToRedeem);
        
        if (address(_outputToken) == WETH) {
            
            require(amountEthOut > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            _outputToken.safeTransfer(msg.sender, amountEthOut);
            
            emit ExchangeRedeem(msg.sender, _setToken, address(_outputToken), _amountSetToRedeem, amountEthOut);
        
        } else {
            
            // Get max amount of tokens with the available amountEthOut
            (uint amountTokenOut, Exchange exchange) = _getMaxTokenForExactToken(amountEthOut, address(WETH), address(_outputToken));
            require(amountTokenOut > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            
            uint256 outputAmount = _swapExactTokensForTokens(exchange, WETH, address(_outputToken), amountEthOut);
            _outputToken.safeTransfer(msg.sender, outputAmount);
           
            emit ExchangeRedeem(msg.sender, _setToken, address(_outputToken), _amountSetToRedeem, outputAmount);
        }
    }
    
    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _amountSetToRedeem    Amount SetTokens to redeem
     * @param _minETHReceive        Minimum amount of ETH to receive
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToRedeem,
        uint256 _minETHReceive
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        require(_amountSetToRedeem > 0, "ExchangeIssuance: INVALID INPUTS");
        
        uint256 amountEthOut = _redeemExactSetForWETH(_setToken, _amountSetToRedeem);
        
        require(amountEthOut > _minETHReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        
        IWETH(WETH).withdraw(amountEthOut);
        msg.sender.transfer(amountEthOut);

        emit ExchangeRedeem(msg.sender, _setToken, address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE), _amountSetToRedeem, amountEthOut);
    }

    // required for weth.withdraw() to work properly
    receive() external payable {}

    /**
     * Returns an estimated quantity of the specified SetToken given a specified amount of input token.
     * Estimating pulls the best price of each component using Uniswap or Sushiswap
     *
     * @param _setToken         Address of the SetToken being issued
     * @param _amountInput      Amount of the input token to spend
     * @param _inputToken       Address of input token.
     * @return                  Estimated amount of SetTokens that will be received
     */
    function getEstimatedIssueSetAmount(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountInput
    )
        isSetToken(_setToken)
        external
        view
        returns (uint256)
    {
        require(_amountInput > 0, "ExchangeIssuance: INVALID INPUTS");
        
        uint256 amountEth;
        if(address(_inputToken) != WETH)
            (amountEth, ) = _getMaxTokenForExactToken(_amountInput, address(WETH),  address(_inputToken));
        else
            amountEth = _amountInput;
        
        (uint256[] memory amountEthIn, Exchange[] memory exchanges, uint256 sumEth) = _getAmountETHForIssuance(_setToken);
        
        uint256 maxIndexAmount = PreciseUnitMath.maxUint256();
        ISetToken.Position[] memory positions = _setToken.getPositions();
        
        for (uint i = 0; i < positions.length; i++) {
            address token = positions[i].component;
            uint256 scaledAmountEth = amountEthIn[i].mul(amountEth).div(sumEth);
            
            uint256 amountTokenOut;
            if(exchanges[i] == Exchange.Uniswap) {
                (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, token);
                amountTokenOut = UniswapV2Library.getAmountOut(scaledAmountEth, tokenReserveA, tokenReserveB);
            } else {
                require(exchanges[i] == Exchange.Sushiswap);
                (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, token);
                amountTokenOut = SushiswapV2Library.getAmountOut(scaledAmountEth, tokenReserveA, tokenReserveB);
            }

            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(uint256(positions[i].unit)), maxIndexAmount);
        }
        return maxIndexAmount;
    }
    
    /**
    * Returns the amount of input tokens required to issue an exact amount of SetTokens.
    *
    * @param _setToken          Address of the SetToken being issued
    * @param _amountSetToken    Amount of SetTokens to issue
    * @return                   Amount of tokens needed to issue specified amount of SetTokens
    */
    function getAmountInToIssueExactSet(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountSetToken
    )
        isSetToken(_setToken)
        external
        view
        returns(uint256)
    {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");
        
        uint256 totalEth = 0;
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for(uint256 i = 0; i < positions.length; i++) {     
            uint256 amountToken = uint256(positions[i].unit).mul(_amountSetToken).div(1 ether);
            
            // get minimum amount of ETH to be spent to acquire the required amount of tokens
            (uint256 amountEth,) = _getMinTokenForExactToken(amountToken, WETH, positions[i].component);
            totalEth = totalEth.add(amountEth);
        }
        
        if(address(_inputToken) == WETH) {
            return totalEth;
        }
        
        (uint256 tokenAmount, ) = _getMinTokenForExactToken(totalEth, address(_inputToken), address(WETH));
        return tokenAmount;
    }
    
    /**
     * Returns an estimated amount of ETH or specified ERC20 received for a given SetToken and SetToken amount. 
     *
     * @param _setToken             SetToken redeemed
     * @param _amountSetToRedeem    Amount of SetToken
     * @param _outputToken          Address of output token. Ignored if _isOutputETH is true
     * @return                      Estimated amount of ether/erc20 that will be received
     */
    function getEstimatedRedeemSetAmount(
        ISetToken _setToken,
        address _outputToken,
        uint256 _amountSetToRedeem
    ) 
        isSetToken(_setToken)
        external
        view
        returns (uint256)
    {
        require(_amountSetToRedeem > 0, "ExchangeIssuance: INVALID INPUTS");
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        uint256 totalEth = 0;
        for (uint256 i = 0; i < positions.length; i++) {
            uint256 amount = uint256(positions[i].unit).mul(_amountSetToRedeem).div(1 ether);
            
            // get maximum amount of ETH received for a given amount of SetToken component
            (uint256 amountEth, ) = _getMaxTokenForExactToken(amount, positions[i].component, WETH);
            totalEth = totalEth.add(amountEth);
        }
        if(_outputToken == WETH) {
            return totalEth;
        }
        
        // get maximum amount of tokens for totalEth amount of ETH
        (uint256 tokenAmount, ) = _getMaxTokenForExactToken(totalEth, WETH, _outputToken);
        return tokenAmount;
    }
    
    
    /* ============ Internal Functions ============ */

    /**
     * Sets a max aproval limit for an ERC20 token, provided the current allowance is zero. 
     * 
     * @param _token    Token to approve
     * @param _spender  Spender address to approve
     */
    function _safeApprove(IERC20 _token, address _spender) internal returns (uint256) {
        if (_token.allowance(address(this), _spender) == 0) {
            _token.safeIncreaseAllowance(_spender, PreciseUnitMath.maxUint256());
        }
    }
    
    /**
     * Sells the total balance that the contract holds of each component of the set
     * using the best quoted price from either Uniswap or Sushiswap
     * 
     * @param _setToken     The SetToken that is being liquidated
     * @return              Amount of WETH received after liquidating all components of the SetToken
     */
    function _liquidateComponentsForWETH(ISetToken _setToken) internal returns (uint256) {
        uint256 sumEth = 0;
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for (uint256 i = 0; i < positions.length; i++) {
            address token = positions[i].component;
            uint256 tokenBalance = IERC20(token).balanceOf(address(this));
            
            // Get max amount of WETH for the available amount of SetToken component
            (, Exchange exchange) = _getMaxTokenForExactToken(tokenBalance, token, WETH);
            sumEth = sumEth.add(_swapExactTokensForTokens(exchange, token, WETH, tokenBalance));
        }
        return sumEth;
    }
    
    /**
     * Issues SetTokens for an exact amount of input WETH. 
     * Acquires SetToken components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the SetTokens.
     * 
     * @param _setToken         Address of the SetToken being issued
     * @param _minSetReceive    Minimum amount of index to receive
     * @return setTokenAmount   Amount of SetTokens issued
     */
    function _issueSetForExactWETH(ISetToken _setToken, uint256 _minSetReceive) internal returns (uint256) {
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        
        (uint256[] memory amountEthIn, Exchange[] memory exchanges, uint256 sumEth) = _getAmountETHForIssuance(_setToken);

        uint256 setTokenAmount = _acquireComponents(positions, amountEthIn, exchanges, wethBalance, sumEth);
        
        require(setTokenAmount > _minSetReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        
        basicIssuanceModule.issue(_setToken, setTokenAmount, msg.sender);
        
        return setTokenAmount;
    }
    
    /**
     * Issues an exact amount of SetTokens using WETH. 
     * Acquires SetToken components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the SetTokens.
     * 
     * @param _setToken          Address of the SetToken being issued
     * @param _amountSetToken    Amount of SetTokens to issue
     * @return sumEth            Total amount of ether used to acquire the SetToken components    
     */
    function _issueExactSetFromWETH(ISetToken _setToken, uint256 _amountSetToken) internal returns(uint256) {
        
        uint256 sumEth = 0;
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for(uint256 i = 0; i < positions.length; i++) {
            
            uint256 amountToken = uint256(positions[i].unit).mul(_amountSetToken).div(1 ether);
            
            // Get minimum amount of ETH to be spent to acquire the required amount of SetToken component
            (, Exchange exchange) = _getMinTokenForExactToken(amountToken, WETH, positions[i].component);
            uint256 amountEth = _swapTokensForExactTokens(exchange, WETH, positions[i].component, amountToken);
            sumEth = sumEth.add(amountEth);
        }
        basicIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);
        return sumEth;
    }
    
    /**
     * Redeems a given amount of SetToken and then liquidates the components received for WETH.
     * 
     * @param _setToken             Address of the SetToken to be redeemed
     * @param _amountSetToRedeem    Amount of SetToken to be redeemed
     * @return                      Amount of WETH received after liquidating SetToken components
     */
    function _redeemExactSetForWETH(ISetToken _setToken, uint256 _amountSetToRedeem) internal returns (uint256) {
        _setToken.safeTransferFrom(msg.sender, address(this), _amountSetToRedeem);
        
        basicIssuanceModule.redeem(_setToken, _amountSetToRedeem, address(this));
        
        return _liquidateComponentsForWETH(_setToken);
    }
    
    /**
     * Gets the amount of ether required for issuing each component in a set SetToken.
     * The amount of ether is calculated based on prices across both uniswap and sushiswap.
     * 
     * @param _setToken      Address of the SetToken
     * @return amountEthIn   An array containing the amount of ether to purchase each component of the set
     * @return exchanges     An array containing the exchange on which to perform the swap
     * @return sumEth        The approximate total ETH cost to issue the set
     */
    function _getAmountETHForIssuance(ISetToken _setToken)
        internal
        view
        returns (uint256[] memory, Exchange[] memory, uint256)
    {
        uint256 sumEth = 0;
        ISetToken.Position[] memory positions = _setToken.getPositions();
        
        uint256[] memory amountEthIn = new uint256[](positions.length);
        Exchange[] memory exchanges = new Exchange[](positions.length);
        
        for(uint256 i = 0; i < positions.length; i++) {
            
            // Get minimum amount of ETH to be spent to acquire the required amount of SetToken component
            (amountEthIn[i], exchanges[i]) = _getMinTokenForExactToken(uint256(positions[i].unit), WETH, positions[i].component);
            sumEth = sumEth.add(amountEthIn[i]);
        }
        return (amountEthIn, exchanges, sumEth);
    }
    
    /**
     * Aquires all the components neccesary to issue a set, purchasing tokens
     * from either Uniswap or Sushiswap to get the best price.
     *
     * @param positions     An array containing positions of the SetToken.
     * @param amountEthIn   An array containint the approximate ETH cost of each component.
     * @param wethBalance   The amount of WETH that the contract has to spend on aquiring the total components
     * @param sumEth        The approximate amount of ETH required to purchase the necessary tokens
     *
     * @return              The maximum amount of the SetToken that can be issued with the aquired components
     */
    function _acquireComponents(
        ISetToken.Position[] memory positions,
        uint256[] memory amountEthIn,
        Exchange[] memory exchanges,
        uint256 wethBalance,
        uint256 sumEth
    ) 
        internal
        returns (uint256)
    {
        uint256 maxIndexAmount = PreciseUnitMath.maxUint256();
        for (uint i = 0; i < positions.length; i++) {
            
            uint256 scaledAmountEth = amountEthIn[i].mul(wethBalance).div(sumEth);
            
            uint256 amountTokenOut = _swapExactTokensForTokens(exchanges[i], WETH, positions[i].component, scaledAmountEth);

            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(uint256(positions[i].unit)), maxIndexAmount);
        }
        return maxIndexAmount;
    }
    
    /**
     * Swaps a given amount of an ERC20 token for WETH for the best price on Uniswap/Sushiswap.
     * 
     * @param _token    Address of the ERC20 token to be swapped for WETH
     * @param _amount   Amount of ERC20 token to be swapped
     * @return          Amount of WETH received after the swap
     */
    function _swapTokenForWETH(IERC20 _token, uint256 _amount) internal returns (uint256) {
        (, Exchange exchange) = _getMaxTokenForExactToken(_amount, address(_token), WETH);
        IUniswapV2Router02 router = _getRouter(exchange);
        _safeApprove(_token, address(router));
        return _swapExactTokensForTokens(exchange, address(_token), WETH, _amount);
    }
    
    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountIn     The amount of input token to be spent
     * @return              The amount of output tokens
     */
    function _swapExactTokensForTokens(Exchange _exchange, address _tokenIn, address _tokenOut, uint256 _amountIn) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;
        return _getRouter(_exchange).swapExactTokensForTokens(_amountIn, 0, path, address(this), block.timestamp)[1];
    }
    
    /**
     * Swap tokens for exact amount of output tokens on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountOut    The amount of output token required
     * @return              The amount of input tokens spent
     */
    function _swapTokensForExactTokens(Exchange _exchange, address _tokenIn, address _tokenOut, uint256 _amountOut) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;
        return _getRouter(_exchange).swapTokensForExactTokens(_amountOut, PreciseUnitMath.maxUint256(), path, address(this), block.timestamp)[0];
    }
 
    /**
     * Compares the amount of token required for an exact amount of another token across both exchanges,
     * and returns the min amount.
     *
     * @param _amountOut    The amount of output token
     * @param _tokenA       The address of tokenA
     * @param _tokenB       The address of tokenB
     * @return              The min amount of tokenA required across both exchanges
     * @return              The Exchange on which minimum amount of tokenA is required
     */
    function _getMinTokenForExactToken(uint256 _amountOut, address _tokenA, address _tokenB) internal view returns (uint256, Exchange) {
        
        uint256 uniEthIn = PreciseUnitMath.maxUint256();
        uint256 sushiEthIn = PreciseUnitMath.maxUint256();
        
        if(_pairAvailable(uniFactory, _tokenA, _tokenB)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, _tokenA, _tokenB);
            uniEthIn = UniswapV2Library.getAmountIn(_amountOut, tokenReserveA, tokenReserveB);
        }
        
        if(_pairAvailable(sushiFactory, _tokenA, _tokenB)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, _tokenA, _tokenB);
            sushiEthIn = SushiswapV2Library.getAmountIn(_amountOut, tokenReserveA, tokenReserveB);
        }
        
        return (uniEthIn <= sushiEthIn) ? (uniEthIn, Exchange.Uniswap) : (sushiEthIn, Exchange.Sushiswap);
    }
    
    /**
     * Compares the amount of token received for an exact amount of another token across both exchanges,
     * and returns the max amount.
     *
     * @param _amountIn     The amount of input token
     * @param _tokenA       The address of tokenA
     * @param _tokenB       The address of tokenB
     * @return              The max amount of tokens that can be received across both exchanges
     * @return              The Exchange on which maximum amount of token can be received
     */
    function _getMaxTokenForExactToken(uint256 _amountIn, address _tokenA, address _tokenB) internal view returns (uint256, Exchange) {
        
        uint256 uniTokenOut = 0;
        uint256 sushiTokenOut = 0;
        
        if(_pairAvailable(uniFactory, _tokenA, _tokenB)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, _tokenA, _tokenB);
            uniTokenOut = UniswapV2Library.getAmountOut(_amountIn, tokenReserveA, tokenReserveB);
        }
        
        if(_pairAvailable(sushiFactory, _tokenA, _tokenB)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, _tokenA, _tokenB);
            sushiTokenOut = SushiswapV2Library.getAmountOut(_amountIn, tokenReserveA, tokenReserveB);
        }
        
        return (uniTokenOut >= sushiTokenOut) ? (uniTokenOut, Exchange.Uniswap) : (sushiTokenOut, Exchange.Sushiswap); 
    }
    
    /**
     * Checks if a pair is available on the given DEX.
     *
     * @param _factory   The factory to use (can be either uniFactory or sushiFactory)
     * @param _tokenA    The address of the tokenA
     * @param _tokenB    The address of the tokenB
     * @return          A boolean representing if the token is available
     */
    function _pairAvailable(address _factory, address _tokenA, address _tokenB) internal view returns (bool) {
        return IUniswapV2Factory(_factory).getPair(_tokenA, _tokenB) != address(0);
    }
    
    /**
     * Returns the router address of a given exchange.
     * 
     * @param _exchange     The Exchange whose router address is needed
     * @return              IUniswapV2Router02 router of the given exchange
     */
     function _getRouter(Exchange _exchange) internal view returns(IUniswapV2Router02) {
         return (_exchange == Exchange.Uniswap) ? uniRouter : sushiRouter;
     }
    
}