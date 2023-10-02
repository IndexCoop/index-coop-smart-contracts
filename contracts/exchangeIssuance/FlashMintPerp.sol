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

import { IQuoter } from "../interfaces/IQuoter.sol";
import { IUniswapV3SwapCallback } from "../interfaces/IUniswapV3SwapCallback.sol";
import { ISwapRouter02 } from "../interfaces/external/ISwapRouter02.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { Context } from "@openzeppelin/contracts/GSN/Context.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TransferHelper } from "../lib/TransferHelper.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISlippageIssuanceModule } from "../interfaces/ISlippageIssuanceModule.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { Withdrawable } from "external/contracts/aaveV2/utils/Withdrawable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";


/**
 * @title FlashMintPerp
 *
 * Flash issue basis trading products using SlippageIssuanceModule
 *
 */
contract FlashMintPerp is Withdrawable {
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;


    ////////////// State //////////////

    ISlippageIssuanceModule public immutable slippageIssuanceModule;
    ISwapRouter02 public immutable uniV3Router;
    IQuoter public immutable uniV3Quoter;
    IERC20 public immutable usdc;
    mapping (ISetToken => SetPoolInfo) public setPoolInfo;
    mapping(ISetToken => bool) public initializedSets;

    ////////////// Structs //////////////

    struct SetPoolInfo {
        bytes spotToUsdcRoute;
        address spotToken;
    }

    ////////////// Constructor //////////////

    constructor(
        ISwapRouter02 _uniV3Router,
        IQuoter _uniV3Quoter,
        ISlippageIssuanceModule _slippageIssuanceModule,
        IERC20 _usdc
    ) 
        public
    {
        uniV3Router = _uniV3Router;
        uniV3Quoter = _uniV3Quoter;
        slippageIssuanceModule = _slippageIssuanceModule;
        usdc = _usdc;

        // Approve USDC to SlippageIssuanceModule
        _usdc.approve(address(_slippageIssuanceModule), PreciseUnitMath.maxUint256());

        // Approve USDC
        _usdc.approve(address(_uniV3Router), PreciseUnitMath.maxUint256());
    }

    ///////////// Modifier ///////////////

    modifier isInitializedSet(ISetToken _setToken) {
        require(initializedSets[_setToken], "Set not initialized");
        _;
    }

    ////////// Helper functions /////////////

    /**
     * @dev Approve specific amount of token to spender
     *
     * @param _token    Address of the token which needs approval
     * @param _spender  Address of the spender which will be approved to spend token. (Must be a whitlisted issuance module)
     * @param _amount   The amount of tokens to approve
     */
    function approve(address _token, address _spender, uint256 _amount) external onlyOwner {
        TransferHelper.safeApprove(_token, _spender, _amount);
    }

    /**
     * @dev Enable the SetToken issuance 
     *
     * @param _setToken         Address of the SetToken to be issued
     * @param _spotToUsdcRoute  Uniswap V3 Path to be used for exchange
     * @param _spotToken        Address of the spot token
     */
    function initializeSet(
        ISetToken _setToken,
        bytes calldata _spotToUsdcRoute,
        address _spotToken
    )
        external
        onlyOwner
    {
        // Approve spot token to V3 and SIM
        TransferHelper.safeApprove(_spotToken, address(uniV3Router), PreciseUnitMath.maxUint256());
        TransferHelper.safeApprove(_spotToken, address(slippageIssuanceModule), PreciseUnitMath.maxUint256());

        // Store SetToken pool data in mapping
        setPoolInfo[_setToken] = SetPoolInfo({
            spotToUsdcRoute: _spotToUsdcRoute,
            spotToken: _spotToken
        });

        initializedSets[_setToken] = true;
    }

    /**
     * @dev Disable the SetToken issuance 
     *
     * @param _setToken         Address of the SetToken to be issued
     */
    function removeSet(ISetToken _setToken) external onlyOwner {
        delete setPoolInfo[_setToken];
        initializedSets[_setToken] = false;
    }

    ///////////////// Getter Functions /////////////////////

    /**
     * Returns USDC amount required for issuance
     *
     * @param _setToken     Address of the SetToken
     * @param _amountOut    The issuance amount of the SetToken
     */
    function getUsdcAmountInForFixedSetOffChain(
        ISetToken _setToken,
        uint256 _amountOut
    )
        external
        returns (uint256 totalUsdcAmountIn)
    {
        // Get units and components
        (
            address[] memory slippageIssuanceComponents,
            uint256[] memory slippageIssuanceUnits,
        ) = slippageIssuanceModule.getRequiredComponentIssuanceUnitsOffChain(
            _setToken,
            _amountOut
        );

        // Assert assumptions
        require(slippageIssuanceComponents.length <= 2, "invalid set");

        // calculate total usdc amount in and usdcForSpot
        for (uint256 i = 0; i < slippageIssuanceComponents.length; i++) {

            if (slippageIssuanceComponents[i] == address(usdc)) {

                totalUsdcAmountIn = totalUsdcAmountIn.add(slippageIssuanceUnits[i]);

            } else {

                uint256 usdcForSpot = uniV3Quoter.quoteExactOutput(
                    setPoolInfo[_setToken].spotToUsdcRoute,
                    slippageIssuanceUnits[i].add(1) // Add 1 wei
                );
                totalUsdcAmountIn = totalUsdcAmountIn.add(usdcForSpot);
            }
        }
    }

    /**
     * Returns USDC amount required for redemption
     *
     * @param _setToken     Address of the SetToken
     * @param _amountIn     The redeem amount of the SetToken
     */
    function getUsdcAmountOutForFixedSetOffChain(
        ISetToken _setToken,
        uint256 _amountIn
    )
        external
        returns (uint256 totalUsdcAmountOut)
    {
        // Get underlying spot and usdc units
        (
            address[] memory slippageIssuanceComponents,
            uint256[] memory slippageIssuanceUnits,
        ) = slippageIssuanceModule.getRequiredComponentRedemptionUnitsOffChain(
            _setToken,
            _amountIn
        );

        // Assert assumptions
        require(slippageIssuanceComponents.length <= 2, "invalid set");

        // calculate total usdc amount in and usdcFromSpot
        for (uint256 i = 0; i <  slippageIssuanceComponents.length; i++) {
            if (slippageIssuanceComponents[i] == address(usdc)) {

                totalUsdcAmountOut = totalUsdcAmountOut.add(slippageIssuanceUnits[i]);

            } else {

                uint256 usdcFromSpot = uniV3Quoter.quoteExactInput(
                    setPoolInfo[_setToken].spotToUsdcRoute,
                    slippageIssuanceUnits[i].sub(1) // Leave 1 wei
                );
                totalUsdcAmountOut = totalUsdcAmountOut.add(usdcFromSpot);
            }
        }
    }

    //////////////// External Functions ////////////////////

    /**
     * Issue expected amount of SetToken using USDC
     *
     * @param _setToken     Address of the SetToken
     * @param _amount       The expected issuance amount of the SetToken
     * @param _maxAmountIn  The maximum input amount of USDC
     */
    function issueFixedSetFromUsdc(
        ISetToken _setToken,
        uint256 _amount,
        uint256 _maxAmountIn
    )
        external
        isInitializedSet(_setToken)
    {
        // Transfer max amount in
        TransferHelper.safeTransferFrom(address(usdc), msg.sender, address(this), _maxAmountIn);

        // calculate spot asset quantity
        uint256 spotAssetQuantity = _spotAssetQuantity(_setToken, _amount);

        // Trade USDC for exact spot token
        ISwapRouter02.ExactOutputParams memory spotTokenParams = ISwapRouter02.ExactOutputParams(
            setPoolInfo[_setToken].spotToUsdcRoute,
            address(this),
            spotAssetQuantity.add(1), // Add 1 wei
            PreciseUnitMath.maxUint256() // No need for slippage check
        );

        // Executes the swap
        uniV3Router.exactOutput(spotTokenParams);

        // Issue Set with spot tokens and USDC
        slippageIssuanceModule.issueWithSlippage(
            _setToken,
            _amount,
            new address[](0), // No need to check for slippage cause L2; If not enough USDC then issue would fail
            new uint256[](0),
            msg.sender
        );

        // Return unused USDC
        uint256 usdcBalance = usdc.balanceOf(address(this));
        TransferHelper.safeTransfer(address(usdc), msg.sender, usdcBalance);
    }

    /**
     * Redeem expected amount of SetToken using USDC
     *
     * @param _setToken         Address of the SetToken
     * @param _amount           The expected redeem amount of the SetToken
     * @param _minAmountOut     The minimum output amount of USDC
     */
    function redeemFixedSetForUsdc(
        ISetToken _setToken,
        uint256 _amount,
        uint256 _minAmountOut
    )
        external
        isInitializedSet(_setToken)
    {

        TransferHelper.safeTransferFrom(address(_setToken), msg.sender, address(this), _amount);

        // Redeem Set to spot tokens and USDC
        slippageIssuanceModule.redeemWithSlippage(
            _setToken,
            _amount,
            new address[](0), // No need to check for slippage as there is no risk of sandwiching due to flashloans
            new uint256[](0),
            address(this)
        );

        // calculate spot asset quantity
        uint256 spotAssetQuantity = _spotAssetQuantity(_setToken, _amount);

        // check with actual spot token balance
        uint256 spotTokenBalance = IERC20(setPoolInfo[_setToken].spotToken).balanceOf(address(this));
        if (spotAssetQuantity > spotTokenBalance) {
            spotAssetQuantity = spotTokenBalance;
        }

        ISwapRouter02.ExactInputParams memory spotTokenParams = ISwapRouter02.ExactInputParams(
            setPoolInfo[_setToken].spotToUsdcRoute,
            address(this),
            spotAssetQuantity.sub(1), // Leave 1 wei
            0 // No need for slippage check
        );

        // Executes the swap
        uniV3Router.exactInput(spotTokenParams);

        // Return the USDC
        uint256 usdcBalance = usdc.balanceOf(address(this));

        require(usdcBalance >= _minAmountOut, "Not enough USDC");

        TransferHelper.safeTransfer(address(usdc), msg.sender, usdcBalance);
    }


    /////////////// Internal functions //////////////////

    function _spotAssetQuantity(ISetToken _setToken, uint256 _amount) internal view returns (uint256) {
        address spotAsset = setPoolInfo[_setToken].spotToken;

        uint256 spotAssetQuantity = _setToken
            .getDefaultPositionRealUnit(spotAsset)
            .toUint256()
            .preciseMul(_amount);

        return spotAssetQuantity;
    }
}