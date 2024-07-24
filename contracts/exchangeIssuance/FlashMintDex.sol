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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
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
    DEXAdapterV2.Addresses public dexAdapter;

    /* ============ Structs ============ */
    struct IssueParams {
        ISetToken setToken;                // The address of the SetToken to be issued
        IERC20 inputToken;                 // The address of the input token
        uint256 amountSetToken;            // The amount of SetTokens to issue
        uint256 maxAmountInputToken;       // The maximum amount of input tokens to be used to issue SetTokens
        DEXAdapterV2.SwapData[] swapData;  // The swap data from input token to each component token
        address issuanceModule;            // The address of the issuance module to be used
        bool isDebtIssuance;               // A flag indicating whether the issuance module is a debt issuance module
    }

    struct RedeemParams {
        ISetToken setToken;                // The address of the SetToken to be redeemed
        IERC20 outputToken;                // The address of the output token
        uint256 amountSetToken;            // The amount of SetTokens to redeem
        uint256 minOutputReceive;          // The minimum amount of output tokens to receive
        DEXAdapterV2.SwapData[] swapData;  // The swap data from each component token to the output token
        address issuanceModule;            // The address of the issuance module to be used
        bool isDebtIssuance;               // A flag indicating whether the issuance module is a debt issuance module
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
        IERC20 indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier isValidModule(address _issuanceModule) {
        require(setController.isModule(_issuanceModule), "FlashMint: INVALID ISSUANCE MODULE");
         _;
    }

    constructor(
        address _weth,
        IController _setController,
        DEXAdapterV2.Addresses memory _dexAddresses
    )
        public
    {
        setController = _setController;
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
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    *
    * @return totalInputTokenSold   Amount of input token spent for issuance
    */
    function issueExactSetFromToken(IssueParams memory _issueParams)
        isValidModule(_issueParams.issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {

        _issueParams.inputToken.safeTransferFrom(msg.sender, address(this), _issueParams.maxAmountInputToken);

        uint256 totalInputTokenSold = _buyComponentsForInputToken(_issueParams);
        require(totalInputTokenSold <= _issueParams.maxAmountInputToken, "FlashMint: OVERSPENT TOKEN");

        IBasicIssuanceModule(_issueParams.issuanceModule).issue(_issueParams.setToken, _issueParams.amountSetToken, msg.sender);

        _returnExcessInputToken(_issueParams.inputToken, _issueParams.maxAmountInputToken, totalInputTokenSold);

        emit FlashMint(msg.sender, _issueParams.setToken, _issueParams.inputToken, _issueParams.maxAmountInputToken, _issueParams.amountSetToken);
        return totalInputTokenSold;
    }


    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    * The excess amount of tokens is returned in an equivalent amount of ether.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    *
    * @return amountEthReturn       Amount of ether returned to the caller
    */
    function issueExactSetFromETH(IssueParams memory _issueParams)
        isValidModule(_issueParams.issuanceModule)
        external
        nonReentrant
        payable
        returns (uint256)
    {
        require(_issueParams.inputToken == IERC20(WETH), "FlashMint: INPUT TOKEN MUST BE WETH");
        require(msg.value > 0, "FlashMint: NO ETH SENT");

        IWETH(WETH).deposit{value: msg.value}();

        uint256 totalEthSold = _buyComponentsForInputToken(_issueParams);

        require(totalEthSold <= msg.value, "FlashMint: OVERSPENT ETH");
        IBasicIssuanceModule(_issueParams.issuanceModule).issue(_issueParams.setToken, _issueParams.amountSetToken, msg.sender);

        uint256 amountEthReturn = msg.value.sub(totalEthSold);
        if (amountEthReturn > 0) {
            IWETH(WETH).withdraw(amountEthReturn);
            payable(msg.sender).sendValue(amountEthReturn);
        }

        emit FlashMint(msg.sender, _issueParams.setToken, IERC20(ETH_ADDRESS), totalEthSold, _issueParams.amountSetToken);
        return amountEthReturn; 
    }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams           Struct containing token addresses, amounts, and swap data for issuance
     *
     * @return outputAmount         Amount of output tokens sent to the caller
     */
    function redeemExactSetForToken(RedeemParams memory _redeemParams)
        isValidModule(_redeemParams.issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {
        uint256 outputAmount;
        _redeemExactSet(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

        outputAmount = _sellComponentsForOutputToken(_redeemParams);
        require(outputAmount >= _redeemParams.minOutputReceive, "FlashMint: INSUFFICIENT OUTPUT AMOUNT");

        _redeemParams.outputToken.safeTransfer(msg.sender, outputAmount);

        emit FlashRedeem(msg.sender, _redeemParams.setToken, _redeemParams.outputToken, _redeemParams.amountSetToken, outputAmount);
        return outputAmount;
    }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams   Struct containing addresses, amounts, and swap data for issuance
     *
     * @return ethAmount      The amount of ETH received.
     */
    function redeemExactSetForETH(RedeemParams memory _redeemParams)
        isValidModule(_redeemParams.issuanceModule)
        external
        nonReentrant
        returns (uint256)
    {
        require(_redeemParams.outputToken == IERC20(WETH), "FlashMint: OUTPUT TOKEN MUST BE WETH");
        _redeemExactSet(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

        uint ethAmount = _sellComponentsForOutputToken(_redeemParams);
        require(ethAmount >= _redeemParams.minOutputReceive, "FlashMint: INSUFFICIENT WETH RECEIVED");

        IWETH(WETH).withdraw(ethAmount);
        payable(msg.sender).sendValue(ethAmount);

        emit FlashRedeem(msg.sender, _redeemParams.setToken, IERC20(ETH_ADDRESS), _redeemParams.amountSetToken, ethAmount);
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
            _token.safeIncreaseAllowance(_spender, type(uint256).max - allowance);
        }
    }

    /**
     * Acquires SetToken components by executing swaps whose callata is passed in _swapData.
     * Acquired components are then used to issue the SetTokens.
     *
     * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
     *
     * @return totalInputTokenSold  Total amount of input token spent on this issuance
     */
    function _buyComponentsForInputToken(IssueParams memory _issueParams)
        internal
        returns (uint256 totalInputTokenSold)
    {
        uint256 componentAmountBought;

        (address[] memory components, uint256[] memory componentUnits) = getRequiredIssuanceComponents(
            _issueParams.issuanceModule,
            _issueParams.isDebtIssuance,
            _issueParams.setToken,
            _issueParams.amountSetToken
        );

        uint256 inputTokenBalanceBefore = _issueParams.inputToken.balanceOf(address(this));
        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 units = componentUnits[i];

            // If the component is equal to the input token we don't have to trade
            if (component == address(_issueParams.inputToken)) {
                totalInputTokenSold = totalInputTokenSold.add(units);
                componentAmountBought = units;
            } else {
                uint256 componentBalanceBefore = IERC20(component).balanceOf(address(this));
                dexAdapter.swapTokensForExactTokens(componentAmountBought, totalInputTokenSold, _issueParams.swapData[i]);
                uint256 componentBalanceAfter = IERC20(component).balanceOf(address(this));
                componentAmountBought = componentBalanceAfter.sub(componentBalanceBefore);
                require(componentAmountBought >= units, "ExchangeIssuance: UNDERBOUGHT COMPONENT");
            }
        }
        uint256 inputTokenBalanceAfter = _issueParams.inputToken.balanceOf(address(this));
        totalInputTokenSold = totalInputTokenSold.add(inputTokenBalanceBefore.sub(inputTokenBalanceAfter));
    }

    /**
     * Redeems a given list of SetToken components for given token.
     *
     * @param _redeemParams           Struct containing addresses, amounts, and swap data for issuance
     *
     * @return totalOutputTokenBought  Total amount of output token received after liquidating all SetToken components
     */
    function _sellComponentsForOutputToken(RedeemParams memory _redeemParams)
        internal
        returns (uint256 totalOutputTokenBought)
    {
        (address[] memory components, uint256[] memory componentUnits) = getRequiredRedemptionComponents(
            _redeemParams.issuanceModule,
            _redeemParams.isDebtIssuance,
            _redeemParams.setToken,
            _redeemParams.amountSetToken
        );

        uint256 outputTokenBalanceBefore = _redeemParams.outputToken.balanceOf(address(this));
        for (uint256 i = 0; i < _redeemParams.swapData.length; i++) {
            uint256 maxAmountSell = componentUnits[i];
            uint256 componentAmountSold;

            // If the component is equal to the output token we don't have to trade
            if (components[i] == address(_redeemParams.outputToken)) {
                totalOutputTokenBought = totalOutputTokenBought.add(maxAmountSell);
                componentAmountSold = maxAmountSell;
            } else {
                uint256 componentBalanceBefore = IERC20(components[i]).balanceOf(address(this));
                dexAdapter.swapTokensForExactTokens(componentAmountSold, totalOutputTokenBought, _redeemParams.swapData[i]);
                uint256 componentBalanceAfter = IERC20(components[i]).balanceOf(address(this));
                componentAmountSold = componentBalanceBefore.sub(componentBalanceAfter);
                require(maxAmountSell >= componentAmountSold, "ExchangeIssuance: OVERSOLD COMPONENT");
            }
        }
        uint256 outputTokenBalanceAfter = _redeemParams.outputToken.balanceOf(address(this));
        totalOutputTokenBought = totalOutputTokenBought.add(outputTokenBalanceAfter.sub(outputTokenBalanceBefore));
    }

    /**
     * Transfers given amount of set token from the sender and redeems it for underlying components.
     * Obtained component tokens are sent to this contract. 
     *
     * @param _setToken     Address of the SetToken to be redeemed
     * @param _amount       Amount of SetToken to be redeemed
     */
    function _redeemExactSet(ISetToken _setToken, uint256 _amount, address _issuanceModule) internal returns (uint256) {
        _setToken.safeTransferFrom(msg.sender, address(this), _amount);
        IBasicIssuanceModule(_issuanceModule).redeem(_setToken, _amount, address(this));
    }

    /**
     * Returns excess input token
     *
     * @param _inputToken         Address of the input token to return
     * @param _receivedAmount     Amount received by the caller
     * @param _spentAmount        Amount spent for issuance
     */
    function _returnExcessInputToken(IERC20 _inputToken, uint256 _receivedAmount, uint256 _spentAmount) internal {
        uint256 amountTokenReturn = _receivedAmount.sub(_spentAmount);
        if (amountTokenReturn > 0) {
            _inputToken.safeTransfer(msg.sender,  amountTokenReturn);
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
