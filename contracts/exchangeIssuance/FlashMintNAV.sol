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
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { INAVIssuanceModule } from "../interfaces/INAVIssuanceModule.sol";
import { INAVIssuanceHook } from "../interfaces/INAVIssuanceHook.sol";
import { ISetValuer } from "../interfaces/ISetValuer.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { DEXAdapterV2 } from "./DEXAdapterV2.sol";

/**
 * @title FlashMintNAV
 * @author Index Cooperative
 * @notice Part of a family of contracts that allows users to issue and redeem SetTokens with a single input/output token (ETH/ERC20).
 * [TODO]
 * The FlashMint SDK (https://github.com/IndexCoop/flash-mint-sdk) provides a unified interface for this and other FlashMint contracts.
 */
contract FlashMintNAV is Ownable, ReentrancyGuard {
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
    INAVIssuanceModule public immutable navIssuanceModule;
    DEXAdapterV2.Addresses public dexAdapter;

    /* ============ Structs ============ */
    struct IssueRedeemParams {
        ISetToken setToken;                          // The address of the SetToken to be issued/redeemed
        uint256 amountSetToken;                      // The amount of SetTokens to issue/redeem
        uint256 limitAmt;                            // Max/min amount of payment token spent/received
        DEXAdapterV2.SwapData reserveAssetSwapData;  // The swap data from payment token to reserve asset (or vice versa for redemption)
        address issuanceModule;                      // The address of the NAV issuance module to be used
    }

    /* ============ Events ============ */

    event FlashMint(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountSetIssued,       // The amount of SetTokens received by the recipient
        uint256 _amountInputToken       // The amount of input tokens used for issuance
    );

    event FlashRedeem(
        address indexed _recipient,     // The recipient adress of the output tokens obtained for redemption
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    // modifier isValidPath(
    //     address[] memory _path,
    //     address _inputToken,
    //     address _outputToken
    // )
    // {
    //     if(_inputToken != _outputToken){
    //         require(
    //             _path[0] == _inputToken || (_inputToken == addresses.weth && _path[0] == DEXAdapterV2.ETH_ADDRESS),
    //             "ExchangeIssuance: INPUT_TOKEN_NOT_IN_PATH"
    //         );
    //         require(
    //             _path[_path.length-1] == _outputToken ||
    //             (_outputToken == addresses.weth && _path[_path.length-1] == DEXAdapterV2.ETH_ADDRESS),
    //             "ExchangeIssuance: OUTPUT_TOKEN_NOT_IN_PATH"
    //         );
    //     }
    //     _;
    // }

    /**
     * Initializes the contract with controller, issuance module, and DEXAdapterV2 library addresses.
     *
     * @param _setController     Address of the protocol controller contract
     * @param _navIssuanceModule NAV Issuance Module used to issue and redeem SetTokens
     * @param _dexAddresses      Struct containing addresses for the DEXAdapterV2 library
     */
    constructor(
        IController _setController,
        INAVIssuanceModule _navIssuanceModule,
        DEXAdapterV2.Addresses memory _dexAddresses
    )
        public
    {
        setController = _setController;
        navIssuanceModule = _navIssuanceModule;
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
     */
    function approveReserveAsset(IERC20 _token) public {
        _safeApprove(_token, address(navIssuanceModule), type(uint256).max);
    }

    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     */
    function approveReserveAssets(IERC20[] calldata _tokens) external {
        for (uint256 i = 0; i < _tokens.length; i++) {
            approveReserveAsset(_tokens[i]);
        }
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a SetToken. This function need to be called only once before the first time
     * this smart contract is used on any particular SetToken.
     *
     * @param _setToken          Address of the SetToken being initialized
     */
    function approveSetToken(address _setToken) external {
        address[] memory reserveAssets = navIssuanceModule.getReserveAssets(_setToken);
        for (uint256 i = 0; i < reserveAssets.length; i++) {
            approveReserveAsset(IERC20(reserveAssets[i]));
        }
    }

    /**
     * Gets the amount of input token required to issue a given quantity of set token with the provided issuance params.
     * This function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter contract
     *
     * @param _issueParams            Struct containing addresses, amounts, and swap data for issuance
     * @param _reserveAssetSwapData   Swap data to trade input token for reserve asset. Use empty swap data if input token is the reserve asset.
     *
     * @return                        Amount of input tokens required to perform the issuance
     */
    // function getIssueExactSet(
    //     IssueRedeemParams memory _issueParams,
    //     DEXAdapterV2.SwapData memory _reserveAssetSwapData
    // )
    //     external
    //     returns (uint256)
    // {
    //     uint256 totalWethNeeded = _getWethCostsForIssue(_issueParams);
    //     return dexAdapter.getAmountIn(_swapDataInputTokenToWeth, totalWethNeeded);
    // }

    /**
     * Gets the amount of specified payment token expected to be received after redeeming 
     * a given quantity of set token with the provided redemption params.
     * This function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter contract
     *
     * @param _redeemParams          Struct containing addresses, amounts, and swap data for redemption
     * @param _reserveAssetSwapData  Swap data to trade reserve asset for output token. Use empty swap data if output token is the reserve asset. 
     *
     * @return                       Amount of output tokens expected after performing redemption
     */
    // function getRedeemExactSet(
    //     IssueRedeemParams memory _redeemParams,
    //     DEXAdapterV2.SwapData memory _reserveAssetSwapData
    // )
    //     external
    //     returns (uint256)
    // {
    //     uint256 reserveAssetReceived = _getReserveAssetReceivedForRedeem(_redeemParams);
    //     return dexAdapter.getAmountOut(_reserveAssetSwapData, reserveAssetReceived);
    // }

    /**
    * Issues an exact amount of SetTokens for given amount of ETH.
    *
    * @param _setToken            Address of the SetToken to be issued
    * @param _amountSetToken      Amount of SetTokens to be issued
    * @param _reserveAssetSwapData Swap data to trade WETH for reserve asset
    *
    * @return                     Amount of ETH spent
    */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        payable
        nonReentrant
        returns (uint256)
    {
        require(msg.value > 0, "FlashMint: NO ETH SENT");

        //TODO calculate amount of WETH needed to issue set token
        uint256 wethNeeded = _getInputTokenAmountForIssue(_setToken, _amountSetToken, _reserveAssetSwapData);

        IWETH(WETH).deposit{value: msg.value}();

        //TODO swap WETH to reserve asset using swapdata

        uint256 ethUsedForIssuance = _issue(_setToken, WETH, wethNeeded, _amountSetToken);

        // uint256 leftoverETH = msg.value.sub(ethUsedForIssuance);
        // if (leftoverETH > _minEthRefund) {
        //     IWETH(WETH).withdraw(leftoverETH);
        //     payable(msg.sender).sendValue(leftoverETH);
        // }
        // ethSpent = msg.value.sub(leftoverETH);

        // emit FlashMint(msg.sender, _issueParams.setToken, IERC20(ETH_ADDRESS), ethSpent, _issueParams.amountSetToken);
    }

    /**
    * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
    * Leftover funds are swapped back to the payment token and returned to the caller if the value is above _minRefundValueInWeth,
    * otherwise the leftover funds are kept by the contract in the form of WETH to save gas.
    *
    * @param _issueParams           Struct containing addresses, amounts, and swap data for issuance
    * @param _minRefundValueInWeth  Minimum value of leftover WETH to be swapped back to input token and returned to the caller. Set to 0 to return any leftover amount.
    *
    * @return paymentTokenSpent     Amount of input token spent
    */
    // function issueExactSetFromERC20(IssueRedeemParams memory _issueParams, uint256 _minRefundValueInWeth)
    //     external
    //     nonReentrant
    //     returns (uint256 paymentTokenSpent)
    // {
    //     _paymentInfo.token.safeTransferFrom(msg.sender, address(this), _paymentInfo.limitAmt);
    //     uint256 wethReceived = _swapPaymentTokenForWeth(_paymentInfo.token, _paymentInfo.limitAmt, _paymentInfo.swapDataTokenToWeth);

    //     uint256 wethSpent = _issueExactSetFromWeth(_issueParams);
    //     require(wethSpent <= wethReceived, "FlashMint: OVERSPENT WETH");
    //     uint256 leftoverWeth = wethReceived.sub(wethSpent);
    //     uint256 paymentTokenReturned = 0;

    //     if (leftoverWeth > _minRefundValueInWeth) {
    //         paymentTokenReturned = _swapWethForPaymentToken(leftoverWeth, _paymentInfo.token, _paymentInfo.swapDataWethToToken);
    //         _paymentInfo.token.safeTransfer(msg.sender, paymentTokenReturned);
    //     }

    //     paymentTokenSpent = _paymentInfo.limitAmt.sub(paymentTokenReturned);

    //     emit FlashMint(msg.sender, _issueParams.setToken, _paymentInfo.token, paymentTokenSpent, _issueParams.amountSetToken);
    // }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams   Struct containing addresses, amounts, and swap data for issuance
     *
     * @return ethReceived      Amount of ETH received
     */
    // function redeemExactSetForETH(IssueRedeemParams memory _redeemParams, uint256 _minEthReceive)
    //     external
    //     nonReentrant
    //     returns (uint256 ethReceived)
    // {
    //     _redeem(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

    //     ethReceived = _sellComponentsForWeth(_redeemParams);
    //     require(ethReceived >= _minEthReceive, "FlashMint: INSUFFICIENT WETH RECEIVED");

    //     IWETH(WETH).withdraw(ethReceived);
    //     payable(msg.sender).sendValue(ethReceived);

    //     emit FlashRedeem(msg.sender, _redeemParams.setToken, IERC20(ETH_ADDRESS), _redeemParams.amountSetToken, ethReceived);
    //     return ethReceived;
    // }

    /**
     * Redeems an exact amount of SetTokens for an ERC20 token.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _redeemParams             Struct containing token addresses, amounts, and swap data for issuance
     *
     * @return outputTokenReceived      Amount of output token received
     */
    // function redeemExactSetForERC20(IssueRedeemParams memory _redeemParams)
    //     external
    //     nonReentrant
    //     returns (uint256 outputTokenReceived)
    // {
    //     _redeem(_redeemParams.setToken, _redeemParams.amountSetToken, _redeemParams.issuanceModule);

    //     uint256 wethReceived = _sellComponentsForWeth(_redeemParams);
    //     outputTokenReceived = _swapWethForPaymentToken(wethReceived, _paymentInfo.token, _paymentInfo.swapDataWethToToken);
    //     require(outputTokenReceived >= _paymentInfo.limitAmt, "FlashMint: INSUFFICIENT OUTPUT AMOUNT");

    //     _paymentInfo.token.safeTransfer(msg.sender, outputTokenReceived);

    //     emit FlashRedeem(msg.sender, _redeemParams.setToken, _paymentInfo.token, _redeemParams.amountSetToken, outputTokenReceived);
    // }

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
    * Issues an exact amount of SetTokens for given amount of reserve asset.
    *
    * @param _setToken     Address of the SetToken to be issued
    * @param _reserveAsset Address of the reserve asset to be used for issuance
    * @param _reserveAssetQuantity Amount of reserve asset to be used for issuance
    * @param _minSetTokenReceiveQuantity Minimum amount of SetTokens to be received
    *
    * @return                       Amount of reserve asset used to buy components
    */
    function _issue(
      ISetToken _setToken,
      address _reserveAsset,
      uint256 _reserveAssetQuantity,
      uint256 _minSetTokenReceiveQuantity
    ) 
      internal
      returns (uint256)
    {
        INAVIssuanceModule(navIssuanceModule).issue(
            _setToken,
            _reserveAsset,
            _reserveAssetQuantity,
            _minSetTokenReceiveQuantity,
            address(this)
        );
    }

    /**
     * Calculates the amount of WETH required to buy all components required for issuance.
     *
     * @param _setToken     Address of the SetToken to be issued
     * @param _amountSetToken Amount of SetTokens to be issued
     * @param _reserveAssetSwapData Swap data for swapping input token to reserve asset
     *
     * @return              Amount of input token needed for issuance
     */
    function _getInputTokenAmountForIssue(ISetToken _setToken, uint256 _amountSetToken, DEXAdapterV2.SwapData memory _reserveAssetSwapData)
        internal
        returns (uint256)
    {
        uint8 outIndex = uint8(_reserveAssetSwapData.path.length - 1);
        address reserveAsset = _reserveAssetSwapData.path[outIndex];

        // Sync SetToken positions (in case of rebasing components, for example)
        _callPreIssueHooks(_setToken, reserveAsset, 0, msg.sender, address(this));
        // Get valuation of the SetToken with the quote asset as the reserve asset. Returns value in precise units (1e18)
        uint256 setTokenValuation = _getSetValuer(_setToken).calculateSetTokenValuation(_setToken, reserveAsset);

        uint256 reserveAssetDecimals = ERC20(reserveAsset).decimals();
        // TODO: Handle any issue premiums and fees
        uint256 reserveAssetNeeded = setTokenValuation.preciseMul(_amountSetToken).preciseDiv(10 ** reserveAssetDecimals);

        return dexAdapter.getAmountIn(_reserveAssetSwapData, reserveAssetNeeded);
    }

    /**
     * Transfers given amount of set token from the sender and redeems it for underlying components.
     * Obtained component tokens are sent to this contract. 
     *
     * @param _setToken     Address of the SetToken to be redeemed
     * @param _amount       Amount of SetToken to be redeemed
     */
    // function _redeem(ISetToken _setToken, uint256 _amount, address _issuanceModule) internal returns (uint256) {
    //     _setToken.safeTransferFrom(msg.sender, address(this), _amount);
    //     navIssuanceModule.redeem(_setToken, _amount, address(this));
    // }

    /**
     * If a custom set valuer has been configured, use it. Otherwise fetch the default one form the
     * controller.
     */
    function _getSetValuer(ISetToken _setToken) internal view returns (ISetValuer) {
        (,,address customValuer,,,,,) = navIssuanceModule.navIssuanceSettings(address(_setToken));
        // TODO: Check if custom valuer is not set and use default valuer?
        return ISetValuer(customValuer);
    }

    /**
     * If a pre-issue hook has been configured, call the external-protocol contract. Pre-issue hook logic
     * can contain arbitrary logic including validations, external function calls, etc.
     */
    function _callPreIssueHooks(
        ISetToken _setToken,
        address _reserveAsset,
        uint256 _reserveAssetQuantity,
        address _caller,
        address _to
    )
        internal
    {
        (address preIssueHook,,,,,,,) = navIssuanceModule.navIssuanceSettings(address(_setToken));
        // INAVIssuanceHook preIssueHook = navIssuanceModule.navIssuanceSettings(_setToken).managerIssuanceHook;
        if (address(preIssueHook) != address(0)) {
            INAVIssuanceHook(preIssueHook).invokePreIssueHook(_setToken, _reserveAsset, _reserveAssetQuantity, _caller, _to);
        }
    }

    /**
     * If a pre-redeem hook has been configured, call the external-protocol contract.
     */
    function _callPreRedeemHooks(ISetToken _setToken, uint256 _setQuantity, address _caller, address _to) internal {
        (,address preRedeemHook,,,,,,) = navIssuanceModule.navIssuanceSettings(address(_setToken));
        // INAVIssuanceHook preRedeemHook = navIssuanceModule.navIssuanceSettings(_setToken).managerRedemptionHook;
        if (address(preRedeemHook) != address(0)) {
            INAVIssuanceHook(preRedeemHook).invokePreRedeemHook(_setToken, _setQuantity, _caller, _to);
        }
    }
}
