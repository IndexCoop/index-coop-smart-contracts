/*
    Copyright 2021 Set Labs Inc.

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

import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IUniswapV2Factory } from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";

import { Account, Actions, ISoloMargin } from "../interfaces/ISoloMargin.sol";
import { DydxFlashloanBase } from "../interfaces/DydxFlashloanBase.sol";
import { ICallee } from "../interfaces/ICallee.sol";
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { ICompoundLeverageModule } from "../interfaces/ICompoundLeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title SimpleCompoundErc20FLIArb
 * @author Set Protocol
 *
 * Smart contract that performs creation redemption arbitrage on NAV of a FLI product against market price on Uniswap V2 or Sushiswap.
 * Note: This contract only is compatible with FLI with 1 cToken position as collateral and 1 debt position. This contract only works
 * with cERC20s and not cETH. Additionally, this contract is not compatible if WETH is the debt asset or if WETH is paired in the Uniswap pool
 */
contract SimpleCompoundErc20FLIArb is ICallee, DydxFlashloanBase {
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;

    /* ============ State ============ */

    IDebtIssuanceModule public debtIssuanceModule;
    IUniswapV2Router public router;
    IWETH public weth;
    ISoloMargin public solo;
    IUniswapV2Factory public factory;
    address payable public indexCoopTreasury;

    /* ============ Structs ============ */

    struct CollateralAndDebtInfo {
        address collateralCToken;
        address collateralAsset;
        address debtAsset;
        uint256 collateralNotional;
        uint256 debtNotional;
    }

    struct IssuanceArbData {
        ISetToken setToken;
        uint256 setTokenQuantity;
        uint256 tradeSlippage;
        uint256 repayAmount;
        bool isIssueArb;
        address setPoolToken;
        address collateralCToken;
        address collateralAsset;
        address debtAsset;
        uint256 collateralNotional;
        uint256 debtNotional;
    }

    /* ============ Constructor ============ */

    constructor(
        ISoloMargin _solo,
        IUniswapV2Router _router,
        IDebtIssuanceModule _debtIssuanceModule,
        IWETH _weth,
        IUniswapV2Factory _factory,
        address payable _indexCoopTreasury
    )
        public
        payable
    {
        solo = _solo;
        router = _router;
        weth = _weth;
        debtIssuanceModule = _debtIssuanceModule;
        factory = _factory;
        indexCoopTreasury = _indexCoopTreasury;

        // Deposit 2 wei from deployer to contract
        weth.deposit{value: msg.value}();

        // Approve to dYdX solo
        weth.approve(address(solo), PreciseUnitMath.maxUint256());

        // Approve WETH to router
        weth.approve(address(router), PreciseUnitMath.maxUint256());

        // Get operations and deposit 2 wei
        uint256 marketId = _getMarketIdFromTokenAddress(address(solo), address(weth));

        Actions.ActionArgs[] memory operations = new Actions.ActionArgs[](1);
        operations[0] = _getDepositAction(marketId, msg.value);

        Account.Info[] memory accountInfos = new Account.Info[](1);
        accountInfos[0] = _getAccountInfo();

        solo.operate(accountInfos, operations);
    }

    /* ============ External Functions ============ */

    /**
     * Approve unlimited to all components / tokens to contracts so we do not need to reapprove.
     * 
     * @param _setToken              Address of SetToken
     */
    function approveAll(ISetToken _setToken) external {
        // Approve SetToken to router
        _setToken.approve(address(router), PreciseUnitMath.maxUint256());

        address[] memory components = _setToken.getComponents();

        // IMPORTANT ASSUMPTION: Assume 1st position is cToken collateral asset. Will not work with more than 2 positions (non FLI)
        // Approve cToken collateral to debt issuance module
        IERC20(components[0]).approve(address(debtIssuanceModule), PreciseUnitMath.maxUint256());
        // Approve collateral underlying to cToken
        address underlying = ICErc20(components[0]).underlying();
        IERC20(underlying).approve(components[0], PreciseUnitMath.maxUint256());
        // Approve collateral underlying to router
        IERC20(underlying).approve(address(router), PreciseUnitMath.maxUint256());
        
        // IMPORTANT ASSUMPTION: Assume 2nd position is borrow asset. Will not work with more than 2 positions (non FLI)
        // Approve debt underlying to debt issuance module
        IERC20(components[1]).approve(address(debtIssuanceModule), PreciseUnitMath.maxUint256());
        // Approve debt underlying to router
        IERC20(components[1]).approve(address(router), PreciseUnitMath.maxUint256());
    }

    /**
     * Execute arbitrage for FLI token. The contract will:
     * 1) Flashloan WETH from dYdX
     * 2) Buy component required to issue (collateral asset) or redeem (borrow asset, SetToken)
     * 3) If issue, mint cToken
     * 4) Mint or redeem SetToken
     * 5) If redeem, redeem cToken
     * 6) Sell component received back from debt issuance module. For issue this is the debt and redeem is the collateral
     * 7) Unwrap WETH into ETH and refund gas to caller and send profits to treasury
     * 
     * IMPORTANT ASSUMPTION: Assume 1st position is cToken collateral asset and 2nd is borrow assset. Will not work with
     * more than 2 positions (non FLI)
     *
     * @param _setToken              Address of SetToken
     * @param _setTokenQuantity      Quantity of SetToken to arb
     * @param _loanAmount            Size of ETH loan from dYdX
     * @param _maxTradeSlippage      Max trade slippage in % (1% = 10e16)
     * @param _poolSetReserves       Balance of SetToken in LP address to check if balance changes when our tx is executed
     * @param _isIssueArb            Boolean indicating an issuance or redemption arb
     * @param _setPoolToken          Address of token that FLI is paired with
     */
    function executeFlashLoanArb(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        uint256 _loanAmount,
        uint256 _maxTradeSlippage,
        uint256 _poolSetReserves,
        bool _isIssueArb,
        address _setPoolToken
    )
        external
    {
        // Start tracking gas used
        uint256 gasBeginning = gasleft();

        uint256 actualPoolSetReserves = _setToken.balanceOf(
            factory.getPair(address(_setToken), _setPoolToken)
        );

        // Skip arb if Set is already sold into the pool greater than our tolerance, in case another bot frontruns
        if (
            (_isIssueArb && actualPoolSetReserves > _poolSetReserves)
            || (!_isIssueArb && actualPoolSetReserves < _poolSetReserves)
        ) {
            return;
        }

        CollateralAndDebtInfo memory collateralAndDebtInfo = _getCollateralAndDebtInfo(_setToken, _setTokenQuantity);

        // Get marketId from token address
        uint256 marketId = _getMarketIdFromTokenAddress(address(solo), address(weth));

        // Calculate repay amount (_loanAmount + (2 wei))
        // Approve transfer from
        uint256 repayAmount = _getRepaymentAmountInternal(_loanAmount);

        Actions.ActionArgs[] memory operations = new Actions.ActionArgs[](3);

        operations[0] = _getWithdrawAction(marketId, _loanAmount);
        operations[1] = _getCallAction(
            // Encode IssuanceArbData for callFunction
            abi.encode(
                IssuanceArbData({
                    setToken: _setToken,
                    setTokenQuantity: _setTokenQuantity,
                    tradeSlippage: _maxTradeSlippage,
                    isIssueArb: _isIssueArb,
                    repayAmount: repayAmount,
                    setPoolToken: _setPoolToken,
                    collateralCToken: collateralAndDebtInfo.collateralCToken,
                    collateralAsset: collateralAndDebtInfo.collateralAsset,
                    debtAsset: collateralAndDebtInfo.debtAsset,
                    collateralNotional: collateralAndDebtInfo.collateralNotional,
                    debtNotional: collateralAndDebtInfo.debtNotional
                })
            )
        );
        operations[2] = _getDepositAction(marketId, repayAmount);

        Account.Info[] memory accountInfos = new Account.Info[](1);
        accountInfos[0] = _getAccountInfo();

        // Send instructions to dYdX solo
        solo.operate(accountInfos, operations);

        uint256 balanceOfWeth = weth.balanceOf(address(this));
        weth.withdraw(balanceOfWeth);

        // Calculated gas spent
        uint256 ethSpent = gasBeginning.sub(gasleft()).mul(tx.gasprice);

        // Send ETH back to treasury and caller if ETH spent is less than balance of WETH
        if (ethSpent <= balanceOfWeth) {
            msg.sender.transfer(ethSpent);
            indexCoopTreasury.transfer(balanceOfWeth.sub(ethSpent));
        } else {
            // Else only send to caller
            msg.sender.transfer(balanceOfWeth);
        }
    }

    /**
     * Gets the ETH denominated spread for both issuance and redemption arbs
     *
     * @param _setToken              Address of SetToken
     * @param _setTokenQuantity      Quantity of SetToken to arb
     * @param _setPoolToken          Address of token that FLI is paired with
     */
    function getSpread(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        address _setPoolToken
    )
        external
        view
        returns(uint256, uint256)
    {
        CollateralAndDebtInfo memory collateralAndDebtInfo = _getCollateralAndDebtInfo(_setToken, _setTokenQuantity);

        uint256 issuanceSpread = _getIssuanceSpread(_setToken, _setTokenQuantity, collateralAndDebtInfo, _setPoolToken);

        uint256 redemptionSpread = _getRedemptionSpread(_setToken, _setTokenQuantity, collateralAndDebtInfo, _setPoolToken);

        return (issuanceSpread, redemptionSpread);
    }

    receive() external payable {} // solium-disable-line quotes

    /* ============ Internal Functions ============ */

    /**
     * Callback function for post loan where issuance and redemption logic are implemented
     */
    function callFunction(
        address _sender,
        Account.Info memory _account,
        bytes memory _data
    )
        public
        override
    {
        IssuanceArbData memory issueArbData = abi.decode(_data, (IssuanceArbData));

        if (issueArbData.isIssueArb) {
            _executeIssueArb(issueArbData);
        } else {
            _executeRedeemArb(issueArbData);
        }

        uint256 balanceOfWeth = weth.balanceOf(address(this));
        require(
            balanceOfWeth >= issueArbData.repayAmount,
            "Not enough funds to repay loan!"
        );
    }

    /**
     * Get info for components and units required for arb
     */
    function _getCollateralAndDebtInfo(ISetToken _setToken, uint256 _setTokenQuantity) internal view returns (CollateralAndDebtInfo memory) {
        (
            address[] memory components,
            uint256[] memory totalEquityUnits,
            uint256[] memory totalDebtUnits
        ) = debtIssuanceModule.getRequiredComponentIssuanceUnits(
            _setToken,
            _setTokenQuantity
        );

        // IMPORTANT ASSUMPTION: Assume 1st position is cToken collateral asset. Will not work with more than 2 positions (non FLI)
        // Only works with cERC20s not cETH
        address collateralAsset = ICErc20(components[0]).underlying();
        uint256 exchangeRate = ICErc20(components[0]).exchangeRateStored();
        uint256 collateralAmount = totalEquityUnits[0].preciseMulCeil(exchangeRate);

        // IMPORTANT ASSUMPTION: Assume 2nd position is debt asset. There will be rounding errors with debt on redeem arbs so we must
        // load the contract with sufficient debt assets
        return CollateralAndDebtInfo({
            collateralCToken: components[0],
            collateralAsset: collateralAsset,
            debtAsset: components[1],
            collateralNotional: collateralAmount,
            debtNotional: totalDebtUnits[1]
        });
    }

    /**
     * Execute an issuance arb
     */
    function _executeIssueArb(IssuanceArbData memory _issueArbData) internal {
        _tradeWethForComponent(_issueArbData.collateralAsset, _issueArbData.collateralNotional, _issueArbData.tradeSlippage);

        ICErc20(_issueArbData.collateralCToken).mint(_issueArbData.collateralNotional);

        debtIssuanceModule.issue(_issueArbData.setToken, _issueArbData.setTokenQuantity, address(this));

        _sellSetTokenForWeth(_issueArbData);

        _tradeComponentForWeth(_issueArbData.debtAsset, _issueArbData.debtNotional);
    }

    /**
     * Execute a redemption arb
     */
    function _executeRedeemArb(IssuanceArbData memory _issueArbData) internal {
        _tradeWethForComponent(_issueArbData.debtAsset, _issueArbData.debtNotional, _issueArbData.tradeSlippage);

        _buySetTokenWithWeth(_issueArbData);
        
        debtIssuanceModule.redeem(_issueArbData.setToken, _issueArbData.setTokenQuantity, address(this));

        ICErc20(_issueArbData.collateralCToken).redeemUnderlying(_issueArbData.collateralNotional);

        _tradeComponentForWeth(_issueArbData.collateralAsset, _issueArbData.collateralNotional);
    }

    /**
     * Trade WETH for exact component using Uniswap router
     */
    function _tradeWethForComponent(
        address _component,
        uint256 _notionalSendQuantity,
        uint256 _tradeSlippage
    )
        internal
    {
        // Construct path of trade starting with WETH and ending with the Set component
        address[] memory tradePath = new address[](2);
        tradePath[0] = address(weth);
        tradePath[1] = _component;

        // Calculate the min weth amount required for component
        uint256[] memory amounts = router.getAmountsIn(_notionalSendQuantity, tradePath);
        uint256 minWethAmount = amounts[0];
        
        // Calculate max weth inputted using the trade slippage param
        uint256 maxWethInput = _tradeSlippage.preciseMul(minWethAmount).add(minWethAmount);

        // Swap borrowed WETH for Set component
        router.swapTokensForExactTokens(_notionalSendQuantity, maxWethInput, tradePath, address(this), block.timestamp);
    }

    /**
     * Trade exact component for WETH using Uniswap router
     */
    function _tradeComponentForWeth(
        address _component,
        uint256 _notionalSendQuantity
    )
        internal
    {
        // Construct path of trade starting with component and ending with WETH
        address[] memory tradePath = new address[](2);
        tradePath[0] = _component;
        tradePath[1] = address(weth);

        router.swapExactTokensForTokens(_notionalSendQuantity, 0, tradePath, address(this), block.timestamp);
    }

    /**
     * Sell SetToken for WETH
     */
    function _sellSetTokenForWeth(IssuanceArbData memory _issueArbData) internal {
        // Construct path of trade starting with Set and ending with WETH
        address[] memory setSellPath;
        setSellPath = new address[](3);
        setSellPath[0] = address(_issueArbData.setToken);
        setSellPath[1] = _issueArbData.setPoolToken;
        setSellPath[2] = address(weth);

        router.swapExactTokensForTokens(_issueArbData.setTokenQuantity, 0, setSellPath, address(this), block.timestamp);
    }

    /**
     * Buy SetToken using WETH
     */
    function _buySetTokenWithWeth(IssuanceArbData memory _issueArbData) internal {
        // Construct path of trade starting with WETH and ending with Set
        address[] memory setBuyPath;
        setBuyPath = new address[](3);
        setBuyPath[0] = address(weth);
        setBuyPath[1] = _issueArbData.setPoolToken;
        setBuyPath[2] = address(_issueArbData.setToken);

        router.swapTokensForExactTokens(_issueArbData.setTokenQuantity, PreciseUnitMath.maxUint256(), setBuyPath, address(this), block.timestamp);
    }

    /**
     * Get spread for issuance arbs
     */
    function _getIssuanceSpread(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        CollateralAndDebtInfo memory _collateralAndDebtInfo,
        address _setPoolToken
    )
        internal
        view
        returns(uint256)
    {
        uint256 totalWethForEquity = _getTotalWethForComponent(_collateralAndDebtInfo.collateralAsset, _collateralAndDebtInfo.collateralNotional);

        // Calculate max WETH received from selling Set
        address[] memory setSellPath = new address[](3);
        setSellPath[0] = address(_setToken);
        setSellPath[1] = _setPoolToken;
        setSellPath[2] = address(weth);
        uint256[] memory sellAmounts = router.getAmountsOut(_setTokenQuantity, setSellPath);
        uint256 totalWethFromSet = sellAmounts[2];

        uint256 totalWethFromDebt = _getTotalWethFromComponent(_collateralAndDebtInfo.debtAsset, _collateralAndDebtInfo.debtNotional);

        if (totalWethForEquity <= totalWethFromSet.add(totalWethFromDebt)) {
            return totalWethFromSet.add(totalWethFromDebt).sub(totalWethForEquity);
        } else {
            return 0;
        }
    }

    /**
     * Get spread for redemption arbs
     */
    function _getRedemptionSpread(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        CollateralAndDebtInfo memory _collateralAndDebtInfo,
        address _setPoolToken
    )
        internal
        view
        returns(uint256)
    {
        uint256 totalWethForDebt = _getTotalWethForComponent(_collateralAndDebtInfo.debtAsset, _collateralAndDebtInfo.debtNotional);

        // Calculate WETH needed to buy Set
        address[] memory setBuyPath = new address[](3);
        setBuyPath[0] = address(weth);
        setBuyPath[1] = _setPoolToken;
        setBuyPath[2] = address(_setToken);
        uint256[] memory sellAmounts = router.getAmountsIn(_setTokenQuantity, setBuyPath);
        uint256 totalWethForSet = sellAmounts[0];

        uint256 totalWethFromEquity = _getTotalWethFromComponent(_collateralAndDebtInfo.collateralAsset, _collateralAndDebtInfo.collateralNotional);

        if (totalWethFromEquity >= totalWethForSet.add(totalWethForDebt)) {
            return totalWethFromEquity.sub(totalWethForSet).sub(totalWethForDebt);
        } else {
            return 0;
        }
    }

    /**
     * Get total WETH required to trade for component
     */
    function _getTotalWethForComponent(
        address _component,
        uint256 _totalUnit
    )
        internal
        view
        returns(uint256)
    {
        // Construct path of trade starting with WETH and ending with the Set component
        address[] memory componentBuyPath = new address[](2);
        componentBuyPath[0] = address(weth);
        componentBuyPath[1] = _component;

        uint256[] memory componentBuyAmounts;
        componentBuyAmounts = router.getAmountsIn(_totalUnit, componentBuyPath);

        return componentBuyAmounts[0];
    }

    /**
     * Get total WETH from trading component to WETH
     */
    function _getTotalWethFromComponent(
        address _component,
        uint256 _totalUnit
    )
        internal
        view
        returns(uint256)
    {
        // Construct path of trade starting with the Set component and ending with WETH
        address[] memory debtSellPath = new address[](2);
        debtSellPath[0] = _component;
        debtSellPath[1] = address(weth);

        uint256[] memory componentSellAmounts;
        componentSellAmounts = router.getAmountsOut(_totalUnit, debtSellPath);

        return componentSellAmounts[1];
    }
}
