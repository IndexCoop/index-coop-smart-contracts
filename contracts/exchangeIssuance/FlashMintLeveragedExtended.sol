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
        require(_inputTokenAmount > _maxDust, "FlashMintLeveragedExtended: _inputToken must be more than _maxDust");
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
        return _maxDust;
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
        uint256 _inputTokenAmount = msg.value;
        while (_inputTokenAmount > _maxDust) {
            uint256 inputTokenAmountSpent = _initiateIssuanceAndReturnInputAmountSpent(
                _setToken,
                _minSetAmount,
                DEXAdapter.ETH_ADDRESS,
                _inputTokenAmount,
                _swapDataDebtForCollateral,
                _swapDataInputToken
            );
            _inputTokenAmount = _inputTokenAmount - inputTokenAmountSpent;
            uint256 priceEstimate = _minSetAmount.mul(_priceEstimateInflator).div(inputTokenAmountSpent);
            _minSetAmount = _inputTokenAmount.mul(priceEstimate).div(1 ether);
        }
        return _maxDust;
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
            inputTokenBalanceBefore = address(this).balance;
        } else {
            inputTokenBalanceBefore = IERC20(_inputToken).balanceOf(msg.sender);
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
            inputTokenBalanceAfter = address(this).balance;
        } else {
            inputTokenBalanceAfter = IERC20(_inputToken).balanceOf(msg.sender);
        }

        return inputTokenBalanceBefore.sub(inputTokenBalanceAfter);
    }

}

