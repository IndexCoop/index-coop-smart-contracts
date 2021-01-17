pragma solidity >=0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "../lib/UniswapV2Library.sol";
import "../lib/SushiswapV2Library.sol";
import "../interfaces/ISetToken.sol";
import "../interfaces/IBasicIssuanceModule.sol";
import "../interfaces/IWETH.sol";

contract IssueRedeem {

    using SafeMath for uint256;
    
    IUniswapV2Router02 private uniRouter;
    address private uniFactory;
    IUniswapV2Router02 private sushiRouter;
    address private sushiFactory;

    IBasicIssuanceModule private basicIssuanceModule;
    address constant private WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant private MAX_INT = 2**256 - 1;

    constructor() public {
        uniFactory = address(0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f);
        uniRouter = IUniswapV2Router02(address(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D));

        sushiFactory = address(0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac);
        sushiRouter = IUniswapV2Router02(address(0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F));

        basicIssuanceModule = IBasicIssuanceModule(address(0xd8EF3cACe8b4907117a45B0b125c68560532F94D));
        IERC20(WETH).approve(address(uniRouter), MAX_INT);
        IERC20(WETH).approve(address(sushiRouter), MAX_INT);
    }

    //must be run before the contract issues/redeems an index for the first time
    function initApprovals(address _index) public {
        ISetToken.Position[] memory positions = ISetToken(_index).getPositions();
        for(uint256 i=0; i<positions.length; i++) {
            IERC20 token = IERC20(positions[i].component);
            token.approve(address(uniRouter), MAX_INT);
            token.approve(address(sushiRouter), MAX_INT);
            token.approve(address(basicIssuanceModule), MAX_INT);
        }
    }

    function redeem(address _index, uint256 _amount) public {
        ISetToken setToken = ISetToken(_index);
        setToken.transferFrom(msg.sender, address(this), _amount);
        basicIssuanceModule.redeem(ISetToken(_index), _amount, address(this));
        liquidateSetPositions(_index);
    }

    function liquidateSetPositions(address _index) private {
        ISetToken.Position[] memory positions = ISetToken(_index).getPositions();
        for(uint256 i=0; i<positions.length; i++) {
            sellTokenBestPrice(positions[i].component);
        }
    }

    function issue(address _index, uint256 _amount) public payable {
        ISetToken.Position[] memory positions = ISetToken(_index).getPositions();
        uint256[] memory tokenAmounts = new uint256[](positions.length);
        address[] memory tokens = new address[](positions.length);
        {
            for(uint256 i=0; i<positions.length; i++) {
                uint256 tokensNeeded =  preciseMulCeil(uint256(positions[i].unit), _amount);
                tokenAmounts[i] = tokensNeeded;
                tokens[i] = positions[i].component;
            }
        }
        acquireTokensOfSet(tokens, tokenAmounts);
        basicIssuanceModule.issue(ISetToken(_index), _amount, msg.sender);
        msg.sender.send(address(this).balance);
    }

    function acquireTokensOfSet(address[] memory tokens, uint256[] memory tokenAmounts) private {
        IWETH(WETH).deposit{value: address(this).balance}();
        for(uint256 i=0; i<tokens.length; i++) {
            purchaseTokenBestPrice(tokens[i], tokenAmounts[i]);
        }
        IWETH(WETH).withdraw(IERC20(WETH).balanceOf(address(this)));
    }

    function getBuyPrice(bool isUni, address _token, uint256 _amount) private returns (uint256) {
        if(isUni) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            return uniRouter.getAmountIn(_amount, tokenReserveA, tokenReserveB);
        } else {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            return sushiRouter.getAmountIn(_amount, tokenReserveA, tokenReserveB);
        }
    }

    function getSellPrice(bool isUni, address _token, uint256 _amount) private returns (uint256) {
        if(isUni) {
            (uint256 tokenReserveA, uint256 tokenReserveB) = UniswapV2Library.getReserves(uniFactory, WETH, _token);
            return uniRouter.getAmountOut(_amount, tokenReserveB, tokenReserveA);
        } else {
            (uint256 tokenReserveA, uint256 tokenReserveB) = SushiswapV2Library.getReserves(sushiFactory, WETH, _token);
            return sushiRouter.getAmountOut(_amount, tokenReserveB, tokenReserveA);
        }
    }

    function tokenAvailable(address _factory, address _token) private returns (bool) {
        return IUniswapV2Factory(_factory).getPair(WETH, _token) != address(0);
    }

    function purchaseToken(IUniswapV2Router02 _router, address _token, uint256 _amount) private {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = _token;
        _router.swapTokensForExactTokens(_amount, MAX_INT, path, address(this), block.timestamp);
    }

    function purchaseTokenBestPrice(address _token, uint256 _amount) private {
        uint256 uniPrice = tokenAvailable(uniFactory, _token) ? getBuyPrice(true, _token, _amount) : MAX_INT;
        uint256 sushiPrice = tokenAvailable(sushiFactory, _token) ? getBuyPrice(false, _token, _amount) : MAX_INT;
        if(uniPrice <= sushiPrice) {
            purchaseToken(uniRouter, _token, _amount);
        } else {
            purchaseToken(sushiRouter, _token, _amount);
        }
    }

    function sellToken(IUniswapV2Router02 _router, address _token) private {
        uint256 tokenBalance = IERC20(_token).balanceOf(address(this));
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = WETH;
        _router.swapExactTokensForETH(tokenBalance, 0, path, msg.sender, block.timestamp);
    }

    function sellTokenBestPrice(address _token) private {
        uint256 tokenBalance = IERC20(_token).balanceOf(address(this));
        uint256 uniPrice = tokenAvailable(uniFactory, _token) ? getSellPrice(true, _token, tokenBalance) : 0;
        uint256 sushiPrice = tokenAvailable(sushiFactory, _token) ? getSellPrice(false, _token, tokenBalance) : 0;
        if(uniPrice >= sushiPrice) {
            sellToken(uniRouter, _token);
        } else {
            sellToken(sushiRouter, _token);
        }
    }

    function preciseMulCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) {
            return 0;
        }
        return a.mul(b).sub(1).div(10 ** 18).add(1);
    }

    receive() external payable {}
}