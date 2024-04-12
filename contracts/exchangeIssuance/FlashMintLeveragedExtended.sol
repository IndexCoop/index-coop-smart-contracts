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

    // TODO: Adjust fixed set amount methods to account for new input token handling

}

