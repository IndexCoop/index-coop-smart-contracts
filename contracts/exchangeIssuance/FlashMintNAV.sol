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
import { ISetValuer } from "../interfaces/ISetValuer.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { DEXAdapterV2 } from "./DEXAdapterV2.sol";

/**
 * @title FlashMintNAV
 * @author Index Cooperative
 * @notice Part of a family of FlashMint contracts that allows users to issue and redeem SetTokens with a single input/output token (ETH/ERC20).
 * Allows the caller to combine a DEX swap and a SetToken issuance or redemption in a single transaction.
 * Supports SetTokens that use a NAV Issuance Module, and does not require use of off-chain APIs for swap quotes.
 * The SetToken must be configured with a reserve asset that has liquidity on the exchanges supported by the DEXAdapterV2 library.
 *
 * See the FlashMint SDK for integrating any FlashMint contract (https://github.com/IndexCoop/flash-mint-sdk).
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

    /* ============ Immutables ============ */

    address public immutable WETH;
    IController public immutable setController;
    INAVIssuanceModule public immutable navIssuanceModule;

    /* ============ State Variables ============ */

    DEXAdapterV2.Addresses public dexAdapter;

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
     * Withdraw tokens to selected address if they end up in the contract
     *
     * @param _tokens    Addresses of tokens to withdraw, specifiy ETH_ADDRESS to withdraw ETH
     * @param _to        Address to send the tokens to
     */
    function withdrawTokens(
        IERC20[] calldata _tokens,
        address payable _to
    ) external payable onlyOwner {
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (address(_tokens[i]) == DEXAdapterV2.ETH_ADDRESS) {
                _to.sendValue(address(this).balance);
            } else {
                _tokens[i].safeTransfer(_to, _tokens[i].balanceOf(address(this)));
            }
        }
    }

    receive() external payable {
        // required for weth.withdraw() to work properly
        require(msg.sender == WETH, "FlashMint: DIRECT DEPOSITS NOT ALLOWED");
    }

    /**
     * Runs all the necessary approval functions required before issuing or redeeming 
     * a SetToken through the NAV Issuance Module. This function needs to be called
     * before this smart contract is used with any particular SetToken, and again
     * whenever a new reserve asset is added.
     *
     * @param _setToken          Address of the SetToken being initialized
     */
    function approveSetToken(ISetToken _setToken) external {
        address[] memory reserveAssets = navIssuanceModule.getReserveAssets(address(_setToken));
        for (uint256 i = 0; i < reserveAssets.length; i++) {
            _safeApprove(IERC20(reserveAssets[i]), address(navIssuanceModule), type(uint256).max);
        }
        _safeApprove(IERC20(_setToken), address(navIssuanceModule), type(uint256).max);
    }

    /**
     * Gets the amount of Set Token expected to be issued given an exact quantity of input token.
     * This function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter contract
    *
    * @param _setToken              Address of the Set Token to be issued
    * @param _inputToken            Address of the token used to pay for issuance. Use WETH address if input token is ETH.
    * @param _inputTokenAmount      Exact amount of input token to spend
    * @param _reserveAssetSwapData  Swap data to trade input token for reserve asset. Use empty swap data if input token is the reserve asset.
    * 
    * @return                       Amount of SetTokens expected to be issued
    */
    function getIssueAmount(
        ISetToken _setToken,
        address _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        returns (uint256)
    {
        address reserveAsset = _getAndValidateReserveAsset(_setToken, _inputToken, _reserveAssetSwapData.path, true);
        uint256 reserveAssetReceived = dexAdapter.getAmountOut(_reserveAssetSwapData, _inputTokenAmount);

        return navIssuanceModule.getExpectedSetTokenIssueQuantity(
            _setToken,
            reserveAsset,
            reserveAssetReceived
        );
    }

    /**
     * Gets the amount of output token expected to be received after redeeming a given quantity of Set Token
     * for reserve asset and then swapping the reserve asset for output token.
     * This function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter contract
     *
    * @param _setToken              Address of the Set Token to be redeemed
    * @param _setTokenAmount        Amount of Set Token to be redeemed
    * @param _outputToken           Address of the token to send to caller after redemption
    * @param _reserveAssetSwapData  Swap data to trade reserve asset for output token
    * 
    * @return                       Amount of output tokens expected to be sent to caller
    */
    function getRedeemAmountOut(
        ISetToken _setToken,
        uint256 _setTokenAmount,
        address _outputToken,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        returns (uint256)
    {
        address reserveAsset = _getAndValidateReserveAsset(_setToken, _outputToken, _reserveAssetSwapData.path, false);
        uint256 reserveAssetReceived = navIssuanceModule.getExpectedReserveRedeemQuantity(
            _setToken,
            reserveAsset,
            _setTokenAmount
        );

        return dexAdapter.getAmountOut(_reserveAssetSwapData, reserveAssetReceived);
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
        address reserveAsset = _getAndValidateReserveAsset(_setToken, WETH, _reserveAssetSwapData.path, true);
        uint256 reserveAssetReceived = dexAdapter.swapExactTokensForTokens(msg.value, 0, _reserveAssetSwapData);
        uint256 setTokenBalanceBefore = _setToken.balanceOf(msg.sender);

        navIssuanceModule.issue(
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
    * @param _setToken              Address of the SetToken to issue
    * @param _minSetTokenAmount     Minimum amount of SetTokens to issue
    * @param _inputToken            Address of token used to pay for issuance
    * @param _inputTokenAmount      Amount of input token to spend
    * @param _reserveAssetSwapData  Swap data to trade input token for reserve asset. Can use empty swap data if input token is reserve asset.
    */
    function issueSetFromExactERC20(
        ISetToken _setToken,
        uint256 _minSetTokenAmount,
        IERC20 _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        nonReentrant
    {
        address reserveAsset = _getAndValidateReserveAsset(_setToken, address(_inputToken), _reserveAssetSwapData.path, true);
        _inputToken.safeTransferFrom(msg.sender, address(this), _inputTokenAmount);
        uint256 reserveAssetReceived = dexAdapter.swapExactTokensForTokens(_inputTokenAmount, 0, _reserveAssetSwapData);
        uint256 setTokenBalanceBefore = _setToken.balanceOf(msg.sender);

        navIssuanceModule.issue(
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
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken              Address of the SetToken to redeem
     * @param _setTokenAmount        Amount of SetTokens to redeem
     * @param _minEthAmount          Minimum amount of ETH to be received by caller
     * @param _reserveAssetSwapData  Swap data to trade reserve asset for WETH
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _setTokenAmount,
        uint256 _minEthAmount,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        nonReentrant
    {
        address reserveAsset = _getAndValidateReserveAsset(_setToken, WETH, _reserveAssetSwapData.path, false);
        uint256 reserveAssetBalanceBefore = IERC20(reserveAsset).balanceOf(address(this));
        _setToken.safeTransferFrom(msg.sender, address(this), _setTokenAmount);

        navIssuanceModule.redeem(
            _setToken,
            reserveAsset,
            _setTokenAmount,
            0,
            address(this)
        );

        uint256 reserveAssetReceived = IERC20(reserveAsset).balanceOf(address(this)).sub(reserveAssetBalanceBefore);
        uint256 wethReceived = dexAdapter.swapExactTokensForTokens(reserveAssetReceived, 0, _reserveAssetSwapData);
        require(wethReceived >= _minEthAmount, "FlashMint: NOT ENOUGH ETH RECEIVED");

        IWETH(WETH).withdraw(wethReceived);
        payable(msg.sender).sendValue(wethReceived);

        emit FlashRedeem(msg.sender, _setToken, IERC20(ETH_ADDRESS), _setTokenAmount, wethReceived);
    }

    /**
     * Redeems an exact amount of SetTokens for ETH.
     * The SetToken must be approved by the sender to this contract.
     *
     * @param _setToken              Address of the SetToken to redeem
     * @param _setTokenAmount        Amount of SetTokens to redeem
     * @param _outputToken           Address of the token to be received by caller
     * @param _minOutputTokenAmount  Minimum amount of output token to be received by caller
     * @param _reserveAssetSwapData  Swap data to trade reserve asset for output token. Can use empty swap data if output token is reserve asset.
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _setTokenAmount,
        IERC20 _outputToken,
        uint256 _minOutputTokenAmount,
        DEXAdapterV2.SwapData memory _reserveAssetSwapData
    )
        external
        nonReentrant
    {
        address reserveAsset = _getAndValidateReserveAsset(_setToken, address(_outputToken), _reserveAssetSwapData.path, false);
        uint256 reserveAssetBalanceBefore = IERC20(reserveAsset).balanceOf(address(this));
        _setToken.safeTransferFrom(msg.sender, address(this), _setTokenAmount);

        navIssuanceModule.redeem(
            _setToken,
            reserveAsset,
            _setTokenAmount,
            0,
            address(this)
        );

        uint256 reserveAssetReceived = IERC20(reserveAsset).balanceOf(address(this)).sub(reserveAssetBalanceBefore);
        uint256 outputTokenReceived = dexAdapter.swapExactTokensForTokens(reserveAssetReceived, 0, _reserveAssetSwapData);
        require(outputTokenReceived >= _minOutputTokenAmount, "FlashMint: NOT ENOUGH OUTPUT TOKEN RECEIVED");

        _outputToken.safeTransfer(msg.sender, outputTokenReceived);

        emit FlashRedeem(msg.sender, _setToken, _outputToken, _setTokenAmount, outputTokenReceived);
    }

    /* ============ Internal Functions ============ */

    /**
     * Validates the reserve asset and swap path for issuance or redemption.
     *
     * @param _setToken      Address of SetToken being issued or redeemed
     * @param _paymentToken  Address of input token if issuance, or output token if redemption
     * @param _path          Array of token addresses representing the swap path
     * @param _isIssuance    bool indicating issuance or redemption
     */
    function _getAndValidateReserveAsset(
        ISetToken _setToken,
        address _paymentToken,
        address[] memory _path,
        bool _isIssuance
    )
        internal
        view
        returns(address)
    {
        address reserveAsset;
        if (_path.length > 0) {
            if (_isIssuance) {
                require(_path[0] == _paymentToken, "FLASHMINT: FIRST ADDRESS IN SWAP PATH MUST BE INPUT TOKEN");
                reserveAsset = _path[_path.length - 1];
            } else {
                require(_path[_path.length - 1] == address(_paymentToken), "FLASHMINT: LAST ADDRESS IN SWAP PATH MUST BE OUTPUT TOKEN");
                reserveAsset = _path[0];
            }
        } else {
            reserveAsset = address(_paymentToken);
        }
        require(navIssuanceModule.isReserveAsset(_setToken, reserveAsset), "FLASHMINT: INVALID RESERVE ASSET");
        return reserveAsset;
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
}
