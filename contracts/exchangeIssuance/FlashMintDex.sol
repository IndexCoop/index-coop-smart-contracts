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
 * @author Index Cooperative
 * @notice Part of a family of contracts that allows users to issue and redeem SetTokens with a single input/output token (ETH/ERC20).
 * This contract supports SetTokens whose components have liquidity against WETH on the exchanges found in the DEXAdapterV2 library, and
 * does not depend on the use of off-chain APIs for swap quotes.
 * The FlashMint SDK (https://github.com/IndexCoop/flash-mint-sdk) provides a unified interface for this and other FlashMint contracts.
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
        ISetToken setToken;                         // The address of the SetToken to be issued/redeemed
        uint256 amountSetToken;                     // The amount of SetTokens to issue/redeem
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

    modifier isValidModuleAndSet(address _issuanceModule, address _setToken) {
        require(
            setController.isModule(_issuanceModule) && setController.isSet(_setToken) ||
            indexController.isModule(_issuanceModule) && indexController.isSet(_setToken),
            "FlashMint: INVALID ISSUANCE MODULE OR SET TOKEN"
        );
         _;
    }

    /**
     * Initializes the contract with controller and DEXAdapterV2 library addresses.
     *
     * @param _setController    Address of the legacy Set Protocol controller contract
     * @param _indexController  Address of the Index Coop controller contract
     * @param _dexAddresses     Struct containing addresses for the DEXAdapterV2 library
     */
    constructor(
        IController _setController,
        IController _indexController,
        DEXAdapterV2.Addresses memory _dexAddresses
    )
        public
    {
        setController = _setController;
        indexController = _indexController;
        dexAdapter = _dexAddresses;
        WETH = _dexAddresses.weth;
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
        require(msg.sender == WETH, "FlashMint: DIRECT DEPOSITS NOT ALLOWED");
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
     * @return                            Amount of input tokens required to perform the issuance
     */
    function getIssueExactSet(
        IssueRedeemParams memory _issueParams,
        DEXAdapterV2.SwapData memory _swapDataInputTokenToWeth
    )
        external
        returns (uint256)
    {
        uint256 totalWethNeeded = _getWethCostsForIssue(_issueParams);
        return dexAdapter.getAmountIn(_swapDataInputTokenToWeth, totalWethNeeded);
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
     * @return                             Amount of output tokens expected after performing redemption
     */
    function getRedeemExactSet(
        IssueRedeemParams memory _redeemParams,
        DEXAdapterV2.SwapData memory _swapDataWethToOutputToken
    )
        external
        returns (uint256)
    {
        uint256 totalWethReceived = _getWethReceivedForRedeem(_redeemParams);
        return dexAdapter.getAmountOut(_swapDataWethToOutputToken, totalWethReceived);
    }

    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    * Leftover ETH is returned to the caller if the amount is above _minEthRefund,
    * otherwise it is kept by the contract in the form of WETH to save gas.
    *
    * @param _issueParams   Struct containing addresses, amounts, and swap data for issuance
    * @param _minEthRefund  Minimum amount of unused ETH to be returned to the caller. Set to 0 to return any leftover amount.
    *
    * @return ethSpent      Amount of ETH spent
    */
    function issueExactSetFromETH(IssueRedeemParams memory _issueParams, uint256 _minEthRefund)
        external
        payable
        isValidModuleAndSet(_issueParams.issuanceModule, address(_issueParams.setToken))
        nonReentrant
        returns (uint256 ethSpent)
    {
        require(msg.value > 0, "FlashMint: NO ETH SENT");

        IWETH(WETH).deposit{value: msg.value}();

        uint256 ethUsedForIssuance = _issueExactSetFromWeth(_issueParams);

        uint256 leftoverETH = msg.value.sub(ethUsedForIssuance);
        if (leftoverETH > _minEthRefund) {
            IWETH(WETH).withdraw(leftoverETH);
            payable(msg.sender).sendValue(leftoverETH);
        }
        ethSpent = msg.value.sub(leftoverETH);

        emit FlashMint(msg.sender, _issueParams.setToken, IERC20(ETH_ADDRESS), ethSpent, _issueParams.amountSetToken);
    }

    /**
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * Leftover funds are swapped back to the payment token and returned to the caller if the value is above _minRefundValueInWeth,
    * otherwise the leftover funds are kept by the contract in the form of WETH to save gas.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    * @param _paymentInfo           Struct containing input token address, max amount to spend, and swap data to trade for WETH
    * @param _minRefundValueInWeth  Minimum value of leftover WETH to be swapped back to input token and returned to the caller. Set to 0 to return any leftover amount.
    *
    * @return paymentTokenSpent     Amount of input token spent
    */
    function issueExactSetFromERC20(IssueRedeemParams memory _issueParams, PaymentInfo memory _paymentInfo, uint256 _minRefundValueInWeth)
        external
        isValidModuleAndSet(_issueParams.issuanceModule, address(_issueParams.setToken))
        nonReentrant
        returns (uint256 paymentTokenSpent)
    {
        _paymentInfo.token.safeTransferFrom(msg.sender, address(this), _paymentInfo.limitAmt);
        uint256 wethReceived = _swapPaymentTokenForWeth(_paymentInfo.token, _paymentInfo.limitAmt, _paymentInfo.swapDataTokenToWeth);

        uint256 wethSpent = _issueExactSetFromWeth(_issueParams);
        require(wethSpent <= wethReceived, "FlashMint: OVERSPENT WETH");
        uint256 leftoverWeth = wethReceived.sub(wethSpent);
        uint256 paymentTokenReturned = 0;

        if (leftoverWeth > _minRefundValueInWeth) {
            paymentTokenReturned = _swapWethForPaymentToken(leftoverWeth, _paymentInfo.token, _paymentInfo.swapDataWethToToken);
            _paymentInfo.token.safeTransfer(msg.sender, paymentTokenReturned);
        }

        paymentTokenSpent = _paymentInfo.limitAmt.sub(paymentTokenReturned);

        emit FlashMint(msg.sender, _issueParams.setToken, _paymentInfo.token, paymentTokenSpent, _issueParams.amountSetToken);
    }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams   Struct containing addresses, amounts, and swap data for issuance
     *
     * @return ethReceived      Amount of ETH received
     */
    function redeemExactSetForETH(IssueRedeemParams memory _redeemParams, uint256 _minEthReceive)
        external
        isValidModuleAndSet(_redeemParams.issuanceModule, address(_redeemParams.setToken))
        nonReentrant
        returns (uint256 ethReceived)
    {
        _redeem(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

        ethReceived = _sellComponentsForWeth(_redeemParams);
        require(ethReceived >= _minEthReceive, "FlashMint: INSUFFICIENT WETH RECEIVED");

        IWETH(WETH).withdraw(ethReceived);
        payable(msg.sender).sendValue(ethReceived);

        emit FlashRedeem(msg.sender, _redeemParams.setToken, IERC20(ETH_ADDRESS), _redeemParams.amountSetToken, ethReceived);
        return ethReceived;
    }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams             Struct containing token addresses, amounts, and swap data for issuance
     *
     * @return outputTokenReceived      Amount of output token received
     */
    function redeemExactSetForERC20(IssueRedeemParams memory _redeemParams, PaymentInfo memory _paymentInfo)
        external
        isValidModuleAndSet(_redeemParams.issuanceModule, address(_redeemParams.setToken))
        nonReentrant
        returns (uint256 outputTokenReceived)
    {
        _redeem(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

        uint256 wethReceived = _sellComponentsForWeth(_redeemParams);
        outputTokenReceived = _swapWethForPaymentToken(wethReceived, _paymentInfo.token, _paymentInfo.swapDataWethToToken);
        require(outputTokenReceived >= _paymentInfo.limitAmt, "FlashMint: INSUFFICIENT OUTPUT AMOUNT");

        _paymentInfo.token.safeTransfer(msg.sender, outputTokenReceived);

        emit FlashRedeem(msg.sender, _redeemParams.setToken, _paymentInfo.token, _redeemParams.amountSetToken, outputTokenReceived);
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
    function _swapPaymentTokenForWeth(
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
    * @return totalWethSpent        Amount of WETH used to buy components
    */
    function _issueExactSetFromWeth(IssueRedeemParams memory _issueParams) internal returns (uint256 totalWethSpent)
    {
        totalWethSpent = _buyComponentsWithWeth(_issueParams);
        IBasicIssuanceModule(_issueParams.issuanceModule).issue(_issueParams.setToken, _issueParams.amountSetToken, msg.sender);
    }

    /**
     * Acquires SetToken components by executing swaps whose callata is passed in _componentSwapData.
     * Acquired components are then used to issue the SetTokens.
     *
     * @param _issueParams          Struct containing addresses, amounts, and swap data for issuance
     *
     * @return totalWethSpent        Total amount of WETH spent to buy components
     */
    function _buyComponentsWithWeth(IssueRedeemParams memory _issueParams) internal returns (uint256 totalWethSpent) {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(
            _issueParams.issuanceModule,
            _issueParams.isDebtIssuance,
            _issueParams.setToken,
            _issueParams.amountSetToken
        );
        require(components.length == _issueParams.componentSwapData.length, "FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");

        totalWethSpent = 0;
        for (uint256 i = 0; i < components.length; i++) {
            require(_issueParams.setToken.getExternalPositionModules(components[i]).length == 0, "FlashMint: EXTERNAL POSITION MODULES NOT SUPPORTED");
            uint256 wethSold = dexAdapter.swapTokensForExactTokens(componentUnits[i], type(uint256).max, _issueParams.componentSwapData[i]);
            totalWethSpent = totalWethSpent.add(wethSold);
        }
    }

    /**
     * Calculates the amount of WETH required to buy all components required for issuance.
     *
     * @param _issueParams     Struct containing addresses, amounts, and swap data for issuance
     *
     * @return totalWethCosts  Amount of WETH needed to swap into component units required for issuance
     */
    function _getWethCostsForIssue(IssueRedeemParams memory _issueParams)
        internal
        returns (uint256 totalWethCosts)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(
            _issueParams.issuanceModule,
            _issueParams.isDebtIssuance,
            _issueParams.setToken,
            _issueParams.amountSetToken
        );

        require(components.length == _issueParams.componentSwapData.length, "FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");

        totalWethCosts = 0;
        for (uint256 i = 0; i < components.length; i++) {
            if (components[i] == address(WETH)) {
                totalWethCosts += componentUnits[i];
            } else {
                totalWethCosts += dexAdapter.getAmountIn(
                    _issueParams.componentSwapData[i],
                    componentUnits[i]
                );
            }
        }
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
     * @return totalWethReceived  Total amount of WETH received after liquidating all SetToken components
     */
    function _sellComponentsForWeth(IssueRedeemParams memory _redeemParams)
        internal
        returns (uint256 totalWethReceived)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(
            _redeemParams.issuanceModule,
            _redeemParams.isDebtIssuance,
            _redeemParams.setToken,
            _redeemParams.amountSetToken
        );
        require(components.length == _redeemParams.componentSwapData.length, "FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");

        totalWethReceived = 0;
        for (uint256 i = 0; i < components.length; i++) {
            require(_redeemParams.setToken.getExternalPositionModules(components[i]).length == 0, "FlashMint: EXTERNAL POSITION MODULES NOT SUPPORTED");
            uint256 wethBought = dexAdapter.swapExactTokensForTokens(componentUnits[i], 0, _redeemParams.componentSwapData[i]);
            totalWethReceived = totalWethReceived.add(wethBought);
        }
    }

    /**
     * Calculates the amount of WETH received for selling off all components after redemption.
     *
     * @param _redeemParams       Struct containing addresses, amounts, and swap data for redemption
     *
     * @return totalWethReceived  Amount of WETH received after swapping all component tokens
     */
    function _getWethReceivedForRedeem(IssueRedeemParams memory _redeemParams)
        internal
        returns (uint256 totalWethReceived)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(
            _redeemParams.issuanceModule,
            _redeemParams.isDebtIssuance,
            _redeemParams.setToken,
            _redeemParams.amountSetToken
        );

        require(components.length == _redeemParams.componentSwapData.length, "FlashMint: INVALID NUMBER OF COMPONENTS IN SWAP DATA");

        totalWethReceived = 0;
        for (uint256 i = 0; i < components.length; i++) {
            if (components[i] == address(WETH)) {
                totalWethReceived += componentUnits[i];
            } else {
                totalWethReceived += dexAdapter.getAmountOut(
                    _redeemParams.componentSwapData[i],
                    componentUnits[i]
                );
            }
        }
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
