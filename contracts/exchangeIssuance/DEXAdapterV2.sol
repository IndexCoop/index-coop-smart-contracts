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
import { ISwapRouter02 } from "../interfaces/external/ISwapRouter02.sol";
import { IQuoter } from "../interfaces/IQuoter.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


/**
 * @title DEXAdapterV2
 * @author Index Coop
 *
 * Same as DEXAdapter but without automatic WETH deposit / withdraw
 */
library DEXAdapterV2 {
    using SafeERC20 for IERC20;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;

    /* ============ Constants ============= */

    uint256 constant private MAX_UINT256 = type(uint256).max;
    address public constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint256 public constant ROUNDING_ERROR_MARGIN = 2;

    /* ============ Enums ============ */

    enum Exchange { None, Quickswap, Sushiswap, UniV3, Curve }

    /* ============ Structs ============ */

    struct Addresses {
        address quickRouter;
        address sushiRouter;
        address uniV3Router;
        address uniV3Quoter;
        address curveAddressProvider;
        address curveCalculator;
        // Wrapped native token (WMATIC on polygon)
        address weth;
    }

    struct SwapData {
        address[] path;
        uint24[] fees;
        address pool;
        Exchange exchange;
    }

    struct CurvePoolData {
        int128 nCoins;
        uint256[8] balances;
        uint256 A;
        uint256 fee;
        uint256[8] rates;
        uint256[8] decimals;
    }

    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _addresses    Struct containing relevant smart contract addresses.
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     * @param _swapData     Swap data containing the path and fee levels (latter only used for uniV3)
     *
     * @return amountOut    The amount of output tokens
     */
    function swapExactTokensForTokens(
        Addresses memory _addresses,
        uint256 _amountIn,
        uint256 _minAmountOut,
        SwapData memory _swapData
    )
        external
        returns (uint256)
    {
        if (_swapData.path.length == 0 || _swapData.path[0] == _swapData.path[_swapData.path.length -1]) {
            return _amountIn;
        }

        if(_swapData.exchange == Exchange.Curve){
            return _swapExactTokensForTokensCurve(
                _swapData.path,
                _swapData.pool,
                _amountIn,
                _minAmountOut,
                _addresses
            );
        }
        if(_swapData.exchange== Exchange.UniV3){
            return _swapExactTokensForTokensUniV3(
                _swapData.path,
                _swapData.fees,
                _amountIn,
                _minAmountOut,
                ISwapRouter02(_addresses.uniV3Router)
            );
        } else {
            return _swapExactTokensForTokensUniV2(
                _swapData.path,
                _amountIn,
                _minAmountOut,
                _getRouter(_swapData.exchange, _addresses)
            );
        }
    }


    /**
     * Swap tokens for exact amount of output tokens on a given DEX.
     *
     * @param _addresses    Struct containing relevant smart contract addresses.
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     * @param _swapData     Swap data containing the path and fee levels (latter only used for uniV3)
     *
     * @return amountIn     The amount of input tokens spent
     */
    function swapTokensForExactTokens(
        Addresses memory _addresses,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        SwapData memory _swapData
    )
        external
        returns (uint256 amountIn)
    {
        if (_swapData.path.length == 0 || _swapData.path[0] == _swapData.path[_swapData.path.length -1]) {
            return _amountOut;
        }

        if(_swapData.exchange == Exchange.Curve){
            return _swapTokensForExactTokensCurve(
                _swapData.path,
                _swapData.pool,
                _amountOut,
                _maxAmountIn,
                _addresses
            );
        }
        if(_swapData.exchange == Exchange.UniV3){
            return _swapTokensForExactTokensUniV3(
                _swapData.path,
                _swapData.fees,
                _amountOut,
                _maxAmountIn,
                ISwapRouter02(_addresses.uniV3Router)
            );
        } else {
            return _swapTokensForExactTokensUniV2(
                _swapData.path,
                _amountOut,
                _maxAmountIn,
                _getRouter(_swapData.exchange, _addresses)
            );
        }
    }

    /**
     * Gets the output amount of a token swap.
     *
     * @param _swapData     the swap parameters
     * @param _addresses    Struct containing relevant smart contract addresses.
     * @param _amountIn     the input amount of the trade
     *
     * @return              the output amount of the swap
     */
    function getAmountOut(
        Addresses memory _addresses,
        SwapData memory _swapData,
        uint256 _amountIn
    )
        external
        returns (uint256)
    {
        if (_swapData.path.length == 0 || _swapData.path[0] == _swapData.path[_swapData.path.length-1]) {
            return _amountIn;
        }

        if (_swapData.exchange == Exchange.UniV3) {
            return _getAmountOutUniV3(_swapData, _addresses.uniV3Quoter, _amountIn);
        } else if (_swapData.exchange == Exchange.Curve) {
            (int128 i, int128 j) = _getCoinIndices(
                _swapData.pool,
                _swapData.path[0],
                _swapData.path[1],
                ICurveAddressProvider(_addresses.curveAddressProvider)
            );
            return _getAmountOutCurve(_swapData.pool, i, j, _amountIn, _addresses);
        } else {
            return _getAmountOutUniV2(
                _swapData,
                _getRouter(_swapData.exchange, _addresses),
                _amountIn
            );
        }
    }
    
    /**
     * Gets the input amount of a fixed output swap.
     *
     * @param _swapData     the swap parameters
     * @param _addresses    Struct containing relevant smart contract addresses.
     * @param _amountOut    the output amount of the swap
     *
     * @return              the input amount of the swap
     */
    function getAmountIn(
        Addresses memory _addresses,
        SwapData memory _swapData,
        uint256 _amountOut
    )
        external
        returns (uint256)
    {
        if (_swapData.path.length == 0 || _swapData.path[0] == _swapData.path[_swapData.path.length-1]) {
            return _amountOut;
        }

        if (_swapData.exchange == Exchange.UniV3) {
            return _getAmountInUniV3(_swapData, _addresses.uniV3Quoter, _amountOut);
        } else if (_swapData.exchange == Exchange.Curve) {
            (int128 i, int128 j) = _getCoinIndices(
                _swapData.pool,
                _swapData.path[0],
                _swapData.path[1],
                ICurveAddressProvider(_addresses.curveAddressProvider)
            );
            return _getAmountInCurve(_swapData.pool, i, j, _amountOut, _addresses);
        } else {
            return _getAmountInUniV2(
                _swapData,
                _getRouter(_swapData.exchange, _addresses),
                _amountOut
            );
        }
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
     * @param _router       Address of the uniV2 router to use
     *
     * @return amountIn    The amount of input tokens spent
     */
    function _swapTokensForExactTokensUniV2(
        address[] memory _path,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        IUniswapV2Router02 _router
    )
        private
        returns (uint256)
    {
        _safeApprove(IERC20(_path[0]), address(_router), _maxAmountIn);
        return _router.swapTokensForExactTokens(_amountOut, _maxAmountIn, _path, address(this), block.timestamp)[0];
    }

    /**
     *  Execute exact output swap via UniswapV3
     *
     * @param _path         List of token address to swap via. (In the order as
     *                      expected by uniV2, the first element being the input toen)
     * @param _fees         List of fee levels identifying the pools to swap via.
     *                      (_fees[0] refers to pool between _path[0] and _path[1])
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     * @param _uniV3Router  Address of the uniswapV3 router
     *
     * @return amountIn    The amount of input tokens spent
     */
    function _swapTokensForExactTokensUniV3(
        address[] memory _path,
        uint24[] memory _fees,
        uint256 _amountOut,
        uint256 _maxAmountIn,
        ISwapRouter02 _uniV3Router
    )
        private
        returns(uint256)
    {

        require(_path.length == _fees.length + 1, "ExchangeIssuance: PATHS_FEES_MISMATCH");
        _safeApprove(IERC20(_path[0]), address(_uniV3Router), _maxAmountIn);
        if(_path.length == 2){
            ISwapRouter02.ExactOutputSingleParams memory params =
                ISwapRouter02.ExactOutputSingleParams({
                    tokenIn: _path[0],
                    tokenOut: _path[1],
                    fee: _fees[0],
                    recipient: address(this),
                    amountOut: _amountOut,
                    amountInMaximum: _maxAmountIn,
                    sqrtPriceLimitX96: 0
                });
            return _uniV3Router.exactOutputSingle(params);
        } else {
            bytes memory pathV3 = _encodePathV3(_path, _fees, true);
            ISwapRouter02.ExactOutputParams memory params =
                ISwapRouter02.ExactOutputParams({
                    path: pathV3,
                    recipient: address(this),
                    amountOut: _amountOut,
                    amountInMaximum: _maxAmountIn
                });
            return _uniV3Router.exactOutput(params);
        }
    }

    /**
     *  Execute exact input swap via Curve
     *
     * @param _path         Path (has to be of length 2)
     * @param _pool         Address of curve pool to use
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     * @param _addresses    Struct containing relevant smart contract addresses.
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapExactTokensForTokensCurve(
        address[] memory _path,
        address _pool,
        uint256 _amountIn,
        uint256 _minAmountOut,
        Addresses memory _addresses
    )
        private
        returns (uint256 amountOut)
    {
        require(_path.length == 2, "ExchangeIssuance: CURVE_WRONG_PATH_LENGTH");
        (int128 i, int128 j) = _getCoinIndices(_pool, _path[0], _path[1], ICurveAddressProvider(_addresses.curveAddressProvider));

        amountOut = _exchangeCurve(i, j, _pool, _amountIn, _minAmountOut, _path[0]);

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
        uint256 _maxAmountIn,
        Addresses memory _addresses
    )
        private
        returns (uint256)
    {
        require(_path.length == 2, "ExchangeIssuance: CURVE_WRONG_PATH_LENGTH");
        (int128 i, int128 j) = _getCoinIndices(_pool, _path[0], _path[1], ICurveAddressProvider(_addresses.curveAddressProvider));


        uint256 returnedAmountOut = _exchangeCurve(i, j, _pool, _maxAmountIn, _amountOut, _path[0]);
        require(_amountOut <= returnedAmountOut, "ExchangeIssuance: CURVE_UNDERBOUGHT");

        uint256 swappedBackAmountIn;
        if(returnedAmountOut > _amountOut){
            swappedBackAmountIn = _exchangeCurve(j, i, _pool, returnedAmountOut.sub(_amountOut), 0, _path[1]);
        }

        return _maxAmountIn.sub(swappedBackAmountIn);
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
        ICurvePool pool = ICurvePool(_pool);
        if(_from == ETH_ADDRESS){
            amountOut = pool.exchange{value: _amountIn}(
                _i,
                _j,
                _amountIn,
                _minAmountOut
            );
        }
        else {
            IERC20(_from).approve(_pool, _amountIn);
            amountOut = pool.exchange(
                _i,
                _j,
                _amountIn,
                _minAmountOut
            );
        }
    }

    /**
     *  Calculate required input amount to get a given output amount via Curve swap
     *
     * @param _i            Index of input token as per the ordering of the pools tokens
     * @param _j            Index of output token as per the ordering of the pools tokens
     * @param _pool         Address of curve pool to use
     * @param _amountOut    The amount of output token to be received
     * @param _addresses    Struct containing relevant smart contract addresses.
     *
     * @return amountOut    The amount of output token obtained
     */
    function _getAmountInCurve(
        address _pool,
        int128 _i,
        int128 _j,
        uint256 _amountOut,
        Addresses memory _addresses
    )
        private
        view
        returns (uint256)
    {
        CurvePoolData memory poolData = _getCurvePoolData(_pool, ICurveAddressProvider(_addresses.curveAddressProvider));

        return ICurveCalculator(_addresses.curveCalculator).get_dx(
            poolData.nCoins,
            poolData.balances,
            poolData.A,
            poolData.fee,
            poolData.rates,
            poolData.decimals,
            false,
            _i,
            _j,
            _amountOut
        ) + ROUNDING_ERROR_MARGIN;
    }

    /**
     *  Calculate output amount of a Curve swap
     *
     * @param _i            Index of input token as per the ordering of the pools tokens
     * @param _j            Index of output token as per the ordering of the pools tokens
     * @param _pool         Address of curve pool to use
     * @param _amountIn     The amount of output token to be received
     * @param _addresses    Struct containing relevant smart contract addresses.
     *
     * @return amountOut    The amount of output token obtained
     */
    function _getAmountOutCurve(
        address _pool,
        int128 _i,
        int128 _j,
        uint256 _amountIn,
        Addresses memory _addresses
    )
        private
        view
        returns (uint256)
    {
        return ICurvePool(_pool).get_dy(_i, _j, _amountIn);
    }

    /**
     *  Get metadata on curve pool required to calculate input amount from output amount
     *
     * @param _pool                    Address of curve pool to use
     * @param _curveAddressProvider    Address of curve address provider
     *
     * @return Struct containing all required data to perform getAmountInCurve calculation
     */
    function _getCurvePoolData(
        address _pool,
        ICurveAddressProvider _curveAddressProvider
    ) private view returns(CurvePoolData memory)
    {
        ICurvePoolRegistry registry = ICurvePoolRegistry(_curveAddressProvider.get_registry());

        return CurvePoolData(
            int128(registry.get_n_coins(_pool)[0]),
            registry.get_balances(_pool),
            registry.get_A(_pool),
            registry.get_fees(_pool)[0],
            registry.get_rates(_pool),
            registry.get_decimals(_pool)
        );
    }
    
    /**
     *  Get token indices for given pool
     *  NOTE: This was necessary sine the get_coin_indices function of the CurvePoolRegistry did not work for StEth/ETH pool
     *
     * @param _pool                    Address of curve pool to use
     * @param _from                    Address of input token
     * @param _to                      Address of output token
     * @param _curveAddressProvider    Address of curve address provider
     *
     * @return i Index of input token
     * @return j Index of output token
     */
    function _getCoinIndices(
        address _pool,
        address _from,
        address _to,
        ICurveAddressProvider _curveAddressProvider
    )
        private
        view
        returns (int128 i, int128 j)
    {
        ICurvePoolRegistry registry = ICurvePoolRegistry(_curveAddressProvider.get_registry());

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
     * @param _fees         List of fee levels identifying the pools to swap via.
     *                      (_fees[0] refers to pool between _path[0] and _path[1])
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     * @param _uniV3Router  Address of the uniswapV3 router
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapExactTokensForTokensUniV3(
        address[] memory _path,
        uint24[] memory _fees,
        uint256 _amountIn,
        uint256 _minAmountOut,
        ISwapRouter02 _uniV3Router
    )
        private
        returns (uint256)
    {
        require(_path.length == _fees.length + 1, "ExchangeIssuance: PATHS_FEES_MISMATCH");
        _safeApprove(IERC20(_path[0]), address(_uniV3Router), _amountIn);
        if(_path.length == 2){
            ISwapRouter02.ExactInputSingleParams memory params =
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: _path[0],
                    tokenOut: _path[1],
                    fee: _fees[0],
                    recipient: address(this),
                    amountIn: _amountIn,
                    amountOutMinimum: _minAmountOut,
                    sqrtPriceLimitX96: 0
                });
            return _uniV3Router.exactInputSingle(params);
        } else {
            bytes memory pathV3 = _encodePathV3(_path, _fees, false);
            ISwapRouter02.ExactInputParams memory params =
                ISwapRouter02.ExactInputParams({
                    path: pathV3,
                    recipient: address(this),
                    amountIn: _amountIn,
                    amountOutMinimum: _minAmountOut
                });
            uint amountOut = _uniV3Router.exactInput(params);
            return amountOut;
        }
    }

    /**
     *  Execute exact input swap via UniswapV2
     *
     * @param _path         List of token address to swap via. 
     * @param _amountIn     The amount of input token to be spent
     * @param _minAmountOut Minimum amount of output token to receive
     * @param _router       Address of uniV2 router to use
     *
     * @return amountOut    The amount of output token obtained
     */
    function _swapExactTokensForTokensUniV2(
        address[] memory _path,
        uint256 _amountIn,
        uint256 _minAmountOut,
        IUniswapV2Router02 _router
    )
        private
        returns (uint256)
    {
        _safeApprove(IERC20(_path[0]), address(_router), _amountIn);
        // NOTE: The following was changed from always returning result at position [1] to returning the last element of the result array
        // With this change, the actual output is correctly returned also for multi-hop swaps
        // See https://github.com/IndexCoop/index-coop-smart-contracts/pull/116 
        uint256[] memory result = _router.swapExactTokensForTokens(_amountIn, _minAmountOut, _path, address(this), block.timestamp);
        // result = uint[] memory	The input token amount and all subsequent output token amounts.
        // we are usually only interested in the actual amount of the output token (so result element at the last place)
        return result[result.length-1];
    }

    /**
     * Gets the output amount of a token swap on Uniswap V2
     *
     * @param _swapData     the swap parameters
     * @param _router       the uniswap v2 router address
     * @param _amountIn     the input amount of the trade
     *
     * @return              the output amount of the swap
     */
    function _getAmountOutUniV2(
        SwapData memory _swapData,
        IUniswapV2Router02 _router,
        uint256 _amountIn
    )
        private
        view
        returns (uint256)
    {
        return _router.getAmountsOut(_amountIn, _swapData.path)[_swapData.path.length-1];
    }

    /**
     * Gets the input amount of a fixed output swap on Uniswap V2.
     *
     * @param _swapData     the swap parameters
     * @param _router       the uniswap v2 router address
     * @param _amountOut    the output amount of the swap
     *
     * @return              the input amount of the swap
     */
    function _getAmountInUniV2(
        SwapData memory _swapData,
        IUniswapV2Router02 _router,
        uint256 _amountOut
    )
        private
        view
        returns (uint256)
    {
        return _router.getAmountsIn(_amountOut, _swapData.path)[0];
    }

    /**
     * Gets the output amount of a token swap on Uniswap V3.
     *
     * @param _swapData     the swap parameters
     * @param _quoter       the uniswap v3 quoter
     * @param _amountIn     the input amount of the trade
     *
     * @return              the output amount of the swap
     */

    function _getAmountOutUniV3(
        SwapData memory _swapData,
        address _quoter,
        uint256 _amountIn
    )
        private
        returns (uint256)
    {
        bytes memory path = _encodePathV3(_swapData.path, _swapData.fees, false);
        return IQuoter(_quoter).quoteExactInput(path, _amountIn);
    }

    /**
     * Gets the input amount of a fixed output swap on Uniswap V3.
     *
     * @param _swapData     the swap parameters
     * @param _quoter       uniswap v3 quoter
     * @param _amountOut    the output amount of the swap
     *
     * @return              the input amount of the swap
     */
    function _getAmountInUniV3(
        SwapData memory _swapData,
        address _quoter,
        uint256 _amountOut
    )
        private
        returns (uint256)
    {
        bytes memory path = _encodePathV3(_swapData.path, _swapData.fees, true);
        return IQuoter(_quoter).quoteExactOutput(path, _amountOut);
    }

    /**
     * Encode path / fees to bytes in the format expected by UniV3 router
     *
     * @param _path          List of token address to swap via (starting with input token)
     * @param _fees          List of fee levels identifying the pools to swap via.
     *                       (_fees[0] refers to pool between _path[0] and _path[1])
     * @param _reverseOrder  Boolean indicating if path needs to be reversed to start with output token.
     *                       (which is the case for exact output swap)
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

    function _getRouter(
        Exchange _exchange,
        Addresses memory _addresses
    )
        private
        pure
        returns (IUniswapV2Router02)
    {
        return IUniswapV2Router02(
            (_exchange == Exchange.Quickswap) ? _addresses.quickRouter : _addresses.sushiRouter
        );
    }
}
