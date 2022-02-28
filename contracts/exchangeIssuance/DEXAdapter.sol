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
import { IUniswapV2Router02 } from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ISwapRouter} from "../interfaces/external/ISwapRouter.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


/**
 * @title DEXAdapter
 * @author Index Coop
 *
 * Adapter to execute swaps on different DEXes
 *
 */
abstract contract DEXAdapter {
    using SafeERC20 for IERC20;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Constants ============= */
    uint256 constant private MAX_UINT256 = type(uint256).max;
    uint24 public constant POOL_FEE = 3000;

    /* ============ Enums ============ */
    enum Exchange { None, Quickswap, Sushiswap, UniV3}

    // Token to trade via 
    address immutable public INTERMEDIATE_TOKEN;
    IUniswapV2Router02 immutable public quickRouter;
    IUniswapV2Router02 immutable public sushiRouter;
    ISwapRouter immutable public uniV3Router;

    constructor(
        address _weth,
        address _intermediateToken,
        IUniswapV2Router02 _quickRouter,
        IUniswapV2Router02 _sushiRouter,
        ISwapRouter _uniV3Router
    )
        public
    {
        quickRouter = _quickRouter;
        sushiRouter = _sushiRouter;
        uniV3Router = _uniV3Router;

        IERC20(_weth).safeApprove(address(_quickRouter), PreciseUnitMath.maxUint256());
        IERC20(_weth).safeApprove(address(_sushiRouter), PreciseUnitMath.maxUint256());
        IERC20(_weth).safeApprove(address(_uniV3Router), PreciseUnitMath.maxUint256());

        INTERMEDIATE_TOKEN = _intermediateToken;
        if(_intermediateToken != _weth) {
            IERC20(_intermediateToken).safeApprove(address(_quickRouter), PreciseUnitMath.maxUint256());
            IERC20(_intermediateToken).safeApprove(address(_sushiRouter), PreciseUnitMath.maxUint256());
            IERC20(_intermediateToken).safeApprove(address(_uniV3Router), PreciseUnitMath.maxUint256());
        }
    }

    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _amountIn     The amount of input token to be spent
     *
     * @return amountOut    The amount of output tokens
     */
    function _swapExactTokensForTokens(
        Exchange _exchange,
        uint256 _amountIn,
        address[] memory _path,
        uint24[] memory _fees
    )
    internal
    returns (uint256)
    {
        if (_path[0] == _path[_path.length -1]) {
            return _amountIn;
        }

        if(_exchange == Exchange.UniV3){
            return _swapExactTokensForTokensUniV3(_path, _fees, _amountIn);
        } else {
            return _swapExactTokensForTokensUniV2(_path, _amountIn, _exchange);
        }
    }

    /**
     * Swap tokens for exact amount of output tokens on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     *
     * @return amountIn    The amount of input tokens spent
     */
    function _swapTokensForExactTokens(
        Exchange _exchange,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        address[] memory _path,
        uint24[] memory _fees

    )
    internal
    returns (uint256 amountIn)
    {
        if (_path[0] == _path[_path.length -1]) {
            return _amountOut;
        }
        if(_exchange == Exchange.UniV3){
            return _swapTokensForExactTokensUniV3(_path, _fees, _amountOut, _maxAmountIn);
        } else {
            return _swapTokensForExactTokensUniV2(_path, _amountOut, _maxAmountIn, _exchange);
        }
    }

    function _swapTokensForExactTokensUniV2(
        address[] memory _path,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        Exchange _exchange
    )
    internal
    returns(uint256)
    {
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(_path[0]), address(router), _maxAmountIn);
        return router.swapTokensForExactTokens(_amountOut, _maxAmountIn, _path, address(this), block.timestamp)[0];
    }

    function _swapTokensForExactTokensUniV3(
        address[] memory _path,
        uint24[] memory _fees,
        uint256 _amountOut,
        uint256 _maxAmountIn
    )
    internal
    returns(uint256)
    {

        require(_path.length == _fees.length + 1, "ExchangeIssuance: PATHS_FEES_MISMATCH");
        _safeApprove(IERC20(_path[0]), address(uniV3Router), _maxAmountIn);
        if(_path.length == 2){
            ISwapRouter.ExactOutputSingleParams memory params =
                ISwapRouter.ExactOutputSingleParams({
                    tokenIn: _path[0],
                    tokenOut: _path[1],
                    fee: _fees[0],
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountOut: _amountOut,
                    amountInMaximum: _maxAmountIn,
                    sqrtPriceLimitX96: 0
                });

            // Executes the swap returning the amountIn needed to spend to receive the desired amountOut.
            return uniV3Router.exactOutputSingle(params);
        } else {
            bytes memory pathV3 = _encodePathV3(_path, _fees);
            ISwapRouter.ExactOutputParams memory params =
                ISwapRouter.ExactOutputParams({
                    path: pathV3,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountOut: _amountOut,
                    amountInMaximum: _maxAmountIn
                });
            return uniV3Router.exactOutput(params);
        }
    }

    function _swapExactTokensForTokensUniV3(
        address[] memory _path,
        uint24[] memory _fees,
        uint256 _amountIn
    )
    internal
    returns(uint256)
    {
        require(_path.length == _fees.length + 1, "ExchangeIssuance: PATHS_FEES_MISMATCH");
        _safeApprove(IERC20(_path[0]), address(uniV3Router), _amountIn);
        if(_fees.length == 2){
            ISwapRouter.ExactInputSingleParams memory params =
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: _path[0],
                    tokenOut: _path[1],
                    fee: _fees[0],
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: _amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                });
            return uniV3Router.exactInputSingle(params);
        } else {
            bytes memory pathV3 = _encodePathV3(_path, _fees);
            ISwapRouter.ExactInputParams memory params =
                ISwapRouter.ExactInputParams({
                    path: pathV3,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: _amountIn,
                    amountOutMinimum: 0
                });
            return uniV3Router.exactInput(params);
        }
    }

    function _swapExactTokensForTokensUniV2(
        address[] memory _path,
        uint256 _amountIn,
        Exchange _exchange
    )
    internal
    returns(uint256)
    {
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(_path[0]), address(router), _amountIn);
        //TODO: Review if we have to set a non-zero minAmountOut
        return router.swapExactTokensForTokens(_amountIn, 0, _path, address(this), block.timestamp)[1];
    }


    function _encodePathV3(address[] memory _path, uint24[] memory _fees) internal view returns (bytes memory path) {
        path = abi.encodePacked(_path[0]);
        for(uint i = 0; i < _fees.length; i++){
            path = abi.encodePacked(path, _fees[i], _path[i+1]);
        }
    }

    /**
     * Returns the router address of a given exchange.
     *
     * @param _exchange     The Exchange whose router address is needed
     *
     * @return              IUniswapV2Router02 router of the given exchange
     */
     function _getRouter(Exchange _exchange) internal view returns(IUniswapV2Router02) {
         return (_exchange == Exchange.Quickswap) ? quickRouter : sushiRouter;
     }

    /**
     * Sets a max approval limit for an ERC20 token, provided the current allowance
     * is less than the required allownce.
     *
     * @param _token              Token to approve
     * @param _spender            Spender address to approve
     * @param _requiredAllowance  Target allowance to set
     */
    function _safeApprove(IERC20 _token, address _spender, uint256 _requiredAllowance) internal {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < _requiredAllowance) {
            _token.safeIncreaseAllowance(_spender, MAX_UINT256 - allowance);
        }
    }

}
