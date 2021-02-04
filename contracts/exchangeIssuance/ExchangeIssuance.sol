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
     * @param _amountInput      Amount of the input token / ether to spend
     * @param _inputToken       Address of input token
     * @param _minSetReceive    Minimum amount of set tokens to receive
     */
    function issueSetForExactToken(
        ISetToken _setToken,
        uint256 _amountInput,
        IERC20 _inputToken,
        uint256 _minSetReceive
    )
        external
        nonReentrant
    {   
        _inputToken.transferFrom(msg.sender, address(this), _amountInput);
        
        if(address(_inputToken) != WETH) {      // swap inputToken to WETH
            (, Exchange exchange) = _getMaxTokenForExactToken(_amountInput, address(_inputToken), WETH);
            IERC20(_inputToken).approve(address(_getRouter(exchange)), _amountInput);
            _sellToken(exchange, address(_inputToken), _amountInput);       
        }
            
        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive);     // issue set token
        
        emit ExchangeIssue(msg.sender, address(_setToken), address(_inputToken), _amountInput, setTokenAmount);
        
    }
    
    /**
     * Issues set tokens for an exact amount of input ether. 
     * Acquires set token components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the set tokens.
     * 
     * @param _setToken         Address of the set token being issued
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
        if(!_isInputETH && address(_inputToken) != WETH)
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
            uint256 amount = uint256(positions[i].unit).mul(_amountSetToRedeem).div(1 ether);
            (uint256 amountEth, ) = _getMaxTokenForExactToken(amount, positions[i].component, WETH);
            totalEth = totalEth.add(amountEth);
        }
        if(_isOutputETH || _outputToken == WETH) {
            return totalEth;
        }
        
        (uint256 setTokenAmount, ) = _getMaxTokenForExactToken(totalEth, WETH, _outputToken);
        return setTokenAmount;
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
            address token = positions[i].component;
            uint256 tokenBalance = IERC20(token).balanceOf(address(this));
            (, Exchange exchange) = _getMaxTokenForExactToken(tokenBalance, token, WETH);
            _sellToken(exchange, token, tokenBalance);
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

        uint256 setTokenAmount = _acquireComponents(positions, amountEthIn, exchanges, wethBalance, sumEth);   // acquire set token components
        
        require(setTokenAmount > _minSetReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        
        basicIssuanceModule.issue(_setToken, setTokenAmount, msg.sender);                            // issue token
        
        return setTokenAmount;
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
            
            uint256 outputAmount = _purchaseToken(exchange, _outputToken, wethBalance);
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
            
            uint256 amountTokenOut = _purchaseToken(exchanges[i], positions[i].component, scaledAmountEth);

            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(uint256(positions[i].unit)), maxIndexAmount);   // update the maxIndexAmount
        }
        return maxIndexAmount;
    }

    /**
     * Purchases a token using an exact WETH amount
     *
     * @param _exchange     The exchange on which to purchase the token.
     * @param _token        The address of the token to purchase
     * @param _amount       The amount of WETH to spend on the purchase
     * 
     * @return              The amount of the token purchased
     */
    function _purchaseToken(Exchange _exchange, address _token, uint256 _amount) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;
        return _getRouter(_exchange).swapExactTokensForTokens(_amount, 0, path, address(this), block.timestamp)[1];
    }
 
    /**
     * Sells a specified amount of token on a specified exchagne for Ether.
     * Note: You need to approve the token which is being sold, before calling this function.
     *
     * @param _exchange     The exchange on which to sell the token.
     * @param _token        The address of the token to sell
     * @param _amount       The amount of token to sell
     * 
     * @return              The amount of the WETH received
     */
    function _sellToken(Exchange _exchange, address _token, uint256 _amount) internal returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;
        return _getRouter(_exchange).swapExactTokensForTokens(_amount, 0, path, address(this), block.timestamp)[1];
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
            (amountEthIn[i], exchanges[i]) = _getMinETHForExactToken(positions[i].component, uint256(positions[i].unit));
            sumEth = sumEth.add(amountEthIn[i]);     // increment sum
        }
        return (amountEthIn, exchanges, sumEth);
    }
    
    /**
     * Compares the amount of token received for an exact amount of Ether across both exchanges,
     * and returns the max amount.
     *
     * @param _token            The address of output token
     * @param _amountTokenOut   The amount of output token
     * 
     * @return              The min amount of ether required across both exchanges
     * @return              The Exchange on which minimum amount of ether is required
     */
    function _getMinETHForExactToken(address _token, uint256 _amountTokenOut) internal view returns (uint256, Exchange) {
        
        uint256 uniEthIn = PreciseUnitMath.maxUint256();
        uint256 sushiEthIn = PreciseUnitMath.maxUint256();
        
        if(_pairAvailable(uniFactory, _token, WETH)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            uniEthIn = UniswapV2Library.getAmountIn(_amountTokenOut, tokenReserveA, tokenReserveB);
        }
        
        if(_pairAvailable(sushiFactory, _token, WETH)) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            sushiEthIn = SushiswapV2Library.getAmountIn(_amountTokenOut, tokenReserveA, tokenReserveB);
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