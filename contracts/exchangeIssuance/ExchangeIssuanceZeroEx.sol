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
        address spender;
        address payable swapTarget;
        bytes swapCallData;
        uint256 value;
        uint256 sellAmount;
    }

    /* ============ State Variables ============ */

    address public immutable WETH;

    IController public immutable setController;
    IBasicIssuanceModule public immutable basicIssuanceModule;

    mapping(address => bool) allowedSwapTargets;

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

    constructor(
        address _weth,
        IController _setController,
        IBasicIssuanceModule _basicIssuanceModule,
        address[] memory _allowedSwapTargets
    )
        public
    {
        setController = _setController;
        basicIssuanceModule = _basicIssuanceModule;

        WETH = _weth;
        // Safe approve 0x contract address
        for (uint256 i = 0; i < _allowedSwapTargets.length; i++) {
            addAllowedSwapTarget(_allowedSwapTargets[i]);
        }
    }

    /* ============ Public Functions ============ */

    /**
     * Adds given address to whitelist of allowed swap target contracts
     *
     * @param _swapTarget    Address of the swap target contract. (Usually ZeroEx ExchangeProxy)
     */
    function addAllowedSwapTarget(address _swapTarget) public onlyOwner {
        allowedSwapTargets[_swapTarget] = true;
    }

    /**
     * Removes given address from whitelist of allowed swap target contracts
     *
     * @param _swapTarget    Address of the swap target contract. (Usually ZeroEx ExchangeProxy)
     */
    function removeAllowedSwapTarget(address _swapTarget) public onlyOwner {
        allowedSwapTargets[_swapTarget] = false;
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
        external
        nonReentrant
        payable // Must attach ETH equal to the sum of the `value` fields from all the API responses.
        returns (uint256)
    {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");
        require(_setToken.getComponents().length == _componentQuotes.length, "Wrong number of component quotes");

        _inputToken.transferFrom(msg.sender, address(this), _maxAmountInputToken);

        uint256 maxAmountWETH;
        uint256 maxAmountETH = msg.value;
        if(address(_inputToken) == WETH){
            maxAmountWETH = _maxAmountInputToken;
        }
        else {
            uint256 inputTokenSpent;
            _safeApprove(_inputToken, _inputQuote.swapTarget, _maxAmountInputToken);

            if(_inputQuote.value > 0){
                maxAmountETH = maxAmountETH.sub(_inputQuote.value);
                require(maxAmountETH >= 0, "OVERSPENT NATIVE ETH");
            }

            (maxAmountWETH, inputTokenSpent) = _fillQuote(_inputQuote);
            require(inputTokenSpent <= _maxAmountInputToken, "OVERSPENT INPUTTOKEN");
            uint256 amountInputTokenReturn = _maxAmountInputToken.sub(inputTokenSpent);
            if (amountInputTokenReturn > 0) {
                _inputToken.transfer(msg.sender, amountInputTokenReturn);
            }
        }

        uint256 amountWethSpent = _issueExactSetFromWETH(_setToken, _amountSetToken, maxAmountWETH, maxAmountETH, _componentQuotes);
        uint256 amountEthReturn = maxAmountWETH.sub(amountWethSpent);
        if (amountEthReturn > 0) {
            IERC20(WETH).safeTransfer(msg.sender,  amountEthReturn);
        }

        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _maxAmountInputToken, _amountSetToken);
        return amountWethSpent;
    }

    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _inputToken            Address of the input token
    * @param _inputSwap             The encoded 0x transaction from ETH to WETH.
    * @param _amountSetToken        Amount of SetTokens to issue
    * @param _maxAmountInputToken   Maximum amount of input tokens to be used to issue SetTokens. The unused
    *                               input tokens are returned as ether.
    * @param _swaps                 The encoded 0x transactions to execute (WETH -> components).
    *
    * @return amountEthReturn       Amount of ether returned to the caller
    */
    function issueExactSetFromETH(
        ISetToken _setToken,
        IERC20 _inputToken,
        ZeroExSwapQuote calldata _inputSwap,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        ZeroExSwapQuote[] calldata _swaps
    )
        isSetToken(_setToken)
        external
        nonReentrant
        returns (uint256)
    {
        require(_amountSetToken > 0 && _maxAmountInputToken > 0, "ExchangeIssuance: INVALID INPUTS");
        // TODO: implement this
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
        external
        nonReentrant
        returns (uint256)
    {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");
        require(address(_outputToken) == address(_outputQuote.buyToken), "ExchangeIssuance: INVALID INPUTS");

        address[] memory components = _setToken.getComponents();
        require(components.length == _componentQuotes.length, "ExchangeIssuance: INVALID INPUTS");
        // Verify all component quotes do not have external positions
        for (uint256 i = 0; i < components.length; i++) {
            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(components[i]).length == 0,
                "ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );

            uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(components[i]));
            uint256 requiredAmount = unit.preciseMul(_amountSetToken);

            ZeroExSwapQuote memory quote = _findMatchingQuote(components[i], _componentQuotes);
            require(address(quote.buyToken) == WETH, "ExchangeIssuance: INVALID INTERMEDIARY TOKEN");
            require(requiredAmount == quote.sellAmount, "ExchangeIssuance: INVALID SELL AMOUNT");
        }

        uint256 outputAmount;
        // Redeem exact set token
        _redeemExactSet(_setToken, _amountSetToken);
        if (address(_outputToken) == WETH) {
            // Liquidate components for WETH
            outputAmount = _fillQuotes(_componentQuotes);
        } else {
            // _safeApprove(_outputToken, _outputQuote.swapTarget, _minOutputReceive);
            // Liquidate components for WETH
            uint256 outputEth = _fillQuotes(_componentQuotes);
            // Need to check that WETH is around equal to outputQuote's specified WETH amount (sellAmount)
            require(outputEth == _outputQuote.sellAmount, "ExchangeIssuance: INVALID WETH");
            // Swap WETH for output token
            (outputAmount,) = _fillQuote(_outputQuote);
        }
        require(outputAmount >= _minOutputReceive, "ExchangeIssuance: INVALID OUTPUT AMOUNT");

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
     * @param _outputToken          Address of output token
     * @param _outputSwap           The encoded 0x transaction from WETH to ETH.
     * @param _amountSetToken       Amount SetTokens to redeem
     * @param _minOutputReceive     Minimum amount of output token to receive
     * @param _swaps                The encoded 0x transactions to execute (components -> WETH).
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        IERC20 _outputToken,
        ZeroExSwapQuote calldata _outputSwap,
        uint256 _amountSetToken,
        uint256 _minOutputReceive,
        ZeroExSwapQuote[] calldata _swaps
    )
        isSetToken(_setToken)
        external
        nonReentrant
        returns (uint256)
    {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");
        // TODO: implement this
    }

    /**
     * Returns an estimated amount of SetToken that can be issued given an amount of input ERC20 token.
     *
     * @param _setToken         Address of the SetToken being issued
     * @param _amountInput      Amount of the input token to spend
     * @param _inputToken       Address of input token.
     *
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
        // TODO: implement this
    }

    /**
    * Returns the amount of input ERC20 tokens required to issue an exact amount of SetTokens.
    *
    * @param _setToken          Address of the SetToken being issued
    * @param _amountSetToken    Amount of SetTokens to issue
    *
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
        // TODO: implement this
    }

    /**
     * Returns amount of output ERC20 tokens received upon redeeming a given amount of SetToken.
     *
     * @param _setToken             Address of SetToken to be redeemed
     * @param _amountSetToken       Amount of SetToken to be redeemed
     * @param _outputToken          Address of output token
     *
     * @return                      Estimated amount of ether/erc20 that will be received
     */
    function getAmountOutOnRedeemSet(
        ISetToken _setToken,
        address _outputToken,
        uint256 _amountSetToken
    )
        isSetToken(_setToken)
        external
        view
        returns (uint256)
    {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");
        // TODO: implement this
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
    function _issueExactSetFromWETH(ISetToken _setToken, uint256 _amountSetToken, uint256 _maxAmountWeth, uint256 _maxAmountEthValue, ZeroExSwapQuote[] memory _quotes) internal returns (uint256 totalWethSpent) {
        ISetToken.Position[] memory positions = _setToken.getPositions();

        uint256 totalWethApproved = 0;
        uint256 totalEthValue = 0;

        for (uint256 i = 0; i < positions.length; i++) {
            ISetToken.Position memory position = positions[i];
            ZeroExSwapQuote memory quote = _quotes[i];
            require(position.component == address(quote.buyToken), "Component / Quote mismatch");
            require(address(quote.sellToken) ==  WETH, "Invalid Sell Token");

            totalWethApproved = totalWethApproved.add(quote.sellAmount);
            require(totalWethApproved <= _maxAmountWeth, "OVERAPPROVED WETH");
            _safeApprove(IERC20(WETH), quote.swapTarget, quote.sellAmount);

            if(quote.value > 0){
                totalEthValue = totalEthValue.add(quote.value);
                require(totalEthValue <= _maxAmountEthValue, "OVERSPENT NATIVE ETH");
            }

            (uint256 componentAmountBought, uint256 wethAmountSpent) = _fillQuote(quote);
            totalWethSpent = totalWethSpent.add(wethAmountSpent);
            // TODO: Check if we bought enough component to avoid attackers using left over tokens in contract to make up for insufficient purchase
            require(totalWethSpent <= _maxAmountWeth, "OVERSPENT WETH");
        }

        basicIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);
    }

    /**
     * Liquidates a given list of SetToken components for WETH.
     *
     * @param _swaps                An array containing ZeroExSwap swaps
     *
     * @return                      Total amount of WETH received after liquidating all SetToken components
     */
    function _fillQuotes(ZeroExSwapQuote[] memory _swaps)
        internal
        returns (uint256)
    {
        uint256 sumEth = 0;
        for (uint256 i = 0; i < _swaps.length; i++) {
            (uint256 boughtAmount,) = _fillQuote(_swaps[i]);
            sumEth = sumEth.add(boughtAmount);
        }
        return sumEth;
    }

    /**
     * Execute a 0x Swap quote
     *
     * @param _quote      Swap quote as returned by 0x API
     *
     * @return boughtAmount  The amount of _quote.buyToken obtained
     * @return spentAmount  The amount of _quote.sellToken spent
     */
    function _fillQuote(
        ZeroExSwapQuote memory _quote
    )
        internal
        returns(uint256 boughtAmount, uint256 spentAmount)
    {
        require(allowedSwapTargets[_quote.swapTarget], "UNAUTHORISED SWAP TARGET");
        uint256 buyTokenBalanceBefore = _quote.buyToken.balanceOf(address(this));
        uint256 sellTokenBalanceBefore = _quote.sellToken.balanceOf(address(this));

        _safeApprove(_quote.sellToken, address(_quote.swapTarget), _quote.sellAmount);
        (bool success,) = _quote.swapTarget.call{value: _quote.value}(_quote.swapCallData);
        require(success, "SWAP_CALL_FAILED");

        // TODO: check if we want to do this / and how to do so safely
        // Refund any unspent protocol fees to the sender.
        // payable(msg.sender).transfer(address(this).balance);
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

    /**
     * Given a token and array of 0x quotes, find the matching quote.
     *
     * @param _token        Address of the token to find
     * @param _quotes       Set of 0x quotes to search through
     */
    function _findMatchingQuote(address _token, ZeroExSwapQuote[] memory _quotes) internal pure returns (ZeroExSwapQuote memory) {
        for (uint256 i = 0; i < _quotes.length; i++) {
            if (address(_quotes[i].sellToken) == _token) {
                return _quotes[i];
            }
        }
        require(false, "Failed to find matching quote");
    }
}
