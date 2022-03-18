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

import { ICurveCalculator } from "../interfaces/external/ICurveCalculator.sol";
import { ICurveAddressProvider } from "../interfaces/external/ICurveAddressProvider.sol";
import { ICurvePoolRegistry } from "../interfaces/external/ICurvePoolRegistry.sol";
import { ICurvePool } from "../interfaces/external/ICurvePool.sol";
import { ISwapRouter} from "../interfaces/external/ISwapRouter.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

import "hardhat/console.sol";




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
    uint256 public constant CURVE_REGISTRY_EXCHANGE_ID = 2;
    address public constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ Enums ============ */

    enum Exchange { None, Quickswap, Sushiswap, UniV3, Curve }

    /* ============ Structs ============ */

    struct SwapData {
        address[] path;
        uint24[] fees;
        address pool;
    }


    struct CurvePoolData {
        int128 nCoins;
        uint256[8] balances;
        uint256 A;
        uint256 fee;
        uint256[8] rates;
        uint256[8] decimals;
    }

    /* ============ State Variables ============ */

    IUniswapV2Router02 immutable public quickRouter;
    IUniswapV2Router02 immutable public sushiRouter;
    ISwapRouter immutable public uniV3Router;
    ICurveAddressProvider immutable public curveAddressProvider;
    ICurveCalculator immutable public curveCalculator;

    /**
    * Sets various contract addresses and approves wrapped native token to the routers
    * 
    * @param _weth                  Address of wrapped native token
    * @param _quickRouter           Address of quickswap router
    * @param _sushiRouter           Address of sushiswap router
    * @param _uniV3Router           Address of uniswap v3 router
    * @param _curveAddressProvider  Contract to get current implementation address of curve registry
    * @param _curveCalculator       Contract to calculate required input to receive given output in curve (for exact output swaps)
    */
    constructor(
        address _weth,
        IUniswapV2Router02 _quickRouter,
        IUniswapV2Router02 _sushiRouter,
        ISwapRouter _uniV3Router,
        ICurveAddressProvider _curveAddressProvider,
        ICurveCalculator _curveCalculator
    )
        public
    {
        quickRouter = _quickRouter;
        sushiRouter = _sushiRouter;
        uniV3Router = _uniV3Router;
        curveAddressProvider = _curveAddressProvider;
        curveCalculator = _curveCalculator;

        IERC20(_weth).safeApprove(address(_quickRouter), PreciseUnitMath.maxUint256());
        IERC20(_weth).safeApprove(address(_sushiRouter), PreciseUnitMath.maxUint256());
        IERC20(_weth).safeApprove(address(_uniV3Router), PreciseUnitMath.maxUint256());
    }

    /* ============ Internal Methods ============ */
    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     * @param _swapData     Swap data containing the path and fee levels (latter only used for uniV3)
     *
     * @return amountOut    The amount of output tokens
     */
    function _swapExactTokensForTokens(
        Exchange _exchange,
        uint256 _amountIn,
        uint256 _minAmountOut,
        SwapData memory _swapData
    )
        internal
        returns (uint256)
    {
        if (_swapData.path[0] == _swapData.path[_swapData.path.length -1]) {
            return _amountIn;
        }

        if(_exchange == Exchange.Curve){
            return _swapExactTokensForTokensCurve(_swapData.path, _swapData.pool, _amountIn, _minAmountOut);
        }
        if(_exchange == Exchange.UniV3){
            return _swapExactTokensForTokensUniV3(_swapData.path, _swapData.fees, _amountIn, _minAmountOut);
        } else {
            return _swapExactTokensForTokensUniV2(_swapData.path, _amountIn, _minAmountOut, _exchange);
        }
    }

    /**
     * Swap tokens for exact amount of output tokens on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     * @param _swapData     Swap data containing the path and fee levels (latter only used for uniV3)
     *
     * @return amountIn     The amount of input tokens spent
     */
    function _swapTokensForExactTokens(
        Exchange _exchange,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        SwapData memory _swapData
    )
        internal
        returns (uint256 amountIn)
    {
        if (_swapData.path[0] == _swapData.path[_swapData.path.length -1]) {
            return _amountOut;
        }
        if(_exchange == Exchange.Curve){
            return _swapTokensForExactTokensCurve(_swapData.path, _swapData.pool, _amountOut, _maxAmountIn);
        }
        if(_exchange == Exchange.UniV3){
            return _swapTokensForExactTokensUniV3(_swapData.path, _swapData.fees, _amountOut, _maxAmountIn);
        } else {
            return _swapTokensForExactTokensUniV2(_swapData.path, _amountOut, _maxAmountIn, _exchange);
        }
    }

    /**
     * Returns the router address of a given exchange.
     *
     * @param _exchange     The Exchange whose router address is needed
     *
     * @return              IUniswapV2Router02 router of the given exchange
     */
     function _getRouter(
         Exchange _exchange
     )
        internal
        view
        returns (IUniswapV2Router02)
     {
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
    function _safeApprove(
        IERC20 _token,
        address _spender,
        uint256 _requiredAllowance
    )
        internal
    {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < _requiredAllowance) {
            _token.safeIncreaseAllowance(_spender, MAX_UINT256 - allowance);
        }
    }

    /* ============ Private Methods ============ */

    /**
     *  Execute exact output swap via a UniV2 based DEX. (such as sushiswap);
     *
     * @param _path         List of token address to swap via. 
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     * @param _exchange     The exchange on which to peform the swap
     *
     * @return amountIn    The amount of input tokens spent
     */
    function _swapTokensForExactTokensUniV2(
        address[] memory _path,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        Exchange _exchange
    )
        private
        returns (uint256)
    {
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(_path[0]), address(router), _maxAmountIn);
        return router.swapTokensForExactTokens(_amountOut, _maxAmountIn, _path, address(this), block.timestamp)[0];
    }

    /**
     *  Execute exact output swap via UniswapV3
     *
     * @param _path         List of token address to swap via. (In the order as expected by uniV2, the first element being the input toen)
     * @param _fees         List of fee levels identifying the pools to swap via. (_fees[0] refers to pool between _path[0] and _path[1])
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     *
     * @return amountIn    The amount of input tokens spent
     */
    function _swapTokensForExactTokensUniV3(
        address[] memory _path,
        uint24[] memory _fees,
        uint256 _amountOut,
        uint256 _maxAmountIn
    )
        private
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
            return uniV3Router.exactOutputSingle(params);
        } else {
            bytes memory pathV3 = _encodePathV3(_path, _fees, true);
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

    /**
     *  Execute exact input swap via Curve
     *
     * @param _path         Path (has to be of length 2)
     * @param _pool         Address of curve pool to use
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapExactTokensForTokensCurve(
        address[] memory _path,
        address _pool,
        uint256 _amountIn,
        uint256 _minAmountOut
    )
        public
        returns (uint256)
    {
        require(_path.length == 2, "ExchangeIssuance: CURVE_WRONG_PATH_LENGTH");
        (int128 i, int128 j) = _getCoinIndices(_pool, _path[0], _path[1]);
        return _exchangeCurve(i, j, _pool, _amountIn, _minAmountOut, _path[0]);
    }

    /**
     *  Execute exact output swap via Curve
     *
     * @param _path         Path (has to be of length 2)
     * @param _pool         Address of curve pool to use
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapTokensForExactTokensCurve(
        address[] memory _path,
        address _pool,
        uint256 _amountOut,
        uint256 _maxAmountIn
    )
        public
        returns (uint256)
    {
        require(_path.length == 2, "ExchangeIssuance: CURVE_WRONG_PATH_LENGTH");
        (int128 i, int128 j) = _getCoinIndices(_pool, _path[0], _path[1]);

        uint256 amountIn = _getAmountInCurve(_pool, i, j, _amountOut);
        require(amountIn <= _maxAmountIn, "ExchangeIssuance: CURVE_OVERSPENT");

        uint256 returnedAmountOut = _exchangeCurve(i, j, _pool, amountIn, _amountOut, _path[0]);
        require(_amountOut <= returnedAmountOut, "ExchangeIssuance: CURVE_UNDERBOUGHT");

        return amountIn;
    }
    
    function _exchangeCurve(
        int128 _i,
        int128 _j,
        address _pool,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _from
    )
        private
        returns (uint256 amountOut)
    {
        console.log("Exchange curve entered");
        ICurvePool pool = ICurvePool(_pool);
        if(_from == ETH_ADDRESS){
            console.log("Input token is ETH");
            amountOut = pool.exchange{value: _amountIn}(
                _i,
                _j,
                _amountIn,
                _minAmountOut
            );
        }
        else {
            console.log("Input token is ERC20");
            console.log("Approving input token");
            console.logAddress(_from);
            IERC20(_from).approve(_pool, _amountIn);
            console.log("Swapping");
            amountOut = pool.exchange(
                _i,
                _j,
                _amountIn,
                _minAmountOut
            );
            console.log("Swapped");
        }
    }


    function _getAmountInCurve(
        address _pool,
        int128 _i,
        int128 _j,
        uint256 _amountOut
    )
        public
        view
        returns (uint256)
    {
        CurvePoolData memory poolData = _getCurvePoolData(_pool, _i, _j);

        return curveCalculator.get_dx(
            poolData.nCoins,
            poolData.balances,
            poolData.A,
            poolData.fee,
            poolData.rates,
            poolData.decimals,
            // TODO: Review correct value for "underlying" parameter
            false,
            _i,
            _j,
            _amountOut
        );
    }

    function _getCurvePoolData(
        address _pool,
        int128 _i,
        int128 _j
    ) private view returns(CurvePoolData memory)
    {
        ICurvePoolRegistry registry = ICurvePoolRegistry(curveAddressProvider.get_registry());

        return CurvePoolData(
            int128(registry.get_n_coins(_pool)[0]),
            registry.get_balances(_pool),
            registry.get_A(_pool),
            registry.get_fees(_pool)[0],
            registry.get_rates(_pool),
            registry.get_decimals(_pool)
        );
    }
    
    function _getCoinIndices(
        address _pool,
        address _from,
        address _to
    )
    public view returns (int128 i, int128 j)
    {
        ICurvePoolRegistry registry = ICurvePoolRegistry(curveAddressProvider.get_registry());

        // Set to out of range index to signal the coin is not found yet
        i = 9;
        j = 9;
        address[8] memory poolCoins = registry.get_coins(_pool);

        for(uint256 k = 0; k < 8; k++){
            if(poolCoins[k] == _from){
                i = int128(k);
            }
            else if(poolCoins[k] == _to){
                j = int128(k);
            }
            // ZeroAddress signals end of list
            if(poolCoins[k] == address(0) || (i != 9 && j != 9)){
                break;
            }
        }

        require(i != 9, "ExchangeIssuance: CURVE_FROM_NOT_FOUND");
        require(j != 9, "ExchangeIssuance: CURVE_TO_NOT_FOUND");

        return (i, j);
    }



    /**
     *  Execute exact input swap via UniswapV3
     *
     * @param _path         List of token address to swap via. 
     * @param _fees         List of fee levels identifying the pools to swap via. (_fees[0] refers to pool between _path[0] and _path[1])
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapExactTokensForTokensUniV3(
        address[] memory _path,
        uint24[] memory _fees,
        uint256 _amountIn,
        uint256 _minAmountOut
    )
        private
        returns (uint256)
    {
        require(_path.length == _fees.length + 1, "ExchangeIssuance: PATHS_FEES_MISMATCH");
        _safeApprove(IERC20(_path[0]), address(uniV3Router), _amountIn);
        if(_path.length == 2){
            ISwapRouter.ExactInputSingleParams memory params =
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: _path[0],
                    tokenOut: _path[1],
                    fee: _fees[0],
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: _amountIn,
                    amountOutMinimum: _minAmountOut,
                    sqrtPriceLimitX96: 0
                });
            return uniV3Router.exactInputSingle(params);
        } else {
            bytes memory pathV3 = _encodePathV3(_path, _fees, false);
            ISwapRouter.ExactInputParams memory params =
                ISwapRouter.ExactInputParams({
                    path: pathV3,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: _amountIn,
                    amountOutMinimum: _minAmountOut
                });
            uint amountOut = uniV3Router.exactInput(params);
            return amountOut;
        }
    }

    /**
     *  Execute exact input swap via UniswapV2
     *
     * @param _path         List of token address to swap via. 
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     * @param _exchange     The exchange to swap on (must be uniV2 based / compatible)
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapExactTokensForTokensUniV2(
        address[] memory _path,
        uint256 _amountIn,
        uint256 _minAmountOut,
        Exchange _exchange
    )
        private
        returns (uint256)
    {
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(_path[0]), address(router), _amountIn);
        return router.swapExactTokensForTokens(_amountIn, _minAmountOut, _path, address(this), block.timestamp)[1];
    }


    /**
     * Encode path / fees to bytes in the format expected by UniV3 router
     *
     * @param _path          List of token address to swap via (starting with input token)
     * @param _fees          List of fee levels identifying the pools to swap via. (_fees[0] refers to pool between _path[0] and _path[1])
     * @param _reverseOrder  Boolean indicating if path needs to be reversed to start with output token. (which is the case for exact output swap)
     *
     * @return encodedPath   Encoded path to be forwared to uniV3 router
     */
    function _encodePathV3(
        address[] memory _path,
        uint24[] memory _fees,
        bool _reverseOrder
    )
        private
        pure
        returns(bytes memory encodedPath)
    {
        if(_reverseOrder){
            encodedPath = abi.encodePacked(_path[_path.length-1]);
            for(uint i = 0; i < _fees.length; i++){
                uint index = _fees.length - i - 1;
                encodedPath = abi.encodePacked(encodedPath, _fees[index], _path[index]);
            }
        } else {
            encodedPath = abi.encodePacked(_path[0]);
            for(uint i = 0; i < _fees.length; i++){
                encodedPath = abi.encodePacked(encodedPath, _fees[i], _path[i+1]);
            }
        }
    }

}
