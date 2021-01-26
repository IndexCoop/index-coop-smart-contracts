pragma solidity >=0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../lib/PreciseUnitMath.sol";
import "../../external/contracts/UniswapV2Library.sol";
import "../../external/contracts/SushiswapV2Library.sol";
import "../interfaces/ISetToken.sol";
import "../interfaces/IBasicIssuanceModule.sol";
import "../interfaces/IWETH.sol";

/**
 * @title ExchangeIssuance
 * @author Noah Citron
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

    event ExchangeIssue(address indexed recipient, address indexed setToken, address indexed inputToken, uint256 amountSetToken);
    event ExchangeRedeem(address indexed recipient, address indexed setToken, address indexed outputToken, uint256 amountSetToken);

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

    /* ============ External Functions ============ */

    receive() external payable {}

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a set token. This function only need to be called before the first time
     * this smart contract is used on any particular set token, or when a new token is added
     * to the set token during a rebalance.
     *
     * @param _setToken    Address of the set token being initialized
     */
    function initApprovals(ISetToken _setToken) external {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        for (uint256 i=0; i<positions.length; i++) {
            IERC20 token = IERC20(positions[i].component);
            token.approve(address(uniRouter), MAX_UINT96);
            token.approve(address(sushiRouter), MAX_UINT96);
            token.approve(address(basicIssuanceModule), MAX_UINT96);
        }
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
    function exchangeRedeem(ISetToken _setToken, uint256 _amountSetToRedeem, bool _isOutputETH, address _outputToken, uint256 _minOutputReceive) external nonReentrant {
        _setToken.transferFrom(msg.sender, address(this), _amountSetToRedeem);
        basicIssuanceModule.redeem(_setToken, _amountSetToRedeem, address(this));
        _liquidateComponents(_setToken);
        _handleRedeemOutput(_isOutputETH, _outputToken, _minOutputReceive);
        emit ExchangeRedeem(msg.sender, address(_setToken), _isOutputETH ? address(0) : _outputToken, _amountSetToRedeem);
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
    function exchangeIssue(ISetToken _setToken, uint256 _amountInput, bool _isInputETH, IERC20 _inputToken, uint256 _minSetReceive) external payable nonReentrant {
        _handleIssueInput(_isInputETH, _inputToken, _amountInput);

        // get price of set token on uniswap
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, address(_setToken));
        uint256 minSetTokenAmountOut = uniRouter.getAmountOut(wethBalance, tokenReserveA, tokenReserveB);

        //get approximate costs
        ISetToken.Position[] memory positions = _setToken.getPositions();
        (uint256[] memory amountEthIn, uint256 sumEth) = _getApproximateCosts(positions, minSetTokenAmountOut);

        uint256 maxIndexAmount = _acquireComponents(positions, amountEthIn, wethBalance, sumEth);
        require(maxIndexAmount > _minSetReceive, "INSUFFICIENT_OUTPUT_AMOUNT");
        basicIssuanceModule.issue(_setToken, maxIndexAmount, msg.sender);
        emit ExchangeIssue(msg.sender, address(_setToken), _isInputETH ? address(0) : address(_inputToken), maxIndexAmount);
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
    function getEstimatedRedeemSetQuantity(ISetToken _setToken, uint256 _amountSetToRedeem, bool _isOutputETH, address _outputToken) external view returns (uint256) {
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
        uint256 uniAmount = _tokenAvailable(uniFactory, _outputToken) ? _getBuyPriceExactETH(true, _outputToken, totalEth) : 0;
        uint256 sushiAmount = _tokenAvailable(sushiFactory, _outputToken) ? _getBuyPriceExactETH(false, _outputToken, totalEth) : 0;
        return Math.max(uniAmount, sushiAmount);
    }

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
    function getEstimatedIssueSetQuantity(ISetToken _setToken, uint256 _amountInput, bool _isInputETH, IERC20 _inputToken) external view returns (uint256) {
        uint256 amountEth;
        if(!_isInputETH && address(_inputToken) != WETH) {
            uint256 uniAmount = _tokenAvailable(uniFactory, address(_inputToken)) ? _getSellPrice(true, address(_inputToken), _amountInput) : 0;
            uint256 sushiAmount = _tokenAvailable(sushiFactory, address(_inputToken)) ? _getSellPrice(false, address(_inputToken), _amountInput) : 0; 
            amountEth = Math.max(uniAmount, sushiAmount);
        } else {
            amountEth = _amountInput;
        }

        // get price of set token on uniswap
        uint256 wethBalance = amountEth;
        (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, address(_setToken));
        uint256 minSetTokenAmountOut = uniRouter.getAmountOut(wethBalance, tokenReserveA, tokenReserveB);

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

            uint256 scaledAmountEth = amountEthIn[i].mul(wethBalance).div(sumEth);  // scale the amountEthIn
            uint256 uniTokenOut = _tokenAvailable(uniFactory, token) ? _getBuyPriceExactETH(true, token, scaledAmountEth) : 0;
            uint256 sushiTokenOut = _tokenAvailable(sushiFactory, token) ? _getBuyPriceExactETH(false, token, scaledAmountEth) : 0;

            uint256 amountTokenOut = Math.max(uniTokenOut, sushiTokenOut);
            // update the maxIndexAmount
            maxIndexAmount = Math.min(amountTokenOut.mul(1 ether).div(unit), maxIndexAmount);
        }
        return maxIndexAmount;
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
        for (uint256 i=0; i<positions.length; i++) {
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
     */
    function _handleRedeemOutput(bool _isOutputETH, address _outputToken, uint256 _minOutputReceive) internal {
        if(_isOutputETH) {
            IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
            require(address(this).balance > _minOutputReceive, "INSUFFICIENT_OUTPUT_AMOUNT");
            msg.sender.transfer(address(this).balance);
        } else if (_outputToken == WETH) {
            require(IERC20(WETH).balanceOf(address(this)) > _minOutputReceive, "INSUFFICIENT_OUTPUT_AMOUNT");
            IERC20(WETH).transfer(msg.sender, IERC20(WETH).balanceOf(address(this)));
        } else {
            uint256 outputAmount = _purchaseTokenBestPrice(_outputToken, IERC20(WETH).balanceOf(address(this)));
            require(outputAmount > _minOutputReceive, "INSUFFICIENT_OUTPUT_AMOUNT");
            IERC20(_outputToken).transfer(msg.sender, outputAmount);
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
            require(msg.value == _amountInput, "INCORRECT_INPUT_AMOUNT");
            IWETH(WETH).deposit{value: msg.value}();    // ETH -> WETH
        } else if(address(_inputToken) != WETH) {
            _inputToken.transferFrom(msg.sender, address(this), _amountInput);
            _purchaseWETHExactTokens(address(_inputToken), _amountInput);    // _inputToken -> WETH
        }
    }

    /**
     * Gets the approximate costs for issuing a token.
     * 
     * @param positions             An array of the SetToken's components
     * @param minSetTokenAmountOut  The minimum (but close to the actual value) amount of set tokens
     * 
     * @return                      An array representing the approximate Ether cost to purchase each component of the set
     * @return                      The approximate total ETH cost to issue the set
     */
    function _getApproximateCosts(ISetToken.Position[] memory positions, uint256 minSetTokenAmountOut) internal returns (uint256[] memory, uint256) {
        uint256 sumEth = 0;
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
        return (amountEthIn, sumEth);
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
    function _acquireComponents(ISetToken.Position[] memory positions, uint256[] memory amountEthIn, uint256 wethBalance, uint256 sumEth) internal returns (uint256) {
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
     * Gets the pruchase price in WETH of a token given the requested output amount
     *
     * @param _isUni    Specifies whether to fetch the Uniswap or Sushiswap price
     * @param _token    The address of the token to get the buy price of
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
     * Gets the amount of _token that will be received given an exact _amountETHIn
     *
     * @param _isUni        Specifies whether to fetch the Uniswap or Sushiswap price
     * @param _token        The address of the token to get the buy price of
     * @param _amountETHIn  The exact input ETH balance for the swap
     * 
     * @return              The amount of tokens that can be received
     */
    function _getBuyPriceExactETH(bool _isUni, address _token, uint256 _amountETHIn) internal view returns (uint256) {
        address factory = _isUni ? uniFactory : sushiFactory;
        IUniswapV2Router02 router = _isUni ? uniRouter : sushiRouter;
        (uint256 tokenReserveA, uint256 tokenReserveB) = _isUni ? 
             UniswapV2Library.getReserves(factory, WETH, _token) : SushiswapV2Library.getReserves(sushiFactory, WETH, _token);

        uint256 amountEth = router.getAmountOut({
            amountIn : _amountETHIn,
            reserveIn : tokenReserveA,
            reserveOut : tokenReserveB   
        });
        return amountEth;
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