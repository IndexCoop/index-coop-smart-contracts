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
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

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
contract FlashMintLeveragedExtended is FlashMintLeveraged, Ownable {


    uint256 public maxIterations = 10;
    uint256 public maxGasRebate = 0.01 ether;

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
    ) Ownable()
        public
        FlashMintLeveraged(_addresses, _setController, _debtIssuanceModule, _aaveLeverageModule, _aaveV3Pool, _vault)
    {
    }

    /**
     * Redeems a variable amount of setTokens to return exactly the specified amount of outputToken to the user
     *
     * @param _setToken                                Set token to redeem
     * @param _maxSetAmount                            Maximum amout of set tokens to redeem
     * @param _outputToken                             Address of output token to return to the user
     * @param _outputTokenAmount                       Amount of output token to return to the user
     * @param _swapDataCollateralForDebt               Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataCollateralForOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Output TOken
     * @param _swapDataDebtForCollateral               Data (token path and fee levels) describing the swap from Debt Token to Collateral Token
     * @param _swapDataOutputTokenForCollateral        Data (token path and fee levels) describing the swap from Output Token to Collateral Token
     * @param _swapDataOutputTokenForETH               Data (token path and fee levels) describing the swap from Output Token to ETH
     * @param _priceEstimateInflator                   Factor by which to increase the estimated price from the previous iteration to account for used up liquidity
     * @param _maxDust                                 Minimum accuracy for approximating the output token amount. Excess will be swapped to eth and returned to user as gas rebate
     */
    function redeemSetForExactERC20(
        ISetToken _setToken,
        uint256 _maxSetAmount,
        address _outputToken,
        uint256 _outputTokenAmount,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataCollateralForOutputToken,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataOutputTokenForCollateral,
        DEXAdapter.SwapData memory _swapDataOutputTokenForETH,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        external
        nonReentrant
        returns(uint256 setAmount)
    {
        uint256 setBalanceBefore = _setToken.balanceOf(msg.sender);
        uint256 outputTokenBalanceBefore = IERC20(_outputToken).balanceOf(address(this));
        _initiateRedemption(
            _setToken,
            _maxSetAmount,
            _outputToken,
            _outputTokenAmount,
            _swapDataCollateralForDebt,
            _swapDataCollateralForOutputToken
        );

        _issueSetFromExcessOutput(
            _setToken,
            _maxSetAmount,
            _outputToken,
            _outputTokenAmount,
            _swapDataDebtForCollateral,
            _swapDataOutputTokenForCollateral,
            _priceEstimateInflator,
            _maxDust,
            outputTokenBalanceBefore
        );
        _sendOutputTokenAndETHToUser(_outputToken, outputTokenBalanceBefore, _outputTokenAmount, _swapDataOutputTokenForETH);
        return setBalanceBefore.sub(_setToken.balanceOf(msg.sender));
    }

    /**
     * Redeems a variable amount of setTokens to return exactly the specified amount of ETH to the user
     *
     * @param _setToken                                Set token to redeem
     * @param _maxSetAmount                            Maximum amout of set tokens to redeem
     * @param _outputTokenAmount                       Amount of eth to return to the user
     * @param _swapDataCollateralForDebt               Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataCollateralForOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to eth
     * @param _swapDataDebtForCollateral               Data (token path and fee levels) describing the swap from Debt Token to Collateral Token
     * @param _swapDataOutputTokenForCollateral        Data (token path and fee levels) describing the swap from eth to Collateral Token
     * @param _priceEstimateInflator                   Factor by which to increase the estimated price from the previous iteration to account for used up liquidity
     * @param _maxDust                                 Minimum accuracy for approximating the eth amount. Excess will be swapped to eth and returned to user as gas rebate
     */
    function redeemSetForExactETH(
        ISetToken _setToken,
        uint256 _maxSetAmount,
        uint256 _outputTokenAmount,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataCollateralForOutputToken,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataOutputTokenForCollateral,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        external
        nonReentrant
        returns(uint256)
    {
        uint256 wethBalanceBefore = IERC20(addresses.weth).balanceOf(address(this));
        uint256 setBalanceBefore = _setToken.balanceOf(msg.sender);
        _initiateRedemption(
            _setToken,
            _maxSetAmount,
            DEXAdapter.ETH_ADDRESS,
            _outputTokenAmount,
            _swapDataCollateralForDebt,
            _swapDataCollateralForOutputToken
        );

        _issueSetFromExcessOutput(
            _setToken,
            _maxSetAmount,
            DEXAdapter.ETH_ADDRESS,
            _outputTokenAmount,
            _swapDataDebtForCollateral,
            _swapDataOutputTokenForCollateral,
            _priceEstimateInflator,
            _maxDust,
            wethBalanceBefore
        );
        uint256 wethObtained = IERC20(addresses.weth).balanceOf(address(this)).sub(wethBalanceBefore);
        require(wethObtained >= _outputTokenAmount, "IWO");
        require(wethObtained - _outputTokenAmount <= maxGasRebate, "MGR");
        IWETH(addresses.weth).withdraw(wethObtained);
        (payable(msg.sender)).sendValue(wethObtained);
        return setBalanceBefore.sub(_setToken.balanceOf(msg.sender));
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
        uint256 outputTokenAmount = IERC20(_outputToken).balanceOf(address(this)).sub(outputTokenBalanceBefore);
        IERC20(_outputToken).transfer(msg.sender, outputTokenAmount);
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

    /**
     * Issues a variable amount of set tokens for a fixed amount of input tokenss
     *
     * @param _setToken                                Set token to redeem
     * @param _minSetAmount                            Minimum amount of Set Tokens to issue
     * @param _inputToken                              Address of input token for which to issue set tokens
     * @param _inputTokenAmount                         Amount of inputToken to return to the user
     * @param _swapDataDebtForCollateral               Data (token path and fee levels) describing the swap from Debt Token to Collateral Token
     * @param _swapDataInputTokenForCollateral         Data (token path and fee levels) describing the swap from input token to Collateral Token
     * @param _swapDataInputTokenForETH                Data (token path and fee levels) describing the swap from unspent input token to ETH, to use as gas rebate
     * @param _priceEstimateInflator                   Factor by which to increase the estimated price from the previous iteration to account for used up liquidity
     * @param _maxDust                                 Minimum accuracy for approximating the input token amount. Excess will be swapped to input token and returned to user as gas rebate
     */
    function issueSetFromExactERC20(
        ISetToken _setToken,
        uint256 _minSetAmount,
        address _inputToken,
        uint256 _inputTokenAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputTokenForCollateral,
        DEXAdapter.SwapData memory _swapDataInputTokenForETH,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        external
        nonReentrant
        returns(uint256)
    {
        uint256 setBalanceBefore = _setToken.balanceOf(msg.sender);
        IERC20(_inputToken).transferFrom(msg.sender, address(this), _inputTokenAmount);

        uint256 inputAmountLeft = _issueSetFromExactInput(
            _setToken,
            _minSetAmount,
            _inputToken,
            _inputTokenAmount,
            _swapDataDebtForCollateral,
            _swapDataInputTokenForCollateral,
            _priceEstimateInflator,
            _maxDust
        );

        _swapTokenForETHAndReturnToUser(_inputToken, inputAmountLeft, _swapDataInputTokenForETH);
        return _setToken.balanceOf(msg.sender).sub(setBalanceBefore);
    }

    /**
     * Issues a variable amount of set tokens for a fixed amount of eth
     *
     * @param _setToken                                Set token to redeem
     * @param _minSetAmount                            Minimum amount of Set Tokens to issue
     * @param _swapDataDebtForCollateral               Data (token path and fee levels) describing the swap from Debt Token to Collateral Token
     * @param _swapDataInputTokenForCollateral         Data (token path and fee levels) describing the swap from eth to Collateral Token
     * @param _priceEstimateInflator                   Factor by which to increase the estimated price from the previous iteration to account for used up liquidity
     * @param _maxDust                                 Minimum accuracy for approximating the eth amount. Excess will be swapped to eth and returned to user as gas rebate
     */
    function issueSetFromExactETH(
        ISetToken _setToken,
        uint256 _minSetAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputTokenForCollateral,
        uint256 _priceEstimateInflator,
        uint256 _maxDust
    )
        external
        payable
        nonReentrant
        returns(uint256)
    {
        uint256 setBalanceBefore = _setToken.balanceOf(msg.sender);
        IWETH(addresses.weth).deposit{value: msg.value}();
        uint256 inputTokenLeft = _issueSetFromExactInput(
            _setToken,
            _minSetAmount,
            DEXAdapter.ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputTokenForCollateral,
            _priceEstimateInflator,
            _maxDust
        );
        IWETH(addresses.weth).withdraw(inputTokenLeft);
        msg.sender.transfer(inputTokenLeft);
        return _setToken.balanceOf(msg.sender).sub(setBalanceBefore);
    }

    /**
     * Update maximum number of iterations allowed in the fixed input issuance / fixed output redemption
     *
     * @param _maxIterations           New value to set for maximum number of iterations. If "maxDust" is not met by that iteration the respective transaction will fail
     */
    function setMaxIterations(uint256 _maxIterations) external onlyOwner {
        maxIterations = _maxIterations;
    }

    /**
     * Update maximum value of gas rebate returned to user in fixed input issuance / fixed output redemption
     *
     * @param _maxGasRebate           New value to set for max gas rebate. Gas rebate above this value is assumed to be a misconfiguration and the respective transaction will fail
     */
    function setMaxGasRebate(uint256 _maxGasRebate) external onlyOwner {
        maxGasRebate = _maxGasRebate;
    }

    /* ============ Internal Functions ============ */

    // @dev Use excess amout of output token to re-issue set tokens
    function _issueSetFromExcessOutput(
        ISetToken _setToken,
        uint256 _maxSetAmount,
        address _outputToken,
        uint256 _outputTokenAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken,
        uint256 _priceEstimateInflator,
        uint256 _maxDust,
        uint256 _outputTokenBalanceBefore
    )
    internal 
    {
        uint256 obtainedOutputAmount;
        if( _outputToken == DEXAdapter.ETH_ADDRESS) {
            obtainedOutputAmount = IERC20(addresses.weth).balanceOf(address(this)).sub(_outputTokenBalanceBefore);
        } else {
            obtainedOutputAmount = IERC20(_outputToken).balanceOf(address(this)).sub(_outputTokenBalanceBefore);
        }

        uint256 excessOutputTokenAmount = obtainedOutputAmount.sub(_outputTokenAmount);
        uint256 priceEstimate = _maxSetAmount.mul(_priceEstimateInflator).div(obtainedOutputAmount);
        uint256 minSetAmount = excessOutputTokenAmount.mul(priceEstimate).div(1 ether);
        _issueSetFromExactInput(
            _setToken,
            minSetAmount,
            _outputToken,
            excessOutputTokenAmount,
            _swapDataDebtForCollateral,
            _swapDataInputToken,
            _priceEstimateInflator,
            _maxDust
        );
    }




    // @dev Send requested amount of Output tokens to user, sell excess for eth and send to user as gas rebate
    function _sendOutputTokenAndETHToUser(
        address _outputToken,
        uint256 _outputTokenBalanceBefore,
        uint256 _outputTokenAmount,
        DEXAdapter.SwapData memory _swapDataOutputTokenForETH
    )
        internal
    {
        uint256 outputTokenObtained = IERC20(_outputToken).balanceOf(address(this)).sub(_outputTokenBalanceBefore);
        require(outputTokenObtained >= _outputTokenAmount, "IOTO");
        IERC20(_outputToken).transfer(msg.sender, _outputTokenAmount);
        _swapTokenForETHAndReturnToUser(_outputToken, outputTokenObtained - _outputTokenAmount, _swapDataOutputTokenForETH);
    }


    // @dev Issue Set Tokens for (approximately) the requested amount of input tokens. Works by first issuing minimum requested amount of set tokens and then iteratively using observed exchange rate on previous issuance to spend the remaining input tokens until the difference is les than the specivied _maxDust
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
        require(_inputTokenAmount > _maxDust, "MD");

        uint256 iterations = 0;
        while (_inputTokenAmount > _maxDust) {
            require(iterations < maxIterations, "MI");
            uint256 inputTokenAmountSpent = _initiateIssuanceAndReturnInputAmountSpent(
                _setToken,
                _minSetAmount,
                _inputToken,
                _inputTokenAmount,
                _swapDataDebtForCollateral,
                _swapDataInputToken
            );
            // Update remaining inputTokens left to be spent
            _inputTokenAmount = _inputTokenAmount - inputTokenAmountSpent;
            // Estimate price of setToken / inputToken, multiplying by provided factor to account for used up liquidity
            uint256 priceEstimate = _minSetAmount.mul(_priceEstimateInflator).div(inputTokenAmountSpent);
            // Amount to  issue in next iteration is equal to the left over amount of input tokens times the price estimate from the previous step
            _minSetAmount = _inputTokenAmount.mul(priceEstimate).div(1 ether);
            iterations++;
        }

        return _inputTokenAmount;
    }

    // @dev Extends original _initiateIssuance by returning the amount of input tokens that was spent in issuance. (requisite for approximation algorithm above
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
     * @dev Same as in FlashMintLeveraged but without transfering input token from the user (since this is now done once at the very beginning to avoid transfering multiple times back and forth)
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
     * @dev Same as in FlashMintLeveraged but without transfering eth from the user (since this is now done once at the very beginning to avoid transfering multiple times back and forth)
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
     * @dev Same as in FlashMintLeveraged but without transfering output tokens to the user (since this is now done once at the very end to avoid transfering multiple times back and forth)
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
     * @dev Same as in FlashMintLeveraged but without transfering eth to the user (since this is now done once at the very end to avoid transfering multiple times back and forth)
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


    /**
     * @dev Used to swap excess input / output tokens for eth and return to user as gas rebate
     */
    function _swapTokenForETHAndReturnToUser(
        address _inputToken,
        uint256 _inputAmount,
        DEXAdapter.SwapData memory _swapData
    )
        internal
    {
        uint256 ethObtained;
        if(_inputToken == addresses.weth) {
            ethObtained = _inputAmount;
        } else {
            // Setting path to empty array means opting out of the gas rebate swap
            if(_swapData.path.length == 0) {
                return;
            }
            require(_swapData.path[0] == _inputToken, "ITNF");
            require(_swapData.path[_swapData.path.length - 1] == addresses.weth, "FlashMintLeveragedExtended: WETH not last in path");
            ethObtained = addresses.swapExactTokensForTokens(
                _inputAmount,
                0, 
                _swapData
            );
        }
        require(ethObtained <= maxGasRebate, "MGR");

        IWETH(addresses.weth).withdraw(ethObtained);
        msg.sender.transfer(ethObtained);
    }
}

