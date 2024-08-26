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
    * Issues a minimum amount of SetTokens for an exact amount of ETH.
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _minSetTokenAmount     Minimum amount of SetTokens to be issued
    * @param _reserveAssetSwapData  Swap data to trade WETH for reserve asset
    */
    function issueSetFromExactETH(
        ISetToken _setToken,
        uint256 _minSetTokenAmount,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        payable
        nonReentrant
    {
        require(msg.value > 0, "FlashMint: NO ETH SENT");
        IWETH(WETH).deposit{value: msg.value}();

        // TODO refactor into modifier
        address reserveAsset = _reserveAssetSwapData.path[_reserveAssetSwapData.path.length - 1];
        require(navIssuanceModule.isReserveAsset(_setToken, reserveAsset), "FLASHMINT: INVALID RESERVE ASSET");
        uint256 reserveAssetReceived = dexAdapter.swapExactTokensForTokens(msg.value, 0, _reserveAssetSwapData);
        uint256 setTokenBalanceBefore = _setToken.balanceOf(msg.sender);

        INAVIssuanceModule(navIssuanceModule).issue(
            _setToken,
            reserveAsset,
            reserveAssetReceived,
            _minSetTokenAmount,
            msg.sender
        );

        uint256 setTokenIssued = _setToken.balanceOf(msg.sender).sub(setTokenBalanceBefore);
        emit FlashMint(msg.sender, _setToken, IERC20(ETH_ADDRESS), setTokenIssued, msg.value);
    }

    /**
    * Issues a minimum amount of SetTokens for an exact amount of ERC20.
    *
    * @param _setToken           Address of the SetToken to be issued
    * @param _minSetTokenAmount  Minimum amount of SetTokens to be issued
    * @param _inputToken         Address of input token for which to issue set tokens
    * @param _inputTokenAmount   Amount of input token to spend
    * 
    * @param _reserveAssetSwapData  Swap data to trade input token for reserve asset
    */
    function issueSetFromExactERC20(
        ISetToken _setToken,
        uint256 _minSetTokenAmount,
        IERC20 _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        payable
        nonReentrant
    {
        address reserveAsset;
        // TODO refactor into modifier
        if (_reserveAssetSwapData.path.length > 0) {
            reserveAsset = _reserveAssetSwapData.path[_reserveAssetSwapData.path.length - 1];
        } else {
            reserveAsset = address(_inputToken);
        }
        require(navIssuanceModule.isReserveAsset(_setToken, reserveAsset), "FLASHMINT: INVALID RESERVE ASSET");

        _inputToken.safeTransferFrom(msg.sender, address(this), _inputTokenAmount);
        uint256 reserveAssetReceived;
        if (_inputToken == IERC20(reserveAsset)) {
            reserveAssetReceived = _inputTokenAmount;
        }
        reserveAssetReceived = dexAdapter.swapExactTokensForTokens(_inputTokenAmount, 0, _reserveAssetSwapData);
        uint256 setTokenBalanceBefore = _setToken.balanceOf(msg.sender);

        INAVIssuanceModule(navIssuanceModule).issue(
            _setToken,
            reserveAsset,
            reserveAssetReceived,
            _minSetTokenAmount,
            msg.sender
        );

        uint256 setTokenIssued = _setToken.balanceOf(msg.sender).sub(setTokenBalanceBefore);
        emit FlashMint(msg.sender, _setToken, IERC20(ETH_ADDRESS), setTokenIssued, _inputTokenAmount);
    }

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
    */
    function _issue(
      ISetToken _setToken,
      address _reserveAsset,
      uint256 _reserveAssetQuantity,
      uint256 _minSetTokenReceiveQuantity
    ) 
      internal
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
    // function _getInputTokenAmountForIssue(ISetToken _setToken, uint256 _amountSetToken, DEXAdapterV2.SwapData memory _reserveAssetSwapData)
    //     internal
    //     returns (uint256)
    // {
    //     uint8 outIndex = uint8(_reserveAssetSwapData.path.length - 1);
    //     address reserveAsset = _reserveAssetSwapData.path[outIndex];

    //     // Sync SetToken positions (in case of rebasing components, for example)
    //     _callPreIssueHooks(_setToken, reserveAsset, 0, msg.sender, address(this));
    //     // Get valuation of the SetToken with the quote asset as the reserve asset. Returns value in precise units (1e18)
    //     uint256 setTokenValuation = _getSetValuer(_setToken).calculateSetTokenValuation(_setToken, reserveAsset);

    //     uint256 reserveAssetDecimals = ERC20(reserveAsset).decimals();
    //     // TODO: Handle any issue premiums and fees
    //     uint256 reserveAssetNeeded = setTokenValuation.preciseMul(_amountSetToken).preciseDiv(10 ** reserveAssetDecimals);

    //     return dexAdapter.getAmountIn(_reserveAssetSwapData, reserveAssetNeeded);
    // }

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
    // function _getSetValuer(ISetToken _setToken) internal view returns (ISetValuer) {
    //     (,,address customValuer,,,,,) = navIssuanceModule.navIssuanceSettings(address(_setToken));
    //     // TODO: Check if custom valuer is not set and use default valuer?
    //     return ISetValuer(customValuer);
    // }

    /**
     * If a pre-issue hook has been configured, call the external-protocol contract. Pre-issue hook logic
     * can contain arbitrary logic including validations, external function calls, etc.
     */
    // function _callPreIssueHooks(
    //     ISetToken _setToken,
    //     address _reserveAsset,
    //     uint256 _reserveAssetQuantity,
    //     address _caller,
    //     address _to
    // )
    //     internal
    // {
    //     (address preIssueHook,,,,,,,) = navIssuanceModule.navIssuanceSettings(address(_setToken));
    //     // INAVIssuanceHook preIssueHook = navIssuanceModule.navIssuanceSettings(_setToken).managerIssuanceHook;
    //     if (address(preIssueHook) != address(0)) {
    //         INAVIssuanceHook(preIssueHook).invokePreIssueHook(_setToken, _reserveAsset, _reserveAssetQuantity, _caller, _to);
    //     }
    // }

    // /**
    //  * If a pre-redeem hook has been configured, call the external-protocol contract.
    //  */
    // function _callPreRedeemHooks(ISetToken _setToken, uint256 _setQuantity, address _caller, address _to) internal {
    //     (,address preRedeemHook,,,,,,) = navIssuanceModule.navIssuanceSettings(address(_setToken));
    //     // INAVIssuanceHook preRedeemHook = navIssuanceModule.navIssuanceSettings(_setToken).managerRedemptionHook;
    //     if (address(preRedeemHook) != address(0)) {
    //         INAVIssuanceHook(preRedeemHook).invokePreRedeemHook(_setToken, _setQuantity, _caller, _to);
    //     }
    // }
}
