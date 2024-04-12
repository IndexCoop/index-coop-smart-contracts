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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { FlashMintLeveraged } from "./FlashMintLeveraged.sol";
import { DEXAdapter } from "./DEXAdapter.sol";
import { IController } from "../interfaces/IController.sol";
import { IAaveLeverageModule } from "../interfaces/IAaveLeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IAToken } from "../interfaces/IAToken.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";



/**
 * @title FlashMintLeveragedExtended
 * @author Index Coop
 *
 * Extended version of FlashMintLeveraged which allows for exactInputIssuance and exactOutputRedemption
 */
contract FlashMintLeveragedExtended is FlashMintLeveraged {

    /* ============ Constructor ============ */

    /**
    * Sets various contract addresses 
    *
    * @param _addresses             dex adapter addreses
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _debtIssuanceModule    DebtIssuanceModule used to issue and redeem tokens
    * @param _aaveLeverageModule    AaveLeverageModule to sync before every issuance / redemption
    * @param _aaveV3Pool   Address of address provider for aaves addresses
    * @param _vault                 Balancer Vault to flashloan from
    */
    constructor(
        DEXAdapter.Addresses memory _addresses,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        IAaveLeverageModule _aaveLeverageModule,
        address _aaveV3Pool,
        address _vault
    )
        public
        FlashMintLeveraged(_addresses, _setController, _debtIssuanceModule, _aaveLeverageModule, _aaveV3Pool, _vault)
    {
    }

    /**
     * Trigger redemption of set token to pay the user with Eth
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _minAmountOutputToken       Minimum amount of ETH to send to the user
     * @param _swapDataCollateralForDebt  Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Eth
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _setAmount,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
        external
        override
        nonReentrant
    {
        uint256 wethBalanceBefore = IWETH(addresses.weth).balanceOf(address(this));
        _initiateRedemption(
            _setToken,
            _setAmount,
            DEXAdapter.ETH_ADDRESS,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken
        );
        uint256 amountToReturn = IWETH(addresses.weth).balanceOf(address(this)).sub(wethBalanceBefore);
        IWETH(addresses.weth).withdraw(amountToReturn);
        (payable(msg.sender)).sendValue(amountToReturn);
    }

    /**
     * Trigger redemption of set token to pay the user with an arbitrary ERC20 
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _outputToken                Address of the ERC20 token to send to the user
     * @param _minAmountOutputToken       Minimum amount of output token to send to the user
     * @param _swapDataCollateralForDebt  Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Output token
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
        external
        override
        nonReentrant
    {
        uint256 outputTokenBalanceBefore = IERC20(_outputToken).balanceOf(address(this));
        _initiateRedemption(
            _setToken,
            _setAmount,
            _outputToken,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken
        );
        IERC20(_outputToken).transfer(msg.sender, IERC20(_outputToken).balanceOf(address(this)).sub(outputTokenBalanceBefore));
    }

    /**
     * Trigger issuance of set token paying with any arbitrary ERC20 token
     *
     * @param _setToken                     Set token to issue
     * @param _setAmount                    Amount to issue
     * @param _inputToken                   Input token to pay with
     * @param _maxAmountInputToken          Maximum amount of input token to spend
     * @param _swapDataDebtForCollateral    Data (token addresses and fee levels) to describe the swap path from Debt to collateral token
     * @param _swapDataInputToken           Data (token addresses and fee levels) to describe the swap path from input to collateral token
     */
    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
        external
        override
        nonReentrant
    {
        uint256 inputTokenBalanceBefore = IERC20(_inputToken).balanceOf(address(this));
        IERC20(_inputToken).transferFrom(msg.sender, address(this), _maxAmountInputToken);
        _initiateIssuance(
            _setToken,
            _setAmount,
            _inputToken,
            _maxAmountInputToken,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
        uint256 amountToReturn = IERC20(_inputToken).balanceOf(address(this)).sub(inputTokenBalanceBefore);
        IERC20(_inputToken).transfer(msg.sender, amountToReturn);
    }

    /**
     * Trigger issuance of set token paying with Eth
     *
     * @param _setToken                     Set token to issue
     * @param _setAmount                    Amount to issue
     * @param _swapDataDebtForCollateral    Data (token addresses and fee levels) to describe the swap path from Debt to collateral token
     * @param _swapDataInputToken           Data (token addresses and fee levels) to describe the swap path from eth to collateral token
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _setAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
        external
        override
        payable
        nonReentrant
    {
        uint256 inputTokenBalanceBefore = IERC20(addresses.weth).balanceOf(address(this));
        IWETH(addresses.weth).deposit{value: msg.value}();
        _initiateIssuance(
            _setToken,
            _setAmount,
            DEXAdapter.ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
        uint256 amountToReturn = IERC20(addresses.weth).balanceOf(address(this)).sub(inputTokenBalanceBefore);
        IWETH(addresses.weth).withdraw(amountToReturn);
        msg.sender.transfer(amountToReturn);
    }

    function issueSetFromExactERC20(
        ISetToken _setToken,
        uint256 _minSetAmount,
        address _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        external
        nonReentrant
        returns(uint256)
    {
        return _issueSetFromExactInput(
            _setToken,
            _minSetAmount,
            _inputToken,
            _inputTokenAmount,
            _swapDataDebtForCollateral,
            _swapDataInputToken,
            _priceEstimateInflator,
            _maxDust
        );
    }

    function issueSetFromExactETH(
        ISetToken _setToken,
        uint256 _minSetAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        external
        payable
        nonReentrant
        returns(uint256)
    {
        return _issueSetFromExactInput(
            _setToken,
            _minSetAmount,
            DEXAdapter.ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputToken,
            _priceEstimateInflator,
            _maxDust
        );
    }

    function _issueSetFromExactInput(
        ISetToken _setToken,
        uint256 _minSetAmount,
        address _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        internal
        returns(uint256)
    {
        require(_inputTokenAmount > _maxDust, "FlashMintLeveragedExtended: _inputToken must be more than _maxDust");

        if(_inputToken == DEXAdapter.ETH_ADDRESS) {
            IWETH(addresses.weth).deposit{value: msg.value}();
        } else {
            IERC20(_inputToken).transferFrom(msg.sender, address(this), _inputTokenAmount);
        }

        while (_inputTokenAmount > _maxDust) {
            uint256 inputTokenAmountSpent = _initiateIssuanceAndReturnInputAmountSpent(
                _setToken,
                _minSetAmount,
                _inputToken,
                _inputTokenAmount,
                _swapDataDebtForCollateral,
                _swapDataInputToken
            );
            _inputTokenAmount = _inputTokenAmount - inputTokenAmountSpent;
            uint256 priceEstimate = _minSetAmount.mul(_priceEstimateInflator).div(inputTokenAmountSpent);
            _minSetAmount = _inputTokenAmount.mul(priceEstimate).div(1 ether);
        }

        // TODO: Decide what to do with the dust (maybe swap to eth and return as gas subsidy)

        return _inputTokenAmount;
    }

    function _initiateIssuanceAndReturnInputAmountSpent(
        ISetToken _setToken,
        uint256 _minSetAmount,
        address _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    ) 
        internal
        returns (uint256)
    {
        uint256 inputTokenBalanceBefore;
        if( _inputToken == DEXAdapter.ETH_ADDRESS) {
            inputTokenBalanceBefore = IERC20(addresses.weth).balanceOf(address(this));
        } else {
            inputTokenBalanceBefore = IERC20(_inputToken).balanceOf(address(this));
        }
        _initiateIssuance(
            _setToken,
            _minSetAmount,
            _inputToken,
            _inputTokenAmount,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );

        uint256 inputTokenBalanceAfter;
        if( _inputToken == DEXAdapter.ETH_ADDRESS) {
            inputTokenBalanceAfter = IERC20(addresses.weth).balanceOf(address(this));
        } else {
            inputTokenBalanceAfter = IERC20(_inputToken).balanceOf(address(this));
        }

        return inputTokenBalanceBefore.sub(inputTokenBalanceAfter);
    }

    /**
     * Makes up the collateral token shortfall with user specified ERC20 token
     *
     * @param _collateralToken             Address of the collateral token
     * @param _collateralTokenShortfall    Shortfall of collateral token that was not covered by selling the debt tokens
     * @param _originalSender              Address of the original sender to return the tokens to
     * @param _inputToken                  Input token to pay with
     * @param _maxAmountInputToken         Maximum amount of input token to spend
     *
     * @return Amount of input token spent
     */
    function _makeUpShortfallWithERC20(
        address _collateralToken,
        uint256 _collateralTokenShortfall,
        address _originalSender,
        IERC20 _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        override
        returns (uint256)
    {
        if(address(_inputToken) == _collateralToken){
            return _collateralTokenShortfall;
        } else {
            uint256 amountInputToken = _swapInputForCollateralToken(
                _collateralToken,
                _collateralTokenShortfall,
                address(_inputToken),
                _maxAmountInputToken,
                _swapData
            );
            return amountInputToken;
        }
    }

    /**
     * Makes up the collateral token shortfall with native eth
     *
     * @param _collateralToken             Address of the collateral token
     * @param _collateralTokenShortfall    Shortfall of collateral token that was not covered by selling the debt tokens
     * @param _originalSender              Address of the original sender to return the tokens to
     * @param _maxAmountEth                Maximum amount of eth to pay
     *
     * @return Amount of eth spent
     */
    function _makeUpShortfallWithETH(
        address _collateralToken,
        uint256 _collateralTokenShortfall,
        address _originalSender,
        uint256 _maxAmountEth,
        DEXAdapter.SwapData memory _swapData

    )
        internal
        override
        returns(uint256)
    {

        uint256 amountEth = _swapInputForCollateralToken(
            _collateralToken,
            _collateralTokenShortfall,
            addresses.weth,
            _maxAmountEth,
            _swapData
        );

        return amountEth;
    }

    /**
     * Sells the collateral tokens for the selected output ERC20 and returns that to the user
     *
     * @param _collateralToken       Address of the collateral token
     * @param _collateralRemaining   Amount of the collateral token remaining after buying required debt tokens
     * @param _originalSender        Address of the original sender to return the tokens to
     * @param _outputToken           Address of token to return to the user
     * @param _minAmountOutputToken  Minimum amount of output token to return to the user
     * @param _swapData              Data (token path and fee levels) describing the swap path from Collateral Token to Output token
     *
     * @return Amount of output token returned to the user
     */
    function _liquidateCollateralTokensForERC20(
        address _collateralToken,
        uint256 _collateralRemaining,
        address _originalSender,
        IERC20 _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        override
        returns (uint256)
    {
        if(address(_outputToken) == _collateralToken){
            return _collateralRemaining;
        }
        uint256 outputTokenAmount = _swapCollateralForOutputToken(
            _collateralToken,
            _collateralRemaining,
            address(_outputToken),
            _minAmountOutputToken,
            _swapData
        );
        return outputTokenAmount;
    }

    /**
     * Sells the remaining collateral tokens for weth, withdraws that and returns native eth to the user
     *
     * @param _collateralToken            Address of the collateral token
     * @param _collateralRemaining        Amount of the collateral token remaining after buying required debt tokens
     * @param _originalSender             Address of the original sender to return the eth to
     * @param _minAmountOutputToken       Minimum amount of output token to return to user
     * @param _swapData                   Data (token path and fee levels) describing the swap path from Collateral Token to eth
     *
     * @return Amount of eth returned to the user
     */
    function _liquidateCollateralTokensForETH(
        address _collateralToken,
        uint256 _collateralRemaining,
        address _originalSender,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        override
        isValidPath(_swapData.path, _collateralToken, addresses.weth)
        returns(uint256)
    {
        uint256 ethAmount = _swapCollateralForOutputToken(
            _collateralToken,
            _collateralRemaining,
            addresses.weth,
            _minAmountOutputToken,
            _swapData
        );
        return ethAmount;
    }


}

