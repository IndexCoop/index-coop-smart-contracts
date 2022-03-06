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
import { UniSushiV2Library } from "../../external/contracts/UniSushiV2Library.sol";

/**
 * @title ExchangeIssuance
 * @author Index Coop
 *
 * Contract for issuing and redeeming any SetToken using ETH or an ERC20 as the paying/receiving currency.
 * All swaps are done using the best price found on Uniswap or Sushiswap.
 *
 */
contract ExchangeIssuanceV2 is ReentrancyGuard {

    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Enums ============ */

    enum Exchange { Uniswap, Sushiswap, None }

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
        _safeApprove(_token, address(uniRouter), MAX_UINT96);
        _safeApprove(_token, address(sushiRouter), MAX_UINT96);
        _safeApprove(_token, address(basicIssuanceModule), MAX_UINT96);
    }

    /* ============ External Functions ============ */

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
     *
     * @return setTokenAmount   Amount of SetTokens issued to the caller
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
        returns (uint256)
    {
        require(_amountInput > 0, "ExchangeIssuance: INVALID INPUTS");

        _inputToken.safeTransferFrom(msg.sender, address(this), _amountInput);

        uint256 amountEth = address(_inputToken) == WETH
            ? _amountInput
            : _swapTokenForWETH(_inputToken, _amountInput);

        uint256 setTokenAmount = _issueSetForExactWETH(_setToken, _minSetReceive, amountEth);

        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _amountInput, setTokenAmount);
        return setTokenAmount;
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
    *
    * @return amountEthReturn       Amount of ether returned to the caller
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
        returns (uint256)
    {
        require(_amountSetToken > 0 && _maxAmountInputToken > 0, "ExchangeIssuance: INVALID INPUTS");

        _inputToken.safeTransferFrom(msg.sender, address(this), _maxAmountInputToken);

        uint256 initETHAmount = address(_inputToken) == WETH
            ? _maxAmountInputToken
            : _swapTokenForWETH(_inputToken, _maxAmountInputToken);

        uint256 amountEthSpent = _issueExactSetFromWETH(_setToken, _amountSetToken, initETHAmount);

        uint256 amountEthReturn = initETHAmount.sub(amountEthSpent);
        if (amountEthReturn > 0) {
            IERC20(WETH).safeTransfer(msg.sender,  amountEthReturn);
        }

        emit Refund(msg.sender, amountEthReturn);
        emit ExchangeIssue(msg.sender, _setToken, _inputToken, _maxAmountInputToken, _amountSetToken);
        return amountEthReturn;
    }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken             Address of the SetToken being redeemed
     * @param _outputToken          Address of output token
     * @param _amountSetToken       Amount SetTokens to redeem
     * @param _minOutputReceive     Minimum amount of output token to receive
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForToken(
        ISetToken _setToken,
        IERC20 _outputToken,
        uint256 _amountSetToken,
        uint256 _minOutputReceive
    )
        isSetToken(_setToken)
        external
        nonReentrant
        returns (uint256)
    {
        require(_amountSetToken > 0, "ExchangeIssuance: INVALID INPUTS");

        address[] memory components = _setToken.getComponents();
        (
            uint256 totalEth,
            uint256[] memory amountComponents,
            Exchange[] memory exchanges
        ) =  _getAmountETHForRedemption(_setToken, components, _amountSetToken);

        uint256 outputAmount;
        if (address(_outputToken) == WETH) {
            require(totalEth > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            _redeemExactSet(_setToken, _amountSetToken);
            outputAmount = _liquidateComponentsForWETH(components, amountComponents, exchanges);
        } else {
            (uint256 totalOutput, Exchange outTokenExchange, ) = _getMaxTokenForExactToken(totalEth, address(WETH), address(_outputToken));
            require(totalOutput > _minOutputReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");
            _redeemExactSet(_setToken, _amountSetToken);
            uint256 outputEth = _liquidateComponentsForWETH(components, amountComponents, exchanges);
            outputAmount = _swapExactTokensForTokens(outTokenExchange, WETH, address(_outputToken), outputEth);
        }

        _outputToken.safeTransfer(msg.sender, outputAmount);
        emit ExchangeRedeem(msg.sender, _setToken, _outputToken, _amountSetToken, outputAmount);
        return outputAmount;
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

        uint256 amountEth;
        if (address(_inputToken) != WETH) {
            // get max amount of WETH for the `_amountInput` amount of input tokens
            (amountEth, , ) = _getMaxTokenForExactToken(_amountInput, address(_inputToken), WETH);
        } else {
            amountEth = _amountInput;
        }

        address[] memory components = _setToken.getComponents();
        (uint256 setIssueAmount, , ) = _getSetIssueAmountForETH(_setToken, components, amountEth);
        return setIssueAmount;
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

        address[] memory components = _setToken.getComponents();
        (uint256 totalEth, , , , ) = _getAmountETHForIssuance(_setToken, components, _amountSetToken);

        if (address(_inputToken) == WETH) {
            return totalEth;
        }

        (uint256 tokenAmount, , ) = _getMinTokenForExactToken(totalEth, address(_inputToken), address(WETH));
        return tokenAmount;
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

        address[] memory components = _setToken.getComponents();
        (uint256 totalEth, , ) = _getAmountETHForRedemption(_setToken, components, _amountSetToken);

        if (_outputToken == WETH) {
            return totalEth;
        }

        // get maximum amount of tokens for totalEth amount of ETH
        (uint256 tokenAmount, , ) = _getMaxTokenForExactToken(totalEth, WETH, _outputToken);
        return tokenAmount;
    }


    /* ============ Internal Functions ============ */

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
            _token.safeIncreaseAllowance(_spender, MAX_UINT96 - allowance);
        }
    }

    /**
     * Issues SetTokens for an exact amount of input WETH.
     *
     * @param _setToken         Address of the SetToken being issued
     * @param _minSetReceive    Minimum amount of index to receive
     * @param _totalEthAmount   Total amount of WETH to be used to purchase the SetToken components
     *
     * @return setTokenAmount   Amount of SetTokens issued
     */
    function _issueSetForExactWETH(ISetToken _setToken, uint256 _minSetReceive, uint256 _totalEthAmount) internal returns (uint256) {

        address[] memory components = _setToken.getComponents();
        (
            uint256 setIssueAmount,
            uint256[] memory amountEthIn,
            Exchange[] memory exchanges
        ) = _getSetIssueAmountForETH(_setToken, components, _totalEthAmount);

        require(setIssueAmount > _minSetReceive, "ExchangeIssuance: INSUFFICIENT_OUTPUT_AMOUNT");

        for (uint256 i = 0; i < components.length; i++) {
            _swapExactTokensForTokens(exchanges[i], WETH, components[i], amountEthIn[i]);
        }

        basicIssuanceModule.issue(_setToken, setIssueAmount, msg.sender);
        return setIssueAmount;
    }

    /**
     * Issues an exact amount of SetTokens using WETH.
     * Acquires SetToken components at the best price accross uniswap and sushiswap.
     * Uses the acquired components to issue the SetTokens.
     *
     * @param _setToken          Address of the SetToken being issued
     * @param _amountSetToken    Amount of SetTokens to be issued
     * @param _maxEther          Max amount of ether that can be used to acquire the SetToken components
     *
     * @return totalEth          Total amount of ether used to acquire the SetToken components
     */
    function _issueExactSetFromWETH(ISetToken _setToken, uint256 _amountSetToken, uint256 _maxEther) internal returns (uint256) {

        address[] memory components = _setToken.getComponents();
        (
            uint256 sumEth,
            ,
            Exchange[] memory exchanges,
            uint256[] memory amountComponents,
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
     * Liquidates a given list of SetToken components for WETH.
     *
     * @param _components           An array containing the address of SetToken components
     * @param _amountComponents     An array containing the amount of each SetToken component
     * @param _exchanges            An array containing the exchange on which to liquidate the SetToken component
     *
     * @return                      Total amount of WETH received after liquidating all SetToken components
     */
    function _liquidateComponentsForWETH(address[] memory _components, uint256[] memory _amountComponents, Exchange[] memory _exchanges)
        internal
        returns (uint256)
    {
        uint256 sumEth = 0;
        for (uint256 i = 0; i < _components.length; i++) {
            sumEth = _exchanges[i] == Exchange.None
                ? sumEth.add(_amountComponents[i])
                : sumEth.add(_swapExactTokensForTokens(_exchanges[i], _components[i], WETH, _amountComponents[i]));
        }
        return sumEth;
    }

    /**
     * Gets the total amount of ether required for purchasing each component in a SetToken,
     * to enable the issuance of a given amount of SetTokens.
     *
     * @param _setToken             Address of the SetToken to be issued
     * @param _components           An array containing the addresses of the SetToken components
     * @param _amountSetToken       Amount of SetToken to be issued
     *
     * @return sumEth               The total amount of Ether reuired to issue the set
     * @return amountEthIn          An array containing the amount of ether to purchase each component of the SetToken
     * @return exchanges            An array containing the exchange on which to perform the purchase
     * @return amountComponents     An array containing the amount of each SetToken component required for issuing the given
     *                              amount of SetToken
     * @return pairAddresses        An array containing the pair addresses of ETH/component exchange pool
     */
    function _getAmountETHForIssuance(ISetToken _setToken, address[] memory _components, uint256 _amountSetToken)
        internal
        view
        returns (
            uint256 sumEth,
            uint256[] memory amountEthIn,
            Exchange[] memory exchanges,
            uint256[] memory amountComponents,
            address[] memory pairAddresses
        )
    {
        sumEth = 0;
        amountEthIn = new uint256[](_components.length);
        amountComponents = new uint256[](_components.length);
        exchanges = new Exchange[](_components.length);
        pairAddresses = new address[](_components.length);

        for (uint256 i = 0; i < _components.length; i++) {

            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(_components[i]).length == 0,
                "ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );

            // Get minimum amount of ETH to be spent to acquire the required amount of SetToken component
            uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(_components[i]));
            amountComponents[i] = uint256(unit).preciseMulCeil(_amountSetToken);

            (amountEthIn[i], exchanges[i], pairAddresses[i]) = _getMinTokenForExactToken(amountComponents[i], WETH, _components[i]);
            sumEth = sumEth.add(amountEthIn[i]);
        }
        return (sumEth, amountEthIn, exchanges, amountComponents, pairAddresses);
    }

    /**
     * Gets the total amount of ether returned from liquidating each component in a SetToken.
     *
     * @param _setToken             Address of the SetToken to be redeemed
     * @param _components           An array containing the addresses of the SetToken components
     * @param _amountSetToken       Amount of SetToken to be redeemed
     *
     * @return sumEth               The total amount of Ether that would be obtained from liquidating the SetTokens
     * @return amountComponents     An array containing the amount of SetToken component to be liquidated
     * @return exchanges            An array containing the exchange on which to liquidate the SetToken components
     */
    function _getAmountETHForRedemption(ISetToken _setToken, address[] memory _components, uint256 _amountSetToken)
        internal
        view
        returns (uint256, uint256[] memory, Exchange[] memory)
    {
        uint256 sumEth = 0;
        uint256 amountEth = 0;

        uint256[] memory amountComponents = new uint256[](_components.length);
        Exchange[] memory exchanges = new Exchange[](_components.length);

        for (uint256 i = 0; i < _components.length; i++) {

            // Check that the component does not have external positions
            require(
                _setToken.getExternalPositionModules(_components[i]).length == 0,
                "ExchangeIssuance: EXTERNAL_POSITIONS_NOT_ALLOWED"
            );

            uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(_components[i]));
            amountComponents[i] = unit.preciseMul(_amountSetToken);

            // get maximum amount of ETH received for a given amount of SetToken component
            (amountEth, exchanges[i], ) = _getMaxTokenForExactToken(amountComponents[i], _components[i], WETH);
            sumEth = sumEth.add(amountEth);
        }
        return (sumEth, amountComponents, exchanges);
    }

    /**
     * Returns an estimated amount of SetToken that can be issued given an amount of input ERC20 token.
     *
     * @param _setToken             Address of the SetToken to be issued
     * @param _components           An array containing the addresses of the SetToken components
     * @param _amountEth            Total amount of ether available for the purchase of SetToken components
     *
     * @return setIssueAmount       The max amount of SetTokens that can be issued
     * @return amountEthIn          An array containing the amount ether required to purchase each SetToken component
     * @return exchanges            An array containing the exchange on which to purchase the SetToken components
     */
    function _getSetIssueAmountForETH(ISetToken _setToken, address[] memory _components, uint256 _amountEth)
        internal
        view
        returns (uint256 setIssueAmount, uint256[] memory amountEthIn, Exchange[] memory exchanges)
    {
        uint256 sumEth;
        uint256[] memory unitAmountEthIn;
        uint256[] memory unitAmountComponents;
        address[] memory pairAddresses;
        (
            sumEth,
            unitAmountEthIn,
            exchanges,
            unitAmountComponents,
            pairAddresses
        ) = _getAmountETHForIssuance(_setToken, _components, PreciseUnitMath.preciseUnit());

        setIssueAmount = PreciseUnitMath.maxUint256();
        amountEthIn = new uint256[](_components.length);

        for (uint256 i = 0; i < _components.length; i++) {

            amountEthIn[i] = unitAmountEthIn[i].mul(_amountEth).div(sumEth);

            uint256 amountComponent;
            if (exchanges[i] == Exchange.None) {
                amountComponent = amountEthIn[i];
            } else {
                (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(pairAddresses[i], WETH, _components[i]);
                amountComponent = UniSushiV2Library.getAmountOut(amountEthIn[i], reserveIn, reserveOut);
            }
            setIssueAmount = Math.min(amountComponent.preciseDiv(unitAmountComponents[i]), setIssueAmount);
        }
        return (setIssueAmount, amountEthIn, exchanges);
    }

    /**
     * Swaps a given amount of an ERC20 token for WETH for the best price on Uniswap/Sushiswap.
     *
     * @param _token    Address of the ERC20 token to be swapped for WETH
     * @param _amount   Amount of ERC20 token to be swapped
     *
     * @return          Amount of WETH received after the swap
     */
    function _swapTokenForWETH(IERC20 _token, uint256 _amount) internal returns (uint256) {
        (, Exchange exchange, ) = _getMaxTokenForExactToken(_amount, address(_token), WETH);
        IUniswapV2Router02 router = _getRouter(exchange);
        _safeApprove(_token, address(router), _amount);
        return _swapExactTokensForTokens(exchange, address(_token), WETH, _amount);
    }

    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountIn     The amount of input token to be spent
     *
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
     *
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
     *
     * @return              The min amount of tokenA required across both exchanges
     * @return              The Exchange on which minimum amount of tokenA is required
     * @return              The pair address of the uniswap/sushiswap pool containing _tokenA and _tokenB
     */
    function _getMinTokenForExactToken(uint256 _amountOut, address _tokenA, address _tokenB) internal view returns (uint256, Exchange, address) {
        if (_tokenA == _tokenB) {
            return (_amountOut, Exchange.None, ETH_ADDRESS);
        }

        uint256 maxIn = PreciseUnitMath.maxUint256() ;
        uint256 uniTokenIn = maxIn;
        uint256 sushiTokenIn = maxIn;

        address uniswapPair = _getPair(uniFactory, _tokenA, _tokenB);
        if (uniswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(uniswapPair, _tokenA, _tokenB);
            // Prevent subtraction overflow by making sure pool reserves are greater than swap amount
            if (reserveOut > _amountOut) {
                uniTokenIn = UniSushiV2Library.getAmountIn(_amountOut, reserveIn, reserveOut);
            }
        }

        address sushiswapPair = _getPair(sushiFactory, _tokenA, _tokenB);
        if (sushiswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(sushiswapPair, _tokenA, _tokenB);
            // Prevent subtraction overflow by making sure pool reserves are greater than swap amount
            if (reserveOut > _amountOut) {
                sushiTokenIn = UniSushiV2Library.getAmountIn(_amountOut, reserveIn, reserveOut);
            }
        }

        // Fails if both the values are maxIn
        require(!(uniTokenIn == maxIn && sushiTokenIn == maxIn), "ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        return (uniTokenIn <= sushiTokenIn) ? (uniTokenIn, Exchange.Uniswap, uniswapPair) : (sushiTokenIn, Exchange.Sushiswap, sushiswapPair);
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
     * @return              The pair address of the uniswap/sushiswap pool containing _tokenA and _tokenB
     */
    function _getMaxTokenForExactToken(uint256 _amountIn, address _tokenA, address _tokenB) internal view returns (uint256, Exchange, address) {
        if (_tokenA == _tokenB) {
            return (_amountIn, Exchange.None, ETH_ADDRESS);
        }

        uint256 uniTokenOut = 0;
        uint256 sushiTokenOut = 0;

        address uniswapPair = _getPair(uniFactory, _tokenA, _tokenB);
        if(uniswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(uniswapPair, _tokenA, _tokenB);
            uniTokenOut = UniSushiV2Library.getAmountOut(_amountIn, reserveIn, reserveOut);
        }

        address sushiswapPair = _getPair(sushiFactory, _tokenA, _tokenB);
        if(sushiswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(sushiswapPair, _tokenA, _tokenB);
            sushiTokenOut = UniSushiV2Library.getAmountOut(_amountIn, reserveIn, reserveOut);
        }

        // Fails if both the values are 0
        require(!(uniTokenOut == 0 && sushiTokenOut == 0), "ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        return (uniTokenOut >= sushiTokenOut) ? (uniTokenOut, Exchange.Uniswap, uniswapPair) : (sushiTokenOut, Exchange.Sushiswap, sushiswapPair);
    }

    /**
     * Returns the pair address for on a given DEX.
     *
     * @param _factory   The factory to address
     * @param _tokenA    The address of tokenA
     * @param _tokenB    The address of tokenB
     *
     * @return           The pair address (Note: address(0) is returned by default if the pair is not available on that DEX)
     */
    function _getPair(address _factory, address _tokenA, address _tokenB) internal view returns (address) {
        return IUniswapV2Factory(_factory).getPair(_tokenA, _tokenB);
    }

    /**
     * Returns the router address of a given exchange.
     *
     * @param _exchange     The Exchange whose router address is needed
     *
     * @return              IUniswapV2Router02 router of the given exchange
     */
     function _getRouter(Exchange _exchange) internal view returns(IUniswapV2Router02) {
         return (_exchange == Exchange.Uniswap) ? uniRouter : sushiRouter;
     }

}
