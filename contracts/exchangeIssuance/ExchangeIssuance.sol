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

    using SafeMath for uint256;
    
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
        uint256 _amountSetToken
    );
    event ExchangeRedeem(
        address indexed _recipient,
        address indexed _setToken,
        address indexed _outputToken,
        uint256 _amountSetToken,
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
     * Issues an set token by swapping for the underlying tokens on Uniswap
     * or Sushiswap.
     *
     * @param _setToken         Address of the set token being issued
     * @param _amountInput      Amount of the input token / ether to spend
     * @param _isInputETH       Set to true if the input token is Ether
     * @param _inputToken       Address of input token. Ignored if _isInputETH is true
     * @param _minSetReceive    Minimum amount of index to receive
     */
    function exchangeIssue(
        ISetToken _setToken,
        uint256 _amountInput,
        bool _isInputETH,
        IERC20 _inputToken,
        uint256 _minSetReceive
    )
        external
        payable
        nonReentrant
    {
        _handleIssueInput(_isInputETH, _inputToken, _amountInput);

        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        
        uint256 minSetTokenAmountOut = _getMaxAmountOutForExactETH(address(_setToken), wethBalance);    // get best price of set token
        
        //get approximate costs
        ISetToken.Position[] memory positions = _setToken.getPositions();
        (uint256[] memory amountEthIn, uint256 sumEth) = _getApproximateIssueCosts(positions, minSetTokenAmountOut);

        uint256 maxIndexAmount = _acquireComponents(positions, amountEthIn, wethBalance, sumEth);
        require(maxIndexAmount > _minSetReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        basicIssuanceModule.issue(_setToken, maxIndexAmount, msg.sender);
        emit ExchangeIssue(msg.sender, address(_setToken), _isInputETH ? address(0) : address(_inputToken), maxIndexAmount);
    }

    /**
     * Redeems a set token and sells the underlying tokens using Uniswap
     * or Sushiswap.
     *
     * @param _setToken             Address of the set token being redeemed
     * @param _amountSetToRedeem    The amount of the set token to redeem
     * @param _isOutputETH          Set to true if the output token is Ether
     * @param _outputToken          Address of output token. Ignored if _isOutputETH is true
     * @param _minOutputReceive     Minimum amount of output token / ether to receive
     */
    function exchangeRedeem(
        ISetToken _setToken,
        uint256 _amountSetToRedeem,
        bool _isOutputETH,
        address _outputToken,
        uint256 _minOutputReceive
    )
        external
        nonReentrant
    {
        _setToken.transferFrom(msg.sender, address(this), _amountSetToRedeem);
        basicIssuanceModule.redeem(_setToken, _amountSetToRedeem, address(this));
        _liquidateComponents(_setToken);
        uint256 outputAmount = _handleRedeemOutput(_isOutputETH, _outputToken, _minOutputReceive);
        emit ExchangeRedeem(msg.sender, address(_setToken), _isOutputETH ? address(0) : _outputToken, _amountSetToRedeem, outputAmount);
    }

    receive() external payable {}

    /**
     * Returns an estimated quantity of the specified SetToken given an input amount of ETH or a specified ERC20 receieved when issuing.
     * Estimating pulls the best price of each component using Uniswap or Sushiswap
     *
     * @param _setToken         Address of the set token being issued
     * @param _amountInput      Amount of the input token to spend
     * @param _isInputETH       Set to true if the input token is Ether
     * @param _inputToken       Address of input token. Ignored if _isInputETH is true
     * @return                  Estimated amount of Set tokens that will be received
     */
    function getEstimatedIssueSetQuantity(
        ISetToken _setToken,
        uint256 _amountInput,
        bool _isInputETH,
        IERC20 _inputToken
    )
        external
        view
        returns (uint256)
    {
        uint256 amountEth;
        if(!_isInputETH && address(_inputToken) != WETH) {
            uint256 uniAmount = _tokenAvailable(uniFactory, address(_inputToken)) ? _getSellPrice(true, address(_inputToken), _amountInput) : 0;
            uint256 sushiAmount = _tokenAvailable(sushiFactory, address(_inputToken)) ? _getSellPrice(false, address(_inputToken), _amountInput) : 0; 
            amountEth = Math.max(uniAmount, sushiAmount);
        } else {
            amountEth = _amountInput;
        }

        uint256 minSetTokenAmountOut = _getMaxAmountOutForExactETH(address(_setToken), amountEth);  // get best price of set token

        uint256 sumEth = 0;
        ISetToken.Position[] memory positions = _setToken.getPositions();
        uint256[] memory amountEthIn = new uint256[](positions.length);
        for(uint256 i = 0; i < positions.length; i++) {
            uint256 unit = uint256(positions[i].unit);
            address token = positions[i].component;
            uint256 amountOut = minSetTokenAmountOut.mul(unit).div(1 ether);
            uint256 uniPrice = _tokenAvailable(uniFactory, token) ? _getBuyPrice(true, token, amountOut) : PreciseUnitMath.maxUint256();
            uint256 sushiPrice = _tokenAvailable(sushiFactory, token) ? _getBuyPrice(false, token, amountOut) : PreciseUnitMath.maxUint256();
            uint256 amountEth = Math.min(uniPrice, sushiPrice);
            sumEth = sumEth.add(amountEth);
            amountEthIn[i] = amountEth;
        }

        uint256 maxIndexAmount = PreciseUnitMath.maxUint256();
        for (uint i = 0; i < positions.length; i++) {
            address token = positions[i].component;
            uint256 unit = uint256(positions[i].unit);

            uint256 scaledAmountEth = amountEthIn[i].mul(amountEth).div(sumEth);  // scale the amountEthIn
            
            uint256 amountTokenOut = _getMaxAmountOutForExactETH(token, scaledAmountEth);
            
            // update the maxIndexAmount
            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(unit), maxIndexAmount);
        }
        return maxIndexAmount;
    }

    /**
     * Returns an estimated quantity of ETH or specified ERC20 received for a given SetToken and SetToken quantity. 
     * Estimation pulls the best price of each component from Uniswap or Sushiswap.
     *
     * @param _setToken             Set token redeemed
     * @param _amountSetToRedeem    Amount of set token
     * @param _isOutputETH          Set to true if the output token is Ether
     * @param _outputToken          Address of output token. Ignored if _isOutputETH is true
     * @return                      Estimated amount of ether/erc20 that will be received
     */
    function getEstimatedRedeemSetQuantity(
        ISetToken _setToken,
        uint256 _amountSetToRedeem,
        bool _isOutputETH,
        address _outputToken
    ) 
        external
        view
        returns (uint256)
    {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        uint256 totalEth = 0;
        for (uint256 i = 0; i < positions.length; i++) {
            address token = positions[i].component;
            uint256 amount = uint256(positions[i].unit).mul(_amountSetToRedeem).div(1 ether);
            uint256 uniAmount = _tokenAvailable(uniFactory, token) ? _getSellPrice(true, positions[i].component, amount) : 0;
            uint256 sushiAmount = _tokenAvailable(sushiFactory, token) ? _getSellPrice(false, positions[i].component, amount) : 0;
            totalEth = totalEth.add(Math.max(uniAmount, sushiAmount));
        }
        if(_isOutputETH || _outputToken == WETH) {
            return totalEth;
        }
        
        return _getMaxAmountOutForExactETH(_outputToken, totalEth);
    }

    /* ============ Internal Functions ============ */

    /**
     * Sells the total balance that the contract holds of each component of the set
     * using the best quoted price from either Uniswap or Sushiswap
     * 
     * @param _setToken     The set token that is being liquidated
     */
    function _liquidateComponents(ISetToken _setToken) internal {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for (uint256 i = 0; i < positions.length; i++) {
            _sellTokenBestPrice(positions[i].component);
        }
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
            uint256 outputAmount = _purchaseTokenBestPrice(_outputToken, IERC20(WETH).balanceOf(address(this)));
            require(outputAmount > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            IERC20(_outputToken).transfer(msg.sender, outputAmount);
            return outputAmount;
        }
    }

    /**
     * Handles converting the input token or ether into WETH.
     *
     * @param _isInputETH   Set to true if the input is ETH
     * @param _inputToken   The input token. Ignored if _isInputETH is true
     * @param _amountInput  The amount of the input to convert to WETH
     */
    function _handleIssueInput(bool _isInputETH, IERC20 _inputToken, uint256 _amountInput) internal {
        if(_isInputETH) {
            require(msg.value == _amountInput, "ExchangeIssuance: INCORRECT_INPUT_AMOUNT");
            IWETH(WETH).deposit{value: msg.value}();    // ETH -> WETH
        } else if(address(_inputToken) != WETH) {
            _inputToken.transferFrom(msg.sender, address(this), _amountInput);
            _purchaseWETHExactTokens(address(_inputToken), _amountInput);    // _inputToken -> WETH
        } else {
            _inputToken.transferFrom(msg.sender, address(this), _amountInput);  // already WETH
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
        uint256 wethBalance,
        uint256 sumEth
    ) 
        internal
        returns (uint256)
    {
        uint256 maxIndexAmount = PreciseUnitMath.maxUint256();
        for (uint i = 0; i < positions.length; i++) {
            address token = positions[i].component;
            uint256 unit = uint256(positions[i].unit);

            address[] memory path = new address[](2);
            path[0] = WETH;
            path[1] = token;
            uint256 scaledAmountEth = amountEthIn[i].mul(wethBalance).div(sumEth);  // scale the amountEthIn
            uint256 amountTokenOut = _purchaseTokenBestPrice(token, scaledAmountEth);
            // update the maxIndexAmount
            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(unit), maxIndexAmount);
        }
        return maxIndexAmount;
    }

    /**
     * Purchases a token using an exact WETH amount
     *
     * @param _router   The router to use when purchasing (can be either uniRouter or sushiRouter)
     * @param _token    The address of the token to purchase
     * @param _amount   The amount of WETH to spend on the purchase
     * 
     * @return          The amount of the token purchased
     */
    function _purchaseToken(IUniswapV2Router02 _router, address _token, uint256 _amount) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;
        uint256 amountOut = _router.swapExactTokensForTokens(_amount, 0, path, address(this), block.timestamp)[1];
        return amountOut;
    }
 
    /**
     * Purchases a token with a given amount of WETH using the DEX with the best price
     *
     * @param _token    The address of the token to purchase
     * @param _amount   The amount of WETH to spend on the purchase
     *
     * @return          The amount of the token purchased
     */
    function _purchaseTokenBestPrice(address _token, uint256 _amount) internal returns (uint256) {
        uint256 uniPrice = _tokenAvailable(uniFactory, _token) ? _getBuyPrice(true, _token, _amount) : PreciseUnitMath.maxUint256();
        uint256 sushiPrice = _tokenAvailable(sushiFactory, _token) ? _getBuyPrice(false, _token, _amount) : PreciseUnitMath.maxUint256();
        if (uniPrice <= sushiPrice) {
            return _purchaseToken(uniRouter, _token, _amount);
        } else {
            return _purchaseToken(sushiRouter, _token, _amount);
        }
    }

    /**
     * Sells the contracts entire balance of the specified token
     *
     * @param _router   The router to use when purchasing (can be either uniRouter or sushiRouter)
     * @param _token    The address of the token to sell
     */
    function _sellToken(IUniswapV2Router02 _router, address _token) internal {
        uint256 tokenBalance = IERC20(_token).balanceOf(address(this));
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;
        _router.swapExactTokensForTokens(tokenBalance, 0, path, address(this), block.timestamp);
    }

    /**
     * Sells a contracts full balance of a token using the DEX with the best price
     *
     * @param _token    The address of the token to sell
     *
     */
    function _sellTokenBestPrice(address _token) internal {
        uint256 tokenBalance = IERC20(_token).balanceOf(address(this));
        uint256 uniPrice = _tokenAvailable(uniFactory, _token) ? _getSellPrice(true, _token, tokenBalance) : 0;
        uint256 sushiPrice = _tokenAvailable(sushiFactory, _token) ? _getSellPrice(false, _token, tokenBalance) : 0;
        if (uniPrice >= sushiPrice) {
            _sellToken(uniRouter, _token);
        } else {
            _sellToken(sushiRouter, _token);
        }
    }

    /**
     * Purchases Ether given an exact amount of a token to spend
     *
     * @param _token    Token to spend
     * @param _amount   Amount of token to spend
     */
    function _purchaseWETHExactTokens(address _token, uint256 _amount) internal {
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;

        uint256 uniAmountOut = _tokenAvailable(uniFactory, _token) ? uniRouter.getAmountsOut(_amount, path)[1] : 0;
        uint256 sushiAmountOut = _tokenAvailable(sushiFactory, _token) ? sushiRouter.getAmountsOut(_amount, path)[1] : 0;
        IUniswapV2Router02 router = uniAmountOut >= sushiAmountOut ? uniRouter : sushiRouter;

        IERC20(_token).approve(address(router), PreciseUnitMath.maxUint256());
        router.swapExactTokensForTokens(_amount, 0, path, address(this), block.timestamp);
    }

    /**
     * Gets the approximate costs for issuing a token.
     * 
     * @param _positions             An array of the SetToken's components
     * @param _minSetTokenAmountOut  The minimum (but close to the actual value) amount of set tokens
     * 
     * @return                      An array representing the approximate Ether cost to purchase each component of the set
     * @return                      The approximate total ETH cost to issue the set
     */
    function _getApproximateIssueCosts(
        ISetToken.Position[] memory _positions,
        uint256 _minSetTokenAmountOut
    ) 
        internal
        view
        returns (uint256[] memory, uint256)
    {
        uint256 sumEth = 0;
        uint256[] memory amountEthIn = new uint256[](_positions.length);
        for(uint256 i = 0; i < _positions.length; i++) {
            uint256 unit = uint256(_positions[i].unit);
            address token = _positions[i].component;
            uint256 amountOut = _minSetTokenAmountOut.mul(unit).div(1 ether);
            uint256 uniPrice = _tokenAvailable(uniFactory, token) ? _getBuyPrice(true, token, amountOut) : PreciseUnitMath.maxUint256();
            uint256 sushiPrice = _tokenAvailable(sushiFactory, token) ? _getBuyPrice(false, token, amountOut) : PreciseUnitMath.maxUint256();
            uint256 amountEth = Math.min(uniPrice, sushiPrice);
            sumEth = sumEth.add(amountEth);
            amountEthIn[i] = amountEth;
        }
        return (amountEthIn, sumEth);
    }

    /**
     * Gets the pruchase price in WETH of a token given the requested output amount
     *
     * @param _isUni        Specifies whether to fetch the Uniswap or Sushiswap price
     * @param _token        The address of the token to get the buy price of
     * @param _amountOut    Output token amount
     *
     * @return          The purchase price in WETH
     */
    function _getBuyPrice(bool _isUni, address _token, uint256 _amountOut) internal view returns (uint256) {
        address factory = _isUni ? uniFactory : sushiFactory;
        IUniswapV2Router02 router = _isUni ? uniRouter : sushiRouter;
        (uint256 tokenReserveA, uint256 tokenReserveB) = _isUni ? 
             UniswapV2Library.getReserves(factory, WETH, _token) : SushiswapV2Library.getReserves(sushiFactory, WETH, _token);

        uint256 amountEth = router.getAmountIn({
            amountOut : _amountOut,
            reserveIn : tokenReserveA,
            reserveOut : tokenReserveB   
        });
        return amountEth;
    }
    
    /**
     * Compares the amount of token received for an exact amount of Ether across both exchanges,
     * and returns the max amount.
     *
     * @param _token        The address of output token
     * @param _amountETHIn  The amount of input ETH
     * 
     * @return              The max amount of tokens that can be received across both exchanges
     */
    function _getMaxAmountOutForExactETH(address _token, uint256 _amountETHIn) internal view returns (uint256) {
        
        uint256 uniTokenOut = 0;
        uint256 sushiTokenOut = 0;
        
        if(_tokenAvailable(uniFactory, _token)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            uniTokenOut = UniswapV2Library.getAmountOut(_amountETHIn, tokenReserveA, tokenReserveB);
        }
        
        if(_tokenAvailable(sushiFactory, _token)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            sushiTokenOut = SushiswapV2Library.getAmountOut(_amountETHIn, tokenReserveA, tokenReserveB);
        }

        return Math.max(uniTokenOut, sushiTokenOut);
    }
    
    /**
     * Gets the sell price of a token given an exact amount of tokens to spend
     *
     * @param _isUni    Specifies whether to fetch the Uniswap or Sushiswap price
     * @param _token    The address of the input token
     * @param _amount   The input amount of _token
     *
     * @return          The amount of WETH that would be received for this swap
     */
    function _getSellPrice(bool _isUni, address _token, uint256 _amount) internal view returns (uint256) {
        if (_isUni) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            return uniRouter.getAmountOut(_amount, tokenReserveB, tokenReserveA);
        } else {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            return sushiRouter.getAmountOut(_amount, tokenReserveB, tokenReserveA);
        }
    }

    /**
     * Checks if a token is available on the given DEX
     *
     * @param _factory  The factory to use (can be either uniFactory or sushiFactory)
     * @param _token    The address of the token
     *
     * @return          A boolean representing if the token is available
     */
    function _tokenAvailable(address _factory, address _token) internal view returns (bool) {
        return IUniswapV2Factory(_factory).getPair(WETH, _token) != address(0);
    }
}