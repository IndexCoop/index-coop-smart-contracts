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
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

contract ExchangeIssuanceZeroEx is Ownable, ReentrancyGuard {

    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    struct ZeroExSwapQuote {
        IERC20 sellToken;
        IERC20 buyToken;
        bytes swapCallData;
    }

    /* ============ Constants ============== */

    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    address public immutable WETH;

    IController public immutable setController;
    IBasicIssuanceModule public immutable basicIssuanceModule;

    address public swapTarget;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    event Refund(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        uint256 _refundAmount           // The amount of ETH redunded to the recipient
    );

    event BoughtTokens(IERC20 sellToken, IERC20 buyToken, uint256 boughtAmount);

    /* ============ Modifiers ============ */

    modifier isSetToken(ISetToken _setToken) {
         require(setController.isSet(address(_setToken)), "ExchangeIssuance: INVALID SET");
         _;
    }

    modifier isValidInput(ISetToken _setToken, uint256 _amountSetToken, ZeroExSwapQuote[] memory _componentQuotes) {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID SET TOKEN AMOUNT");
        require(_setToken.getComponents().length == _componentQuotes.length, "ExchangeIssuance: WRONG NUMBER OF COMPONENT QUOTES");
         _;
    }

    constructor(
        address _weth,
        IController _setController,
        IBasicIssuanceModule _basicIssuanceModule,
        address _swapTarget
    )
        public
    {
        setController = _setController;
        basicIssuanceModule = _basicIssuanceModule;

        WETH = _weth;
        swapTarget = _swapTarget;
    }

    /* ============ External Functions ============ */

    receive() external payable {
        // required for weth.withdraw() to work properly
        require(msg.sender == WETH, "ExchangeIssuance: Direct deposits not allowed");
    }

    /* ============ Public Functions ============ */

    /**
     * Change the _swapTarget
     *
     * @param _swapTarget    Address of the swap target contract. (Usually ZeroEx ExchangeProxy)
     */
    function setSwapTarget(address _swapTarget) public onlyOwner {
        swapTarget = _swapTarget;
    }

    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a SetToken during a
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     */
    function approveToken(IERC20 _token) public {
        _safeApprove(_token, address(basicIssuanceModule), type(uint96).max);
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
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _inputToken              Address of the input token
    * @param _inputQuote             The encoded 0x transaction from the input token to WETH
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _maxAmountInputToken        Amount of SetTokens to issue
    * @param _componentQuotes                 The encoded 0x transactions to execute (WETH -> components).
    *
    * @return amountEthReturn       Amount of ether returned to the caller
    */
    function issueExactSetFromToken(
        ISetToken _setToken,
        IERC20 _inputToken,
        ZeroExSwapQuote memory _inputQuote,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        ZeroExSwapQuote[] memory _componentQuotes
    )
        isSetToken(_setToken)
        isValidInput(_setToken, _amountSetToken, _componentQuotes)
        external
        nonReentrant
        returns (uint256)
    {

        _inputToken.transferFrom(msg.sender, address(this), _maxAmountInputToken);

        uint256 maxAmountWETH;
        if(address(_inputToken) == WETH) {
            maxAmountWETH = _maxAmountInputToken;
        } else {
            uint256 inputTokenSpent;
            _safeApprove(_inputToken, swapTarget, _maxAmountInputToken);

            (maxAmountWETH, inputTokenSpent) = _fillQuote(_inputQuote);
            require(inputTokenSpent <= _maxAmountInputToken, "ExchangeIssuance: OVERSPENT INPUT TOKEN");
            uint256 amountInputTokenReturn = _maxAmountInputToken.sub(inputTokenSpent);
            // TODO: (christ.n) to check if this is required. Shouldn't be possible as 
            // the quote should use up all the buy amount.
            if (amountInputTokenReturn > 0) {
                _inputToken.transfer(msg.sender, amountInputTokenReturn);
            }
        }

        uint256 amountWethSpent = _issueExactSetFromWETH(_setToken, _amountSetToken, maxAmountWETH, _componentQuotes);
        uint256 amountWethReturn = maxAmountWETH.sub(amountWethSpent);
        if (amountWethReturn > 0) {
            IERC20(WETH).safeTransfer(msg.sender,  amountWethReturn);
        }

        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _maxAmountInputToken, _amountSetToken);
        return amountWethSpent;
    }

    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _componentQuotes       The encoded 0x transactions to execute (WETH -> components).
    *
    * @return amountEthReturn       Amount of ether returned to the caller
    */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        ZeroExSwapQuote[] memory _componentQuotes
    )
        isSetToken(_setToken)
        isValidInput(_setToken, _amountSetToken, _componentQuotes)
        external
        nonReentrant
        payable
        returns (uint256)
    {
        require(msg.value > 0, "ExchangeIssuance: INVALID ETH AMOUNT");

        IWETH(WETH).deposit{value: msg.value}();

        uint256 amountEth = _issueExactSetFromWETH(_setToken, _amountSetToken, msg.value, _componentQuotes);

        uint256 amountEthReturn = msg.value.sub(amountEth);
        if (amountEthReturn > 0) {
            IWETH(WETH).withdraw(amountEthReturn);
            (payable(msg.sender)).sendValue(amountEthReturn);
        }

        emit Refund(msg.sender, amountEthReturn);
        emit ExchangeIssue(msg.sender, _setToken, IERC20(ETH_ADDRESS), amountEth, _amountSetToken);
        return amountEthReturn; 
    }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _outputToken          Address of output token
     * @param _outputQuote          The encoded 0x transaction from WETH to output token.
     * @param _amountSetToken       Amount SetTokens to redeem
     * @param _minOutputReceive     Minimum amount of output token to receive
     * @param _componentQuotes      The encoded 0x transactions execute (components -> WETH).
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        ZeroExSwapQuote memory _outputQuote,
        uint256 _amountSetToken,
        uint256 _minOutputReceive,
        ZeroExSwapQuote[] memory _componentQuotes
    )
        isSetToken(_setToken)
        isValidInput(_setToken, _amountSetToken, _componentQuotes)
        external
        nonReentrant
        returns (uint256)
    {

        uint256 outputAmount;
        // Redeem exact set token
        _redeemExactSet(_setToken, _amountSetToken);
        if (address(_outputToken) == WETH) {
            // Liquidate components for WETH and ignore _outputQuote
            outputAmount = _liquidateComponentsForWETH(_setToken, _amountSetToken, _componentQuotes);
        } else {
            require(address(_outputToken) == address(_outputQuote.buyToken), "ExchangeIssuance: OUTPUT TOKEN / OUTPUT QUOTE MISMATCH");
            // Liquidate components for WETH
            uint256 outputWeth = _liquidateComponentsForWETH(_setToken, _amountSetToken, _componentQuotes);
            _safeApprove(IERC20(WETH), address(swapTarget), outputWeth);
            // Swap WETH for output token
            (outputAmount,) = _fillQuote(_outputQuote);
        }
        require(outputAmount >= _minOutputReceive, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");

        // Transfer sender output token
        _outputToken.safeTransfer(msg.sender, outputAmount);
        // Emit event
        emit ExchangeRedeem(msg.sender, _setToken, _outputToken, _amountSetToken, outputAmount);
        // Return output amount
        return outputAmount;
    }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _amountSetToken       Amount SetTokens to redeem
     * @param _minEthReceive        Minimum amount of Eth to receive
     * @param _componentQuotes      The encoded 0x transactions execute (components -> WETH).
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minEthReceive,
        ZeroExSwapQuote[] memory _componentQuotes
    )
        isSetToken(_setToken)
        isValidInput(_setToken, _amountSetToken, _componentQuotes)
        external
        nonReentrant
        returns (uint256)
    {
        _redeemExactSet(_setToken, _amountSetToken);
        uint ethAmount = _liquidateComponentsForWETH(_setToken, _amountSetToken, _componentQuotes);
        require(ethAmount >= _minEthReceive, "ExchangeIssuance: INSUFFICIENT WETH RECEIVED");

        IWETH(WETH).withdraw(ethAmount);
        (payable(msg.sender)).sendValue(ethAmount);

        emit ExchangeRedeem(msg.sender, _setToken, IERC20(ETH_ADDRESS), _amountSetToken, ethAmount);
        return ethAmount;
         
    }
    
    /**
     * Sets a max approval limit for an ERC20 token, provided the current allowance
     * is less than the required allownce.
     *
     * @param _token    Token to approve
     * @param _spender  Spender address to approve
     */
    function _safeApprove(IERC20 _token, address _spender, uint256 _requiredAllowance) internal {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < _requiredAllowance) {
            _token.safeIncreaseAllowance(_spender, type(uint96).max - allowance);
        }
    }

    /**
     * Issues an exact amount of SetTokens using WETH.
     * Acquires SetToken components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the SetTokens.
     *
     * @param _setToken          Address of the SetToken being issued
     * @param _amountSetToken    Amount of SetTokens to be issued
     *
     */
    function _issueExactSetFromWETH(ISetToken _setToken, uint256 _amountSetToken, uint256 _maxAmountWeth, ZeroExSwapQuote[] memory _quotes) internal returns (uint256 totalWethSpent) {
        ISetToken.Position[] memory positions = _setToken.getPositions();

        _safeApprove(IERC20(WETH), swapTarget, _maxAmountWeth);
        for (uint256 i = 0; i < positions.length; i++) {
            ISetToken.Position memory position = positions[i];
            ZeroExSwapQuote memory quote = _quotes[i];
            require(position.component == address(quote.buyToken), "ExchangeIssuance: COMPONENT / QUOTE ADDRESS MISMATCH");
            require(address(quote.sellToken) == WETH, "ExchangeIssuance: INVALID SELL TOKEN");

            (uint256 componentAmountBought, uint256 wethAmountSpent) = _fillQuote(quote);

            // TODO: Had to reassign this variable to avoid CompilerError: Stack too deep - review if better solution possible
            uint256 setAmount = _amountSetToken;
            uint256 units = uint256(position.unit);
            uint256 minComponentRequired = setAmount.mul(units).div(10**18);
            require(componentAmountBought >= minComponentRequired, "ExchangeIssuance: UNDERBOUGHT COMPONENT");

            totalWethSpent = totalWethSpent.add(wethAmountSpent);
            require(totalWethSpent <= _maxAmountWeth, "ExchangeIssuance: OVERSPENT WETH");
        }

        basicIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);
    }

    /**
     * Liquidates a given list of SetToken components for WETH.
     *
     * @param _setToken             The set token being swapped.
     * @param _amountSetToken       The amount of set token being swapped.
     * @param _swaps                An array containing ZeroExSwap swaps.
     *
     * @return                      Total amount of WETH received after liquidating all SetToken components
     */
    function _liquidateComponentsForWETH(ISetToken _setToken, uint256 _amountSetToken, ZeroExSwapQuote[] memory _swaps)
        internal
        returns (uint256)
    {
        uint256 sumWeth = 0;
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < _swaps.length; i++) {
            require(components[i] == address(_swaps[i].sellToken), "ExchangeIssuance: COMPONENT / QUOTE ADDRESS MISMATCH");
            require(address(_swaps[i].buyToken) == WETH, "ExchangeIssuance: INVALID BUY TOKEN");
            uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(components[i]));
            uint256 maxAmountSell = unit.preciseMul(_amountSetToken);
            _safeApprove(_swaps[i].sellToken, address(swapTarget), maxAmountSell);
            (uint256 boughtAmount, uint256 soldAmount) = _fillQuote(_swaps[i]);
            require(maxAmountSell >= soldAmount, "ExchangeIssuance: OVERSOLD COMPONENT");
            sumWeth = sumWeth.add(boughtAmount);
        }
        return sumWeth;
    }

    /**
     * Execute a 0x Swap quote
     *
     * @param _quote          Swap quote as returned by 0x API
     *
     * @return boughtAmount   The amount of _quote.buyToken obtained
     * @return spentAmount    The amount of _quote.sellToken spent
     */
    function _fillQuote(
        ZeroExSwapQuote memory _quote
    )
        internal
        returns(uint256 boughtAmount, uint256 spentAmount)
    {
        uint256 buyTokenBalanceBefore = _quote.buyToken.balanceOf(address(this));
        uint256 sellTokenBalanceBefore = _quote.sellToken.balanceOf(address(this));

        (bool success, bytes memory returndata) = swapTarget.call(_quote.swapCallData);
        require(success, string(returndata));

        boughtAmount = _quote.buyToken.balanceOf(address(this)).sub(buyTokenBalanceBefore);
        spentAmount = sellTokenBalanceBefore.sub(_quote.sellToken.balanceOf(address(this)));
        emit BoughtTokens(_quote.sellToken, _quote.buyToken, boughtAmount);
    }

    /**
     * Redeems a given amount of SetToken.
     *
     * @param _setToken     Address of the SetToken to be redeemed
     * @param _amount       Amount of SetToken to be redeemed
     */
    function _redeemExactSet(ISetToken _setToken, uint256 _amount) internal returns (uint256) {
        _setToken.safeTransferFrom(msg.sender, address(this), _amount);
        basicIssuanceModule.redeem(_setToken, _amount, address(this));
    }
}
