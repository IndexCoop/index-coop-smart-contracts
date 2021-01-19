pragma solidity >=0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../lib/PreciseUnitMath.sol";
import "../../external/contracts/UniswapV2Library.sol";
import "../../external/contracts/SushiswapV2Library.sol";
import "../interfaces/ISetToken.sol";
import "../interfaces/IBasicIssuanceModule.sol";
import "../interfaces/IWETH.sol";

import "hardhat/console.sol";

/**
 * @title ExchangeIssuance
 * @author Noah Citron
 *
 * Contract for minting and redeeming any Set token using
 * ETH as the paying/receiving currency. All swaps are done using the best price
 * found on Uniswap or Sushiswap.
 *
 */
contract ExchangeIssuance {

    using SafeMath for uint256;
    
    /* ============ State Variables ============ */

    IUniswapV2Router02 private uniRouter;
    address private uniFactory;
    IUniswapV2Router02 private sushiRouter;
    address private sushiFactory;

    IBasicIssuanceModule private basicIssuanceModule;
    address private WETH;

    /* ============ Events ============ */

    event ExchangeIssue(address indexed recipient, address indexed index, address indexed inputToken, uint256 amount);
    event ExchangeRedeem(address indexed recipient, address indexed index, address indexed outputToken, uint256 amount);

    /* ============ Constructor ============ */

    constructor(address _uniFactory, address _uniRouter, address _sushiFactory, address _sushiRouter, address _basicIssuanceModule) public {
        uniFactory = _uniFactory;
        uniRouter = IUniswapV2Router02(_uniRouter);

        sushiFactory = _sushiFactory;
        sushiRouter = IUniswapV2Router02(_sushiRouter);

        WETH = uniRouter.WETH();
        basicIssuanceModule = IBasicIssuanceModule(_basicIssuanceModule);
        IERC20(WETH).approve(address(uniRouter), PreciseUnitMath.maxUint256());
        IERC20(WETH).approve(address(sushiRouter), PreciseUnitMath.maxUint256());
    }

    /* ============ External Functions ============ */

    receive() external payable {}

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming an index. This function must only be called before the first time
     * this smart contract is used on any particular index, or when a new token is added
     * to the index.
     *
     * @param _index    Address of the index being initialized
     */
    function initApprovals(address _index) external {
        ISetToken.Position[] memory positions = ISetToken(_index).getPositions();
        for (uint256 i=0; i<positions.length; i++) {
            IERC20 token = IERC20(positions[i].component);
            token.approve(address(uniRouter), PreciseUnitMath.maxUint256());
            token.approve(address(sushiRouter), PreciseUnitMath.maxUint256());
            token.approve(address(basicIssuanceModule), PreciseUnitMath.maxUint256());
        }
    }

    /**
     * Redeems an Index and sells the underlying tokens using Uniswap
     * or Sushiswap.
     *
     * @param _index        Address of the index being redeemed
     * @param _amount       The amount of the index to redeem
     * @param _isOutputETH  Set to true if the output token is Ether
     * @param _outputToken  Address of output token. Ignored if _isOutputETH is true
     */
    function exchangeRedeem(address _index, uint256 _amount, bool _isOutputETH, address _outputToken) external {
        ISetToken setToken = ISetToken(_index);
        setToken.transferFrom(msg.sender, address(this), _amount);
        basicIssuanceModule.redeem(ISetToken(_index), _amount, address(this));
        liquidateSetPositions(_index);
        if(_isOutputETH) {
            msg.sender.transfer(address(this).balance);
        } else {
            purchaseTokenExactEther(_outputToken, address(this).balance);
        }
        emit ExchangeRedeem(msg.sender, _index, _isOutputETH ? address(0) : _outputToken, _amount);
    }

    /**
     * Issues an Index by using swapping for the underlying tokens on Uniswap
     * or Sushiswap. msg.value must be equal to the maximum price in ETH that you are
     * willing to pay. Excess ETH is refunded.
     *
     * @param _index        Address of the index being issued
     * @param _amount       Amount of the index to issue
     * @param _isInputETH   Set to true if the input token is Ether
     * @param _inputToken   Address of input token. Ignored if _isInputETH is true
     * @param _maxSpend     Max erc20 balance to spend on issuing. Ignored if _isInputETH 
     *                      is true as _maxSpend is then equal to msg.value
     */
    function exchangeIssue(address _index, uint256 _amount, bool _isInputETH, address _inputToken, uint256 _maxSpend) external payable {
        IERC20 inputToken = IERC20(_inputToken);
        if(!_isInputETH) {
            inputToken.transferFrom(msg.sender, address(this), _maxSpend);
            purchaseEtherExactTokens(_inputToken, inputToken.balanceOf(address(this)));
        }
        (address[] memory tokens, uint256[] memory tokenAmounts) = getTokensNeeded(_index, _amount);
        acquireTokensOfSet(tokens, tokenAmounts);
        basicIssuanceModule.issue(ISetToken(_index), _amount, msg.sender);
        if(_isInputETH) {
            msg.sender.transfer(address(this).balance);
        } else {
            purchaseTokenExactEther(_inputToken, address(this).balance);
            inputToken.transfer(msg.sender, inputToken.balanceOf(address(this)));
        }
        emit ExchangeIssue(msg.sender, _index, _isInputETH ? address(0) : _inputToken, _amount);
    }

    /* ============ Private Functions ============ */

    function liquidateSetPositions(address _index) private {
        ISetToken.Position[] memory positions = ISetToken(_index).getPositions();
        for (uint256 i=0; i<positions.length; i++) {
            sellTokenBestPrice(positions[i].component);
        }
    }

    function acquireTokensOfSet(address[] memory tokens, uint256[] memory tokenAmounts) private {
        IWETH(WETH).deposit{value: address(this).balance}();
        for (uint256 i=0; i<tokens.length; i++) {
            purchaseTokenBestPrice(tokens[i], tokenAmounts[i]);
        }
        IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
    }

    function purchaseToken(IUniswapV2Router02 _router, address _token, uint256 _amount) private {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;
        _router.swapTokensForExactTokens(_amount, PreciseUnitMath.maxUint256(), path, address(this), block.timestamp);
    }

    function purchaseTokenBestPrice(address _token, uint256 _amount) private {
        uint256 uniPrice = tokenAvailable(uniFactory, _token) ? getBuyPrice(true, _token, _amount) : PreciseUnitMath.maxUint256();
        uint256 sushiPrice = tokenAvailable(sushiFactory, _token) ? getBuyPrice(false, _token, _amount) : PreciseUnitMath.maxUint256();
        if (uniPrice <= sushiPrice) {
            purchaseToken(uniRouter, _token, _amount);
        } else {
            purchaseToken(sushiRouter, _token, _amount);
        }
    }

    function purchaseTokenExactEther(address _token, uint256 _amount) private {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;

        uint256 uniAmountOut = tokenAvailable(uniFactory, _token) ? uniRouter.getAmountsOut(_amount, path)[1] : 0;
        uint256 sushiAmountOut = tokenAvailable(sushiFactory, _token) ? sushiRouter.getAmountsOut(_amount, path)[1] : 0;
        IUniswapV2Router02 router = uniAmountOut >= sushiAmountOut ? uniRouter : sushiRouter;

        router.swapExactETHForTokens{value: _amount}(0, path, msg.sender, block.timestamp);
    }

    function sellToken(IUniswapV2Router02 _router, address _token) private {
        uint256 tokenBalance = IERC20(_token).balanceOf(address(this));
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;
        _router.swapExactTokensForETH(tokenBalance, 0, path, address(this), block.timestamp);
    }

    function sellTokenBestPrice(address _token) private {
        uint256 tokenBalance = IERC20(_token).balanceOf(address(this));
        uint256 uniPrice = tokenAvailable(uniFactory, _token) ? getSellPrice(true, _token, tokenBalance) : 0;
        uint256 sushiPrice = tokenAvailable(sushiFactory, _token) ? getSellPrice(false, _token, tokenBalance) : 0;
        if (uniPrice >= sushiPrice) {
            sellToken(uniRouter, _token);
        } else {
            sellToken(sushiRouter, _token);
        }
    }

    function purchaseEtherExactTokens(address _token, uint256 _amount) private {
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;

        uint256 uniAmountOut = tokenAvailable(uniFactory, _token) ? uniRouter.getAmountsOut(_amount, path)[1] : 0;
        uint256 sushiAmountOut = tokenAvailable(sushiFactory, _token) ? sushiRouter.getAmountsOut(_amount, path)[1] : 0;
        IUniswapV2Router02 router = uniAmountOut >= sushiAmountOut ? uniRouter : sushiRouter;

        IERC20(_token).approve(address(router), PreciseUnitMath.maxUint256());
        router.swapExactTokensForETH(_amount, 0, path, address(this), block.timestamp);
    }

    function getTokensNeeded(address _index, uint256 _amount) private view returns (address[] memory, uint256[] memory) {
        ISetToken.Position[] memory positions = ISetToken(_index).getPositions();
        uint256[] memory tokenAmounts = new uint256[](positions.length);
        address[] memory tokens = new address[](positions.length);
        for (uint256 i=0; i<positions.length; i++) {
            uint256 tokensNeeded =  PreciseUnitMath.preciseMulCeil(uint256(positions[i].unit), _amount);
            tokenAmounts[i] = tokensNeeded;
            tokens[i] = positions[i].component;
        }
        return (tokens, tokenAmounts);
    }

    function getBuyPrice(bool isUni, address _token, uint256 _amount) private view returns (uint256) {
        if (isUni) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            return uniRouter.getAmountIn(_amount, tokenReserveA, tokenReserveB);
        } else {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            return sushiRouter.getAmountIn(_amount, tokenReserveA, tokenReserveB);
        }
    }

    function getSellPrice(bool isUni, address _token, uint256 _amount) private view returns (uint256) {
        if (isUni) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            return uniRouter.getAmountOut(_amount, tokenReserveB, tokenReserveA);
        } else {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            return sushiRouter.getAmountOut(_amount, tokenReserveB, tokenReserveA);
        }
    }

    function tokenAvailable(address _factory, address _token) private view returns (bool) {
        return IUniswapV2Factory(_factory).getPair(WETH, _token) != address(0);
    }
}