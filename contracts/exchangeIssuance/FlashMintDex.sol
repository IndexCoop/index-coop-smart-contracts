/*
    Copyright 2024 Index Cooperative

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
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { DEXAdapterV2 } from "./DEXAdapterV2.sol";

/**
 * @title FlashMintDex
 */
contract FlashMintDex is Ownable, ReentrancyGuard {
    using DEXAdapterV2 for DEXAdapterV2.Addresses;
    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Constants ============== */

    // Placeholder address to identify ETH where it is treated as if it was an ERC20 token
    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    address public immutable WETH;
    IController public immutable setController;
    IController public immutable indexController;
    DEXAdapterV2.Addresses public dexAdapter;

    /* ============ Structs ============ */
    struct IssueRedeemParams {
        ISetToken setToken;                         // The address of the SetToken to be issued
        uint256 amountSetToken;                     // The amount of SetTokens to issue
        DEXAdapterV2.SwapData[] componentSwapData;  // The swap data from WETH to each component token
        address issuanceModule;                     // The address of the issuance module to be used
        bool isDebtIssuance;                        // A flag indicating whether the issuance module is a debt issuance module
    }

    struct PaymentInfo {
        IERC20 token;                               // The address of the input/output token for issuance/redemption
        uint256 limitAmt;                           // Max/min amount of payment token spent/received
        DEXAdapterV2.SwapData swapDataTokenToWeth;  // The swap data from payment token to WETH
        DEXAdapterV2.SwapData swapDataWethToToken;  // The swap data from WETH back to payment token
    }

    /* ============ Events ============ */

    event FlashMint(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event FlashRedeem(
        address indexed _recipient,     // The recipient adress of the output tokens obtained for redemption
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,   // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier isValidModule(address _issuanceModule) {
        require(setController.isModule(_issuanceModule) || indexController.isModule(_issuanceModule), "FlashMint: INVALID ISSUANCE MODULE");
         _;
    }

    constructor(
        address _weth,
        IController _setController,
        IController _indexController,
        DEXAdapterV2.Addresses memory _dexAddresses
    )
        public
    {
        setController = _setController;
        indexController = _indexController;
        dexAdapter = _dexAddresses;
        WETH = _weth;
    }

    /* ============ External Functions ============ */

    /**
     * Withdraw slippage to selected address
     *
     * @param _tokens    Addresses of tokens to withdraw, specifiy ETH_ADDRESS to withdraw ETH
     * @param _to        Address to send the tokens to
     */
    function withdrawTokens(IERC20[] calldata _tokens, address payable _to) external onlyOwner payable {
        for(uint256 i = 0; i < _tokens.length; i++) {
            if(address(_tokens[i]) == ETH_ADDRESS){
                _to.sendValue(address(this).balance);
            }
            else{
                _tokens[i].safeTransfer(_to, _tokens[i].balanceOf(address(this)));
            }
        }
    }

    receive() external payable {
        // required for weth.withdraw() to work properly
        require(msg.sender == WETH, "FlashMint: Direct deposits not allowed");
    }

    /* ============ Public Functions ============ */


    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a SetToken during a
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     * @param _spender  Address of the spender which will be approved to spend token. (Must be a whitlisted issuance module)
     */
    function approveToken(IERC20 _token, address _spender) public  isValidModule(_spender) {
        _safeApprove(_token, _spender, type(uint256).max);
    }

    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     * @param _spender   Address of the spender which will be approved to spend token. (Must be a whitlisted issuance module)
     */
    function approveTokens(IERC20[] calldata _tokens, address _spender) external {
        for (uint256 i = 0; i < _tokens.length; i++) {
            approveToken(_tokens[i], _spender);
        }
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a SetToken. This function need to be called only once before the first time
     * this smart contract is used on any particular SetToken.
     *
     * @param _setToken          Address of the SetToken being initialized
     * @param _issuanceModule    Address of the issuance module which will be approved to spend component tokens.
     */
    function approveSetToken(ISetToken _setToken, address _issuanceModule) external {
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            approveToken(IERC20(components[i]), _issuanceModule);
        }
    }

    /**
     * Gets the amount of input token required to issue a given quantity of set token with the provided issuance params.
     * This function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter contract
     *
     * @param _issueParams                Struct containing addresses, amounts, and swap data for issuance
     * @param _swapDataInputTokenToWeth   Swap data to trade input token for WETH. Use empty swap data if input token is ETH or WETH.
     *
     * @return totalEthNeeded  Amount of input tokens required to perfrom the issuance
     */
    function getIssueExactSet(
        IssueRedeemParams memory _issueParams,
        DEXAdapterV2.SwapData memory _swapDataInputTokenToWeth
    )
        external
        returns (uint256)
    {
        uint256 totalEthNeeded = 0;
        (,, uint256[] memory wethCosts) = _getWethCostsPerComponent(_issueParams);

        for (uint256 i = 0; i < wethCosts.length; i++) {
            totalEthNeeded += wethCosts[i];
        }
        return dexAdapter.getAmountIn(_swapDataInputTokenToWeth, totalEthNeeded);
    }

    /**
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    * @param _paymentInfo           Struct containing input token address, max amount to spend, and swap data to trade for WETH
    *
    * @return excessPaymentTokenAmt   Amount of input token returned to the caller
    */
    function issueExactSetFromToken(IssueRedeemParams memory _issueParams, PaymentInfo memory _paymentInfo)
        external
        isValidModule(_issueParams.issuanceModule)
        nonReentrant
        returns (uint256 excessPaymentTokenAmt)
    {
        _paymentInfo.token.safeTransferFrom(msg.sender, address(this), _paymentInfo.limitAmt);
        uint256 wethReceived = _swapPaymentTokenForWETH(_paymentInfo.token, _paymentInfo.limitAmt, _paymentInfo.swapDataTokenToWeth);

        uint256 totalEthSold = _issueExactSetFromWeth(_issueParams);
        require(totalEthSold <= wethReceived, "FlashMint: OVERSPENT WETH");
        // TODO: returnExcessPaymentToken() function
        uint256 unusedWeth = wethReceived.sub(totalEthSold);

        if (unusedWeth > 0) {
            excessPaymentTokenAmt = _swapWethForPaymentToken(unusedWeth, _paymentInfo.token, _paymentInfo.swapDataWethToToken);
            _paymentInfo.token.safeTransfer(msg.sender, excessPaymentTokenAmt);
        }

        uint256 paymentTokenSold = _paymentInfo.limitAmt.sub(excessPaymentTokenAmt);

        emit FlashMint(msg.sender, _issueParams.setToken, _paymentInfo.token, paymentTokenSold, _issueParams.amountSetToken);
    }

    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    */
    function issueExactSetFromETH(IssueRedeemParams memory _issueParams)
        external
        payable
        isValidModule(_issueParams.issuanceModule)
        nonReentrant
        returns (uint256)
    {
        require(msg.value > 0, "FlashMint: NO ETH SENT");

        IWETH(WETH).deposit{value: msg.value}();

        uint256 totalEthSold = _issueExactSetFromWeth(_issueParams);

        require(totalEthSold <= msg.value, "FlashMint: OVERSPENT ETH");

        uint256 amountEthReturn = msg.value.sub(totalEthSold);
        if (amountEthReturn > 0) {
            IWETH(WETH).withdraw(amountEthReturn);
            payable(msg.sender).sendValue(amountEthReturn);
        }

        emit FlashMint(msg.sender, _issueParams.setToken, IERC20(ETH_ADDRESS), totalEthSold, _issueParams.amountSetToken);
    }

    /**
     * Gets the amount of specified payment token expected to be received after redeeming 
     * a given quantity of set token with the provided redemption params.
     * This function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter contract
     *
     * @param _redeemParams                Struct containing addresses, amounts, and swap data for redemption
     * @param _swapDataWethToOutputToken   Swap data to trade WETH for output token. Use empty swap data if output token is ETH or WETH. 
     *
     * @return                             the amount of output tokens expected after performing redemption
     */
    function getRedeemExactSet(
        IssueRedeemParams memory _redeemParams,
        DEXAdapterV2.SwapData memory _swapDataWethToOutputToken
    )
        external
        returns (uint256)
    {
        uint256 totalWethReceived = 0;
        (,, uint256[] memory wethReceived) = _getWethReceivedPerComponent(_redeemParams);

        for (uint256 i = 0; i < wethReceived.length; i++) {
            totalWethReceived += wethReceived[i];
        }
        return dexAdapter.getAmountOut(_swapDataWethToOutputToken, totalWethReceived);
    }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams         Struct containing token addresses, amounts, and swap data for issuance
     */
    function redeemExactSetForToken(IssueRedeemParams memory _redeemParams, PaymentInfo memory _paymentInfo)
        external
        isValidModule(_redeemParams.issuanceModule)
        nonReentrant
        returns (uint256)
    {
        _redeem(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

        uint256 wethReceived = _sellComponentsForWeth(_redeemParams);
        uint256 outputAmount = _swapWethForPaymentToken(wethReceived, _paymentInfo.token, _paymentInfo.swapDataWethToToken);
        require(outputAmount >= _paymentInfo.limitAmt, "FlashMint: INSUFFICIENT OUTPUT AMOUNT");

        _paymentInfo.token.safeTransfer(msg.sender, outputAmount);

        emit FlashRedeem(msg.sender, _redeemParams.setToken, _paymentInfo.token, _redeemParams.amountSetToken, outputAmount);
    }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams   Struct containing addresses, amounts, and swap data for issuance
     *
     * @return ethAmount      The amount of ETH received.
     */
    function redeemExactSetForETH(IssueRedeemParams memory _redeemParams, uint256 _minEthReceive)
        external
        isValidModule(_redeemParams.issuanceModule)
        nonReentrant
        returns (uint256)
    {
        _redeem(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

        uint256 ethAmount = _sellComponentsForWeth(_redeemParams);
        require(ethAmount >= _minEthReceive, "FlashMint: INSUFFICIENT WETH RECEIVED");

        IWETH(WETH).withdraw(ethAmount);
        payable(msg.sender).sendValue(ethAmount);

        emit FlashRedeem(msg.sender, _redeemParams.setToken, IERC20(ETH_ADDRESS), _redeemParams.amountSetToken, ethAmount);
        return ethAmount;
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
            _token.safeIncreaseAllowance(_spender, type(uint256).max - allowance);
        }
    }

    /**
     * Swaps a given amount of an ERC20 token for WETH using the DEXAdapter.
     *
     * @param _paymentToken        Address of the ERC20 payment token
     * @param _paymentTokenAmount  Amount of payment token to swap
     * @param _swapData            Swap data from input token to WETH
     *
     * @return amountWethOut       Amount of WETH received after the swap
     */
    function _swapPaymentTokenForWETH(
        IERC20 _paymentToken,
        uint256 _paymentTokenAmount,
        DEXAdapterV2.SwapData memory _swapData
    )
        internal 
        returns (uint256 amountWethOut)
    {
        if (_paymentToken == IERC20(WETH)) {
            return _paymentTokenAmount;
        }

        return dexAdapter.swapExactTokensForTokens(
            _paymentTokenAmount,
            0,
            _swapData
        );
    }

    /**
     * Swaps a given amount of an WETH for ERC20 using the DEXAdapter.
     *
     * @param _wethAmount       Amount of WETH to swap for input token
     * @param _paymentToken     Address of the input token
     * @param _swapData         Swap data from WETH to input token
     *
     * @return amountOut        Amount of ERC20 received after the swap
     */
    function _swapWethForPaymentToken(uint256 _wethAmount, IERC20 _paymentToken, DEXAdapterV2.SwapData memory _swapData)
        internal 
        returns (uint256 amountOut)
    {
        // If the payment token is equal to WETH we don't have to trade
        if (_paymentToken == IERC20(WETH)) {
            return _wethAmount;
        }

        return dexAdapter.swapExactTokensForTokens(
            _wethAmount,
            0,
            _swapData
        );
    }

    /**
    * Issues an exact amount of SetTokens for given amount of WETH.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    *
    * @return totalWethSold         Amount of WETH used to buy components
    */
    function _issueExactSetFromWeth(IssueRedeemParams memory _issueParams) internal returns (uint256 totalWethSold)
    {
        totalWethSold = _buyComponentsWithWeth(_issueParams);
        IBasicIssuanceModule(_issueParams.issuanceModule).issue(_issueParams.setToken, _issueParams.amountSetToken, msg.sender);
    }

    /**
     * Acquires SetToken components by executing swaps whose callata is passed in _componentSwapData.
     * Acquired components are then used to issue the SetTokens.
     *
     * @param _issueParams          Struct containing addresses, amounts, and swap data for issuance
     *
     * @return totalWethSold        Total amount of WETH spent to buy components
     */
    function _buyComponentsWithWeth(IssueRedeemParams memory _issueParams) internal returns (uint256 totalWethSold) {
        (
            address[] memory components, 
            uint256[] memory componentUnits,
            uint256[] memory wethCosts
        ) = _getWethCostsPerComponent(_issueParams);

        totalWethSold = 0;
        for (uint256 i = 0; i < wethCosts.length; i++) {
            if (components[i] == address(WETH)) {
                totalWethSold = totalWethSold.add(wethCosts[i]);
            } else {
                uint256 wethSpent = dexAdapter.swapTokensForExactTokens(componentUnits[i], wethCosts[i], _issueParams.componentSwapData[i]);
                totalWethSold = totalWethSold.add(wethSpent);
            }
        }
    }

    function _getWethCostsPerComponent(IssueRedeemParams memory _issueParams)
        internal
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(
            _issueParams.issuanceModule,
            _issueParams.isDebtIssuance,
            _issueParams.setToken,
            _issueParams.amountSetToken
        );

        require(components.length == _issueParams.componentSwapData.length, "FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");

        uint256[] memory wethCosts = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            if (components[i] == address(WETH)) {
                wethCosts[i] = componentUnits[i];
            } else {
                wethCosts[i] = dexAdapter.getAmountIn(
                    _issueParams.componentSwapData[i],
                    componentUnits[i]
                );
            }
        }
        return (components, componentUnits, wethCosts);
    }

    /**
     * Transfers given amount of set token from the sender and redeems it for underlying components.
     * Obtained component tokens are sent to this contract. 
     *
     * @param _setToken     Address of the SetToken to be redeemed
     * @param _amount       Amount of SetToken to be redeemed
     */
    function _redeem(ISetToken _setToken, uint256 _amount, address _issuanceModule) internal returns (uint256) {
        _setToken.safeTransferFrom(msg.sender, address(this), _amount);
        IBasicIssuanceModule(_issuanceModule).redeem(_setToken, _amount, address(this));
    }

    /**
     * Sells redeemed components for WETH.
     *
     * @param _redeemParams     Struct containing addresses, amounts, and swap data for issuance
     *
     * @return totalWethBought  Total amount of WETH received after liquidating all SetToken components
     */
    function _sellComponentsForWeth(IssueRedeemParams memory _redeemParams)
        internal
        returns (uint256 totalWethBought)
    {
        (
            address[] memory components, 
            uint256[] memory componentUnits,
            uint256[] memory wethReceived
        ) = _getWethReceivedPerComponent(_redeemParams);

        totalWethBought = 0;
        for (uint256 i = 0; i < wethReceived.length; i++) {
            if (components[i] == address(WETH)) {
                totalWethBought = totalWethBought.add(wethReceived[i]);
            } else {
                uint256 wethSpent = dexAdapter.swapExactTokensForTokens(componentUnits[i], wethReceived[i], _redeemParams.componentSwapData[i]);
                totalWethBought = totalWethBought.add(wethSpent);
            }
        }
    }

    function _getWethReceivedPerComponent(IssueRedeemParams memory _redeemParams)
        internal
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(
            _redeemParams.issuanceModule,
            _redeemParams.isDebtIssuance,
            _redeemParams.setToken,
            _redeemParams.amountSetToken
        );

        require(components.length == _redeemParams.componentSwapData.length, "FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");

        uint256[] memory wethReceived = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            if (components[i] == address(WETH)) {
                wethReceived[i] = componentUnits[i];
            } else {
                wethReceived[i] = dexAdapter.getAmountOut(
                    _redeemParams.componentSwapData[i],
                    componentUnits[i]
                );
            }
        }
        return (components, componentUnits, wethReceived);
    }

    /**
     * Returns component positions required for issuance 
     *
     * @param _issuanceModule    Address of issuance Module to use 
     * @param _isDebtIssuance    Flag indicating wether given issuance module is a debt issuance module
     * @param _setToken          Set token to issue
     * @param _amountSetToken    Amount of set token to issue
     */
    function getRequiredIssuanceComponents(address _issuanceModule, bool _isDebtIssuance, ISetToken _setToken, uint256 _amountSetToken) public view returns(address[] memory components, uint256[] memory positions) {
        if(_isDebtIssuance) { 
            (components, positions, ) = IDebtIssuanceModule(_issuanceModule).getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);
        }
        else {
            (components, positions) = IBasicIssuanceModule(_issuanceModule).getRequiredComponentUnitsForIssue(_setToken, _amountSetToken);
        }
    }

    /**
     * Returns component positions required for Redemption 
     *
     * @param _issuanceModule    Address of issuance Module to use 
     * @param _isDebtIssuance    Flag indicating wether given issuance module is a debt issuance module
     * @param _setToken          Set token to issue
     * @param _amountSetToken    Amount of set token to issue
     */
    function getRequiredRedemptionComponents(address _issuanceModule, bool _isDebtIssuance, ISetToken _setToken, uint256 _amountSetToken) public view returns(address[] memory components, uint256[] memory positions) {
        if(_isDebtIssuance) { 
            (components, positions, ) = IDebtIssuanceModule(_issuanceModule).getRequiredComponentRedemptionUnits(_setToken, _amountSetToken);
        }
        else {
            components = _setToken.getComponents();
            positions = new uint256[](components.length);
            for(uint256 i = 0; i < components.length; i++) {
                uint256 unit = uint256(_setToken.getDefaultPositionRealUnit(components[i]));
                positions[i] = unit.preciseMul(_amountSetToken);
            }
        }
    }
}
