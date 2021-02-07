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

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IUniswapV2Router02 } from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import { IUniswapV2Factory } from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";

import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { UniswapV2Library } from "../../external/contracts/UniswapV2Library.sol";
import { SushiswapV2Library } from "../../external/contracts/SushiswapV2Library.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { IWETH } from "../interfaces/IWETH.sol";

/**
 * @title ExchangeIssuance
 * @author Index Coop
 *
 * Contract for minting and redeeming any Set token using
 * ETH or an ERC20 as the paying/receiving currency. All swaps are done using the best price
 * found on Uniswap or Sushiswap.
 *
 */
contract ExchangeIssuance is ReentrancyGuard {
    
    // TODO: use safeERC20
    // TODO: Discuss KNC token approve function.
    
    using SafeMath for uint256;
    
    /* ============ Enums ============ */
    
    enum Exchange { Uniswap, Sushiswap }
    
    /* ============ constants ============ */
    
    uint256 constant private MAX_UINT96 = 2 ** 96 - 1;
    
    /* ============ State Variables ============ */

    IUniswapV2Router02 private uniRouter;
    address private uniFactory;
    IUniswapV2Router02 private sushiRouter;
    address private sushiFactory;

    IBasicIssuanceModule private basicIssuanceModule;
    address private WETH;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,
        address indexed _setToken,
        address indexed _inputToken,
        uint256 _amountIn,
        uint256 _amountOut
    );
    event ExchangeRedeem(
        address indexed _recipient,
        address indexed _setToken,
        address indexed _outputToken,
        uint256 _amountIn,
        uint256 _amountOut
    );

    /* ============ Constructor ============ */

    constructor(
        address _uniFactory,
        IUniswapV2Router02 _uniRouter, 
        address _sushiFactory, 
        IUniswapV2Router02 _sushiRouter, 
        IBasicIssuanceModule _basicIssuanceModule
    )
        public
    {
        uniFactory = _uniFactory;
        uniRouter = _uniRouter;

        sushiFactory = _sushiFactory;
        sushiRouter = _sushiRouter;

        WETH = uniRouter.WETH();
        basicIssuanceModule = _basicIssuanceModule;
        IERC20(WETH).approve(address(uniRouter), PreciseUnitMath.maxUint256());
        IERC20(WETH).approve(address(sushiRouter), PreciseUnitMath.maxUint256());
    }
    
    /* ============ Public Functions ============ */
    
    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a set token during a 
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     */
    function approveToken(IERC20 _token) public {
        _token.approve(address(uniRouter), MAX_UINT96);
        _token.approve(address(sushiRouter), MAX_UINT96);
        _token.approve(address(basicIssuanceModule), MAX_UINT96);
    }

    /* ============ External Functions ============ */
    
    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     */
    function approveTokens(IERC20[] calldata _tokens) external {
        for(uint256 i = 0; i < _tokens.length; i++)
            approveToken(_tokens[i]);
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a set token. This function need to be called only once before the first time
     * this smart contract is used on any particular set token.
     *
     * @param _setToken    Address of the set token being initialized
     */
    function approveSetToken(ISetToken _setToken) external {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for (uint256 i = 0; i < positions.length; i++)
            approveToken(IERC20(positions[i].component));
    }

    /**
     * Issues set tokens for an exact amount of input token. 
     * Acquires set token components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the set tokens.
     *
     * @param _setToken         Address of the set token being issued
     * @param _inputToken       Address of input token
     * @param _amountInput      Amount of the input token / ether to spend
     * @param _minSetReceive    Minimum amount of set tokens to receive
     */
    function issueSetForExactToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountInput,
        uint256 _minSetReceive
    )
        external
        nonReentrant
    {   
        _inputToken.transferFrom(msg.sender, address(this), _amountInput);
        
        if(address(_inputToken) != WETH) {      // swap inputToken to WETH
            (, Exchange exchange) = _getMaxTokenForExactToken(_amountInput, address(_inputToken), WETH);
            IERC20(_inputToken).approve(address(_getRouter(exchange)), _amountInput);
            _swapExactTokensForTokens(exchange, address(_inputToken), WETH, _amountInput);
        }
            
        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive);     // issue set token
        
        emit ExchangeIssue(msg.sender, address(_setToken), address(_inputToken), _amountInput, setTokenAmount);
        
    }
    
    /**
     * Issues set tokens for an exact amount of input ether. 
     * Acquires set token components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the set tokens.
     * 
     * @param _setToken         Address of the set token to be issued
     * @param _minSetReceive    Minimum amount of index to receive
     */
    function issueSetForExactETH(
        ISetToken _setToken,
        uint256 _minSetReceive
    )
        external
        payable
        nonReentrant
    {
        
        IWETH(WETH).deposit{value: msg.value}();
        
        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive);     // issue set token
        
        emit ExchangeIssue(msg.sender, address(_setToken), address(WETH), msg.value, setTokenAmount);
        
    }
    
    /**
    * Issues an exact amount of set tokens using ERC20 tokens as input.
    * Acquires set token components at the best price accross uniswap and sushiswap.
    * Uses the acquired components to issue the set tokens.
    *
    * @param _setToken              Address of the set token to be issued
    * @param _inputToken            Address of the input token
    * @param _amountSetToken        Amount of set tokens to issue
    * @param _amountInputToken      Amount of input tokens to be used to issue set tokens
    */
    function issueExactSetFromToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountSetToken,
        uint256 _amountInputToken
    )
        external
        nonReentrant
    {
        
        _inputToken.transferFrom(msg.sender, address(this), _amountInputToken);
        
        uint256 initETHAmount;
        if(address(_inputToken) != WETH) {      // swap inputToken to WETH
            (, Exchange exchange) = _getMaxTokenForExactToken(_amountInputToken, address(_inputToken), WETH);
            IERC20(_inputToken).approve(address(_getRouter(exchange)), _amountInputToken);
            initETHAmount = _swapExactTokensForTokens(exchange, address(_inputToken), WETH, _amountInputToken);
        } else {
            initETHAmount = _amountInputToken;
        }
        
        uint256 amountETHSpent = _issueExactSetFromWETH(_setToken, _amountSetToken);        // issue set tokens
        
        uint256 amountETHReturn = initETHAmount.sub(amountETHSpent);        // unspent ether amount
        
        uint256 amountTokenReturn;        
        if(address(_inputToken) != WETH) {      // buy return token using unspent ether
            (, Exchange exchange) = _getMaxTokenForExactToken(amountETHReturn, WETH, address(_inputToken));
            amountTokenReturn = _swapExactTokensForTokens(exchange, WETH, address(_inputToken), amountETHReturn);   
        } else {
            amountTokenReturn = amountETHReturn;
        }
        _inputToken.transfer(msg.sender, amountTokenReturn);        // return unspent tokens to user
    }
    
    /**
    * Issues an exact amount of set tokens using a given amount of ether.
    * The set token components are acquired at the best price across DEXes.
    *
    * @param _setToken          Address of the set token being issued
    * @param _amountSetToken    Amount of set tokens to issue
    */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken
    )
        external
        payable
        nonReentrant
    {
        IWETH(WETH).deposit{value: msg.value}();
        
        uint256 amountEth = _issueExactSetFromWETH(_setToken, _amountSetToken);
        
        uint256 returnAmount = msg.value.sub(amountEth);
        IWETH(WETH).withdraw(returnAmount);
        msg.sender.transfer(returnAmount);                     // return unspent ether
    }

    /**
     * Redeems an exact amount of set tokens for ETH using Uniswap
     * or Sushiswap
     *
     * @param _setToken             Address of the set token being redeemed
     * @param _amountSetToRedeem    Amount set tokens to redeem
     * @param _minOutputReceive     Minimum amount of ETH to receive
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToRedeem,
        uint256 _minOutputReceive
    )
        external
        nonReentrant
    {
        _setToken.transferFrom(msg.sender, address(this), _amountSetToRedeem);
        basicIssuanceModule.redeem(_setToken, _amountSetToRedeem, address(this));
        _liquidateComponents(_setToken);
        uint256 outputAmount = _handleRedeemOutput(true, WETH, _minOutputReceive);
        emit ExchangeRedeem(msg.sender, address(_setToken), WETH, _amountSetToRedeem, outputAmount);
    }

    /**
     * Redeems an exact amount of set tokens for an ERC20 using
     * Uniswap or Sushiswap
     *
     * @param _setToken             Address of the set token being redeemed
     * @param _outputToken          Address of output token
     * @param _amountSetToRedeem    Amount set tokens to redeem
     * @param _minOutputReceive     Minimum amount of output token to receive
     */
    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _amountSetToRedeem,
        uint256 _minOutputReceive
    )
        external
        nonReentrant
    {
        _setToken.transferFrom(msg.sender, address(this), _amountSetToRedeem);
        basicIssuanceModule.redeem(_setToken, _amountSetToRedeem, address(this));
        _liquidateComponents(_setToken);
        uint256 outputAmount = _handleRedeemOutput(false, address(_outputToken), _minOutputReceive);
        emit ExchangeRedeem(msg.sender, address(_setToken), address(_outputToken), _amountSetToRedeem, outputAmount);
    }

    /**
     * Redeems a set for an exact amount of ETH using
     * Uniswap and Sushiswap.
     *
     * @param _setToken     Address of the set token being redeemed
     * @param _outputAmount Amount of required output ETH
     * @param _maxSetSpend  Maximum amount of set token to spend
     */
    function redeemSetForExactETH(
         ISetToken _setToken,
         uint256 _outputAmount,
         uint256 _maxSetSpend
    )
        external
        nonReentrant
    {
        uint256 costForOneSet = _getEstimatedRedeemSetAmount(_setToken, 1 ether, WETH);
        uint256 approxSetToRedeem = _outputAmount.mul(1 ether).div(costForOneSet);

        uint256 sumEth = _getSumValue(_setToken, approxSetToRedeem);
        uint256 amountSetToRedeem = _outputAmount.mul(approxSetToRedeem).div(sumEth);
        require(amountSetToRedeem <= _maxSetSpend, "ExchangeIssuance: MAX_SPEND_EXCEEDED");
        
        _setToken.transferFrom(msg.sender, address(this), amountSetToRedeem);
        basicIssuanceModule.redeem(_setToken, amountSetToRedeem, address(this));
        _liquidateComponents(_setToken);
        uint256 outputAmount = _handleRedeemOutput(true, WETH, 0);
        emit ExchangeRedeem(msg.sender, address(_setToken), WETH, amountSetToRedeem, outputAmount);
    }

    /**
     * Redeems a set token for an exact amount of an
     * ERC20 token usimng Uniswap and Sushiswap.
     *
     * @param _setToken     Address of set token being redeemed
     * @param _outputToken  Output token to be received
     * @param _outputAmount Amount of required output token
     * @param _maxSetSpend     Maximum amount of set token to spend
     */
    function redeemSetForExactToken(
         ISetToken _setToken,
         IERC20 _outputToken,
         uint256 _outputAmount,
         uint256 _maxSetSpend
    )
        external
        nonReentrant
    {
        uint256 outputAmountETH = 0;
        if (address(_outputToken) == WETH) {
            outputAmountETH = _outputAmount;
        } else {
            (outputAmountETH,) = _getMinTokenForExactToken(_outputAmount, WETH, address(_outputToken));
        }

        uint256 costForOneSet = _getEstimatedRedeemSetAmount(_setToken, 1 ether, WETH);
        uint256 approxSetToRedeem = outputAmountETH.mul(1 ether).div(costForOneSet);

        uint256 sumEth = _getSumValue(_setToken, approxSetToRedeem);
        uint256 amountSetToRedeem = outputAmountETH.mul(approxSetToRedeem).div(sumEth);
        require(amountSetToRedeem <= _maxSetSpend, "ExchangeIssuance: MAX_SPEND_EXCEEDED");
        
        _setToken.transferFrom(msg.sender, address(this), amountSetToRedeem);
        basicIssuanceModule.redeem(_setToken, amountSetToRedeem, address(this));
        _liquidateComponents(_setToken);
        uint256 outputAmount = _handleRedeemOutput(false, address(_outputToken), 0);
        emit ExchangeRedeem(msg.sender, address(_setToken), WETH, amountSetToRedeem, outputAmount);

    }

    // required for weth.withdraw() to work properly
    receive() external payable {}

    /**
     * Returns an estimated quantity of the specified SetToken given a specified amount of input token.
     * Estimating pulls the best price of each component using Uniswap or Sushiswap
     *
     * @param _setToken         Address of the set token being issued
     * @param _amountInput      Amount of the input token to spend
     * @param _inputToken       Address of input token.
     * @return                  Estimated amount of Set tokens that will be received
     */
    function getEstimatedIssueSetAmount(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountInput
    )
        external
        view
        returns (uint256)
    {
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
            uint256 scaledAmountEth = amountEthIn[i].mul(amountEth).div(sumEth);  // scale the amountEthIn
            
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
    * Returns the amount of input tokens required to issue an exact amount of set tokens.
    *
    * @param _setToken          Address of the set token being issued
    * @param _amountSetToken    Amount of set tokens to issue
    * @return                   Amount of tokens needed to issue specified amount of Set tokens
    */
    function getAmountInToIssueExactSet(
        ISetToken _setToken,
        IERC20 _inputToken,
        uint256 _amountSetToken
    )
        external
        view
        returns(uint256)
    {
        
        uint256 totalEth = 0;
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for(uint256 i = 0; i < positions.length; i++) {     
            uint256 amountToken = uint256(positions[i].unit).mul(_amountSetToken).div(1 ether);
            (uint256 amountEth,) = _getMinTokenForExactToken(amountToken, WETH, positions[i].component);    // acquire set components
            totalEth = totalEth.add(amountEth);
        }
        
        if(address(_inputToken) == WETH) {
            return totalEth;
        } else {
            (uint256 tokenAmount, ) = _getMinTokenForExactToken(totalEth, address(_inputToken), address(WETH));
            return tokenAmount;
        }
    }
    
    /**
     * Returns an estimated amount of ETH or specified ERC20 received for a given SetToken and SetToken amount. 
     * Estimation pulls the best price of each component from Uniswap or Sushiswap.
     *
     * @param _setToken             Set token redeemed
     * @param _amountSetToRedeem    Amount of set token
     * @param _outputToken          Address of output token. Ignored if _isOutputETH is true
     * @return                      Estimated amount of ether/erc20 that will be received
     */
    function getEstimatedRedeemSetAmount(
        ISetToken _setToken,
        address _outputToken,
        uint256 _amountSetToRedeem
    ) 
        external
        view
        returns (uint256)
    {
        return _getEstimatedRedeemSetAmount(_setToken, _amountSetToRedeem, _outputToken);
    }

    function getAmountInToRedeemExactOutput(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _outputAmount
    )
        external
        view
        returns (uint256)
    {
        uint256 outputAmountETH = 0;
        if (address(_outputToken) == WETH) {
            outputAmountETH = _outputAmount;
        } else {
            (outputAmountETH,) = _getMinTokenForExactToken(_outputAmount, WETH, address(_outputToken));
        }

        uint256 costForOneSet = _getEstimatedRedeemSetAmount(_setToken, 1 ether, WETH);
        uint256 approxSetToRedeem = outputAmountETH.mul(1 ether).div(costForOneSet);

        uint256 sumEth = _getSumValue(_setToken, approxSetToRedeem);
        uint256 amountSetToRedeem = outputAmountETH.mul(approxSetToRedeem).div(sumEth);
        return amountSetToRedeem;
    }

    /* ============ Internal Functions ============ */

    /**
     * Returns an estimated amount of ETH or specified ERC20 received for a given SetToken and SetToken amount. 
     * Estimation pulls the best price of each component from Uniswap or Sushiswap.
     *
     * @param _setToken             Set token redeemed
     * @param _amountSetToRedeem    Amount of set token
     * @param _outputToken          Address of output token. Ignored if _isOutputETH is true
     * @return                      Estimated amount of ether/erc20 that will be received
     */
    function _getEstimatedRedeemSetAmount(
        ISetToken _setToken,
        uint256 _amountSetToRedeem,
        address _outputToken
    ) 
        internal
        view
        returns (uint256)
    {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        uint256 totalEth = 0;
        for (uint256 i = 0; i < positions.length; i++) {
            uint256 amount = uint256(positions[i].unit).mul(_amountSetToRedeem).div(1 ether);
            (uint256 amountEth, ) = _getMaxTokenForExactToken(amount, positions[i].component, WETH);
            totalEth = totalEth.add(amountEth);
        }
        if(_outputToken == WETH) {
            return totalEth;
        }
        
        (uint256 tokenAmount, ) = _getMaxTokenForExactToken(totalEth, WETH, _outputToken);
        return tokenAmount;
    }


    /**
     * Sells the total balance that the contract holds of each component of the set
     * using the best quoted price from either Uniswap or Sushiswap
     * 
     * @param _setToken     The set token that is being liquidated
     */
    function _liquidateComponents(ISetToken _setToken) internal {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for (uint256 i = 0; i < positions.length; i++) {
            address token = positions[i].component;
            uint256 tokenBalance = IERC20(token).balanceOf(address(this));
            (, Exchange exchange) = _getMaxTokenForExactToken(tokenBalance, token, WETH);
            _swapExactTokensForTokens(exchange, token, WETH, tokenBalance);
        }
    }
    
    /**
     * Issues set tokens for an exact amount of input WETH. 
     * Acquires set token components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the set tokens.
     * 
     * @param _setToken         Address of the set token being issued
     * @param _minSetReceive    Minimum amount of index to receive
     * @return setTokenAmount   Amount of set tokens issued
     */
    function _issueSetForExactWETH(ISetToken _setToken, uint256 _minSetReceive) internal returns (uint256) {
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        
        (uint256[] memory amountEthIn, Exchange[] memory exchanges, uint256 sumEth) = _getAmountETHForIssuance(_setToken);

        uint256 setTokenAmount = _acquireComponents(positions, amountEthIn, exchanges, wethBalance, sumEth);    // acquire set components
        
        require(setTokenAmount > _minSetReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        
        basicIssuanceModule.issue(_setToken, setTokenAmount, msg.sender);       // issue token
        
        return setTokenAmount;
    }
    
    /**
     * Issues an exact amount of set tokens using WETH. 
     * Acquires set token components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the set tokens.
     * 
     * @param _setToken          Address of the set token being issued
     * @param _amountSetToken    Amount of set tokens to issue
     * @return sumEth            Total amount of ether used to acquire the set token components    
     */
    function _issueExactSetFromWETH(ISetToken _setToken, uint256 _amountSetToken) internal returns(uint256) {
        
        uint256 sumEth = 0;
        
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for(uint256 i = 0; i < positions.length; i++) {     // acquire set components
            
            uint256 amountToken = uint256(positions[i].unit).mul(_amountSetToken).div(1 ether);
            
            (, Exchange exchange) = _getMinTokenForExactToken(amountToken, WETH, positions[i].component);
            uint256 amountEth = _swapTokensForExactTokens(exchange, WETH, positions[i].component, amountToken);
            sumEth = sumEth.add(amountEth);
        }
        
        basicIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);      // issue token
        
        return sumEth;
     }
    
    /**
     * Handles converting the contract's full WETH balance to the output
     * token or ether and transfers it to the msg sender.
     *
     * @param _isOutputETH      Converts the contract's WETH balance to ETH if set to true
     * @param _outputToken      The token to swap the contract's WETH balance to. 
     *                          Ignored if _isOutputETH is set to true.
     * @param _minOutputReceive Minimum amount of output token or ether to receive. This 
     *                          function reverts if the output is less than this. 
     * @return                  Amount of output ether or tokens sent to msg.sender
     */
    function _handleRedeemOutput(
        bool _isOutputETH,
        address _outputToken,
        uint256 _minOutputReceive
    )
        internal
        returns (uint256)
    {
        if(_isOutputETH) {
            IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
            uint256 outputAmount = address(this).balance;
            require(outputAmount > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            msg.sender.transfer(outputAmount);
            return outputAmount;
        } else if (_outputToken == WETH) {
            uint256 outputAmount = IERC20(WETH).balanceOf(address(this));
            require(outputAmount > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            IERC20(WETH).transfer(msg.sender, outputAmount);
            return outputAmount;
        } else {
            uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
            (uint amountTokenOut, Exchange exchange) = _getMaxTokenForExactToken(wethBalance, address(WETH), _outputToken);
            
            require(amountTokenOut > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            
            uint256 outputAmount = _swapExactTokensForTokens(exchange, WETH, _outputToken, wethBalance);
            IERC20(_outputToken).transfer(msg.sender, outputAmount);
            return outputAmount;
        }
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
            
            uint256 scaledAmountEth = amountEthIn[i].mul(wethBalance).div(sumEth);  // scale the amountEthIn
            
            uint256 amountTokenOut = _swapExactTokensForTokens(exchanges[i], WETH, positions[i].component, scaledAmountEth);

            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(uint256(positions[i].unit)), maxIndexAmount);   // update the maxIndexAmount
        }
        return maxIndexAmount;
    }

    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountIn     The amount of input token to be spent
     * 
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
     * 
     * @return              The amount of input tokens spent
     */
    function _swapTokensForExactTokens(Exchange _exchange, address _tokenIn, address _tokenOut, uint256 _amountOut) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;
        return _getRouter(_exchange).swapTokensForExactTokens(_amountOut, PreciseUnitMath.maxUint256(), path, address(this), block.timestamp)[0];
    }
 
    /**
     * Gets the amount of ether required for issuing each component in a set set token.
     * The amount of ether is calculated based on prices across both uniswap and sushiswap.
     * 
     * @param _setToken      Address of the set token
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
            (amountEthIn[i], exchanges[i]) = _getMinTokenForExactToken(uint256(positions[i].unit), WETH, positions[i].component);
            sumEth = sumEth.add(amountEthIn[i]);     // increment sum
        }
        return (amountEthIn, exchanges, sumEth);
    }
    
    /**
     * Gets the total ETH value of the given amount of set token
     *
     * @param _setToken Address of the set token
     * @param _amount   The amount of set token
     */
    function _getSumValue(ISetToken _setToken, uint256 _amount) internal view returns (uint256) {
        uint256 sumEth = 0;
        ISetToken.Position[] memory positions = _setToken.getPositions();

        for (uint256 i = 0; i < positions.length; i++) {
            uint256 amountComponent = uint256(positions[i].unit).mul(_amount).div(1 ether);
            (uint256 value,) = _getMaxTokenForExactToken(amountComponent, positions[i].component, WETH);
            sumEth = sumEth.add(value);
        }
        return sumEth;
    }

    /**
     * Compares the amount of token required for an exact amount of another token across both exchanges,
     * and returns the min amount.
     *
     * @param _amountOut    The amount of output token
     * @param _tokenA       The address of tokenA
     * @param _tokenB       The address of tokenB
     * 
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
     * 
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
     *
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