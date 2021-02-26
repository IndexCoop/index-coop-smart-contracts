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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
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
    
    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;
    
    /* ============ Enums ============ */
    
    enum Exchange { Uniswap, Sushiswap }

    /* ============ Constants ============= */

    uint256 constant private MAX_UINT96 = 2**96 - 1;
    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    
    /* ============ State Variables ============ */

    address public WETH;
    IUniswapV2Router02 public uniRouter;
    IUniswapV2Router02 public sushiRouter;
    
    address public immutable uniFactory;
    address public immutable sushiFactory;
    
    IController public immutable setController;
    IBasicIssuanceModule public immutable basicIssuanceModule;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,    // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,   // The addres of output asset(ERC20/ETH) received by the recipient
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
        address _weth,
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
        
        setController = _setController;
        basicIssuanceModule = _basicIssuanceModule;
        
        WETH = _weth;
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
    
    receive() external payable {
        // required for weth.withdraw() to work properly
        require(msg.sender == WETH, "ExchangeIssuance: Direct deposits not allowed");
    }
    
    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     */
    function approveTokens(IERC20[] calldata _tokens) external {
        for (uint256 i = 0; i < _tokens.length; i++) {
            approveToken(_tokens[i]);
        }
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a SetToken. This function need to be called only once before the first time
     * this smart contract is used on any particular SetToken.
     *
     * @param _setToken    Address of the SetToken being initialized
     */
    function approveSetToken(ISetToken _setToken) isSetToken(_setToken) external {
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(components[i]).length == 0,
                "ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );
            approveToken(IERC20(components[i]));
        }
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
        
        uint256 amountEth = address(_inputToken) == WETH
            ? _amountInput
            : _swapTokenForWETH(_inputToken, _amountInput);

        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive, amountEth);
        
        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _amountInput, setTokenAmount);
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
        
        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive, msg.value);
        
        emit ExchangeIssue(msg.sender, _setToken, IERC20(ETH_ADDRESS), msg.value, setTokenAmount);
    }
    
    /**
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _inputToken            Address of the input token
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _maxAmountInputToken   Maximum amount of input tokens to be used to issue SetTokens. The unused 
    *                               input tokens are returned as ether.
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
        
        uint256 amountEthSpent = _issueExactSetFromWETH(_setToken, _amountSetToken, initETHAmount);
        
        uint256 amountEthReturn = initETHAmount.sub(amountEthSpent);
        if (amountEthReturn > 0) {
            IWETH(WETH).withdraw(amountEthReturn);
            (payable(msg.sender)).sendValue(amountEthReturn);
        }
        
        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _maxAmountInputToken, _amountSetToken);
    }
    
    /**
    * Issues an exact amount of SetTokens using a given amount of ether.
    * The excess ether is returned back.
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
        
        uint256 amountEth = _issueExactSetFromWETH(_setToken, _amountSetToken, msg.value);
        
        uint256 returnAmount = msg.value.sub(amountEth);
        
        if (returnAmount > 0) {
            IWETH(WETH).withdraw(returnAmount);
            (payable(msg.sender)).sendValue(returnAmount);
        }
        
        emit ExchangeIssue(msg.sender, _setToken, IERC20(ETH_ADDRESS), amountEth, _amountSetToken);
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
            
            emit ExchangeRedeem(msg.sender, _setToken, _outputToken, _amountSetToRedeem, amountEthOut);
        } else {
            // Get max amount of tokens with the available amountEthOut
            (uint256 amountTokenOut, Exchange exchange) = _getMaxTokenForExactToken(amountEthOut, address(WETH), address(_outputToken));
            require(amountTokenOut > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            
            uint256 outputAmount = _swapExactTokensForTokens(exchange, WETH, address(_outputToken), amountEthOut);
            _outputToken.safeTransfer(msg.sender, outputAmount);
           
            emit ExchangeRedeem(msg.sender, _setToken, _outputToken, _amountSetToRedeem, outputAmount);
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
        (payable(msg.sender)).sendValue(amountEthOut);

        emit ExchangeRedeem(msg.sender, _setToken, IERC20(ETH_ADDRESS), _amountSetToRedeem, amountEthOut);
    }

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
        if (address(_inputToken) != WETH) {
            // get max amount of WETH for the `_amountInput` amount of input tokens
            (amountEth, ) = _getMaxTokenForExactToken(_amountInput, address(_inputToken), WETH);
        } else {
            amountEth = _amountInput;
        }
        
        address[] memory components = _setToken.getComponents();
        (
            uint256 sumEth, 
            uint256[] memory amountEthIn, 
            Exchange[] memory exchanges, 
            uint256[] memory amountComponents
        ) = _getAmountETHForIssuance(_setToken, components, PreciseUnitMath.preciseUnit());
        
        uint256 maxIndexAmount = PreciseUnitMath.maxUint256();
        
        for (uint256 i = 0; i < components.length; i++) {
            uint256 scaledAmountEth = amountEthIn[i].mul(amountEth).div(sumEth);
            
            uint256 amountTokenOut;
            if (exchanges[i] == Exchange.Uniswap) {
                (uint256 reserveIn, uint256 reserveOut) = UniswapV2Library.getReserves(uniFactory, WETH, components[i]);
                amountTokenOut = UniswapV2Library.getAmountOut(scaledAmountEth, reserveIn, reserveOut);
            } else {
                require(exchanges[i] == Exchange.Sushiswap, "ExchangeIssuance: Exchange not supported");
                (uint256 reserveIn, uint256 reserveOut) = SushiswapV2Library.getReserves(sushiFactory, WETH, components[i]);
                amountTokenOut = SushiswapV2Library.getAmountOut(scaledAmountEth, reserveIn, reserveOut);
            }
            
            maxIndexAmount = Math.min(amountTokenOut.preciseDiv(amountComponents[i]), maxIndexAmount);
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
        
        address[] memory components = _setToken.getComponents();
        (uint256 totalEth, , , ) = _getAmountETHForIssuance(_setToken, components, _amountSetToken);
        
        if (address(_inputToken) == WETH) {
            return totalEth;
        }
        
        (uint256 tokenAmount, ) = _getMinTokenForExactToken(totalEth, address(_inputToken), address(WETH));
        return tokenAmount;
    }
    
    /**
     * Returns amount of ETH/ERC20 received upon redeeming a given amount of SetToken.
     *
     * @param _setToken             SetToken to be redeemed
     * @param _amountSetToRedeem    Amount of SetToken
     * @param _outputToken          Address of output token
     * @return                      Estimated amount of ether/erc20 that will be received
     */
    function getAmountOutOnRedeemSet(
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
        
        uint256 totalEth = 0;
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            
            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(components[i]).length == 0,
                "Exchange Issuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );
            
            uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(components[i]));
            uint256 amount = unit.preciseMul(_amountSetToRedeem);
            
            // get maximum amount of ETH received for a given amount of SetToken component
            (uint256 amountEth, ) = _getMaxTokenForExactToken(amount, components[i], WETH);
            totalEth = totalEth.add(amountEth);
        }
        if (_outputToken == WETH) {
            return totalEth;
        }
        
        // get maximum amount of tokens for totalEth amount of ETH
        (uint256 tokenAmount, ) = _getMaxTokenForExactToken(totalEth, WETH, _outputToken);
        return tokenAmount;
    }
    
    
    /* ============ Internal Functions ============ */

    /**
     * Sets a max aproval limit for an ERC20 token, provided the current allowance 
     * is less than 1/2 MAX_UINT96. 
     * 
     * @param _token    Token to approve
     * @param _spender  Spender address to approve
     */
    function _safeApprove(IERC20 _token, address _spender) internal {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < MAX_UINT96 / 2) {
            _token.safeIncreaseAllowance(_spender, MAX_UINT96 - allowance);
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
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            
            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(components[i]).length == 0,
                "Exchange Issuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );

            address token = components[i];
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
     * @param _totalEthAmount   Total amount of WETH to be used to purchase the SetToken components
     * @return setTokenAmount   Amount of SetTokens issued
     */
    function _issueSetForExactWETH(ISetToken _setToken, uint256 _minSetReceive, uint256 _totalEthAmount) internal returns (uint256) {
        
        address[] memory components = _setToken.getComponents();
        (
            uint256 sumEth, 
            uint256[] memory amountEthIn, 
            Exchange[] memory exchanges, 
            uint256[] memory amountComponents
        ) = _getAmountETHForIssuance(_setToken, components, PreciseUnitMath.preciseUnit());
        
        // Acquire the SetToken components from exchanges
        uint256 setTokenAmount = PreciseUnitMath.maxUint256();
        for (uint256 i = 0; i < components.length; i++) {
            uint256 scaledAmountEth = amountEthIn[i].mul(_totalEthAmount).div(sumEth);
            uint256 amountTokenOut = _swapExactTokensForTokens(exchanges[i], WETH, components[i], scaledAmountEth);
            setTokenAmount = Math.min(amountTokenOut.preciseDiv(amountComponents[i]), setTokenAmount);
        }
        
        require(setTokenAmount >= _minSetReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
        
        basicIssuanceModule.issue(_setToken, setTokenAmount, msg.sender);
        return setTokenAmount;
    }
    
    /**
     * Issues an exact amount of SetTokens using WETH. 
     * Acquires SetToken components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the SetTokens.
     * 
     * @param _setToken          Address of the SetToken being issued
     * @param _amountSetToken    Amount of SetTokens to be issued
     * @param _maxEther          Max amount of ether that can be used to acquire the SetToken components
     * @return totalEth          Total amount of ether used to acquire the SetToken components
     */
    function _issueExactSetFromWETH(ISetToken _setToken, uint256 _amountSetToken, uint256 _maxEther) internal returns (uint256) {
        
        address[] memory components = _setToken.getComponents();
        (
            uint256 sumEth,
            , 
            Exchange[] memory exchanges, 
            uint256[] memory amountComponents
        ) = _getAmountETHForIssuance(_setToken, components, _amountSetToken);
        
        require(sumEth <= _maxEther, "ExchangeIssuance: INSUFFICIENT_INPUT_AMOUNT");
        
        uint256 totalEth = 0;
        for (uint256 i = 0; i < components.length; i++) {
            uint256 amountEth = _swapTokensForExactTokens(exchanges[i], WETH, components[i], amountComponents[i]);
            totalEth = totalEth.add(amountEth);
        }
        basicIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);
        return totalEth;
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
     * Gets the total amount of ether required for purchasing each component in a SetToken,
     * to enable the issuance of a given amount of SetTokens.
     * 
     * @param _setToken             Address of the SetToken to be issued
     * @param _components           An array containing the addresses of the SetToken components
     * @param _amountSetToken       Amount of SetToken to be issued
     * @return sumEth               The approximate total ETH cost to issue the set
     * @return amountEthIn          An array containing the amount of ether to purchase each component of the SetToken
     * @return exchanges            An array containing the exchange on which to perform the purchase
     * @return amountComponents     An array containing the amount of each SetToken component required for issuing the given
     *                              amount of SetToken
     */
    function _getAmountETHForIssuance(ISetToken _setToken, address[] memory _components, uint256 _amountSetToken)
        internal
        view
        returns (uint256, uint256[] memory, Exchange[] memory, uint256[] memory)
    {
        uint256 sumEth = 0;
        uint256[] memory amountEthIn = new uint256[](_components.length);
        uint256[] memory amountComponents = new uint256[](_components.length);
        Exchange[] memory exchanges = new Exchange[](_components.length);
        
        for (uint256 i = 0; i < _components.length; i++) {

            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(_components[i]).length == 0,
                "Exchange Issuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );

            // Get minimum amount of ETH to be spent to acquire the required amount of SetToken component
            uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(_components[i]));
            amountComponents[i] = uint256(unit).preciseMul(_amountSetToken);
            
            (amountEthIn[i], exchanges[i]) = _getMinTokenForExactToken(amountComponents[i], WETH, _components[i]);
            sumEth = sumEth.add(amountEthIn[i]);
        }
        return (sumEth, amountEthIn, exchanges, amountComponents);
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
        if (_tokenIn == _tokenOut) {
            return _amountIn;
        }
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
        if (_tokenIn == _tokenOut) {
            return _amountOut;
        }
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
        if (_tokenA == _tokenB) {
            return (_amountOut, Exchange(-1));
        }
        
        uint256 maxIn = PreciseUnitMath.maxUint256() ; 
        uint256 uniTokenIn = maxIn;
        uint256 sushiTokenIn = maxIn;
        
        if (_pairAvailable(uniFactory, _tokenA, _tokenB)) {
            (uint256 reserveIn, uint256 reserveOut) = UniswapV2Library.getReserves(uniFactory, _tokenA, _tokenB);
            // Prevent subtraction overflow by making sure pool reserves are greater than swap amount
            if(reserveOut > _amountOut) {
                uniTokenIn = UniswapV2Library.getAmountIn(_amountOut, reserveIn, reserveOut);
            }
        }
        
        if (_pairAvailable(sushiFactory, _tokenA, _tokenB)) {
            (uint256 reserveIn, uint256 reserveOut) = SushiswapV2Library.getReserves(sushiFactory, _tokenA, _tokenB);
            // Prevent subtraction overflow by making sure pool reserves are greater than swap amount
            if(reserveOut > _amountOut) {
                sushiTokenIn = SushiswapV2Library.getAmountIn(_amountOut, reserveIn, reserveOut);
            }
        }
        
        // Fails if both the values are maxIn
        require(!(uniTokenIn == maxIn && sushiTokenIn == maxIn), "ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        return (uniTokenIn <= sushiTokenIn) ? (uniTokenIn, Exchange.Uniswap) : (sushiTokenIn, Exchange.Sushiswap);
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
        if (_tokenA == _tokenB) {
            return (_amountIn, Exchange(-1));
        }
        
        uint256 uniTokenOut = 0;
        uint256 sushiTokenOut = 0;
        
        if(_pairAvailable(uniFactory, _tokenA, _tokenB)) {
            (uint256 reserveIn, uint256 reserveOut) = UniswapV2Library.getReserves(uniFactory, _tokenA, _tokenB);
            uniTokenOut = UniswapV2Library.getAmountOut(_amountIn, reserveIn, reserveOut);
        }
        
        if(_pairAvailable(sushiFactory, _tokenA, _tokenB)) {
            (uint256 reserveIn, uint256 reserveOut) = SushiswapV2Library.getReserves(sushiFactory, _tokenA, _tokenB);
            sushiTokenOut = SushiswapV2Library.getAmountOut(_amountIn, reserveIn, reserveOut);
        }
        
        // Fails if both the values are 0
        require(!(uniTokenOut == 0 && sushiTokenOut == 0), "ExchangeIssuance: ILLIQUID_SET_COMPONENT");
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