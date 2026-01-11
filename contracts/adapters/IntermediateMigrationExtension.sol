/*
    Copyright 2024 Index Coop

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
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ISwapRouter } from "../interfaces/external/ISwapRouter.sol";
import { IBalancerVault } from "../interfaces/IBalancerVault.sol";
import { IMorpho } from "../interfaces/IMorpho.sol";
import { IPoolAddressesProvider } from "../interfaces/IPoolAddressesProvider.sol";
import { INonfungiblePositionManager } from "../interfaces/external/uniswap-v3/INonfungiblePositionManager.sol";

import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ITradeModule } from "../interfaces/ITradeModule.sol";

import { MigrationExtension } from "./MigrationExtension.sol";

/**
 * @title IntermediateMigrationExtension
 * @author Index Coop
 * @notice Extension for migrating ETH2xFLI from holding ETH2X to holding an IntermediateToken.
 *
 * This extends MigrationExtension to handle an extra layer of wrapping:
 * - Original MigrationExtension: WETH → aWETH → wrappedSetToken (simple)
 * - This extension: WETH → aWETH → nestedSetToken (leveraged, e.g. ETH2X) → wrappedSetToken (IntermediateToken)
 *
 * Key differences from MigrationExtension:
 * 1. The wrappedSetToken (IntermediateToken) contains a nestedSetToken (ETH2X)
 * 2. The nestedSetToken is a leveraged token with aWETH equity and USDC debt
 * 3. When issuing nestedSetToken, we receive USDC (debt component) which we sell for WETH
 * 4. When redeeming nestedSetToken, we must buy USDC to pay back the debt
 * 5. Pool is WETH/IntermediateToken (same pattern as original WETH/wrappedSetToken)
 */
contract IntermediateMigrationExtension is MigrationExtension {
    using SafeMath for uint256;

    /* ============ Structs ============ */

    /**
     * @dev Struct to hold constructor arguments to avoid stack too deep errors.
     */
    struct ConstructorParams {
        IBaseManager manager;
        IERC20 underlyingToken;
        IERC20 aaveToken;
        IERC20 debtToken;
        ISetToken wrappedSetToken;
        ISetToken nestedSetToken;
        ITradeModule tradeModule;
        IDebtIssuanceModule issuanceModule;
        IDebtIssuanceModule nestedSetTokenIssuanceModule;
        INonfungiblePositionManager nonfungiblePositionManager;
        IPoolAddressesProvider addressProvider;
        IMorpho morpho;
        IBalancerVault balancer;
        ISwapRouter swapRouter;
    }

    /* ========== State Variables ========= */

    IERC20 public immutable debtToken;              // USDC (debt component of nestedSetToken)
    ISetToken public immutable nestedSetToken;      // ETH2X (the leveraged token inside IntermediateToken)
    IDebtIssuanceModule public immutable nestedSetTokenIssuanceModule;  // For issuing/redeeming nestedSetToken
    ISwapRouter public immutable swapRouter;        // Uniswap V3 SwapRouter for USDC swaps

    uint24 public constant SWAP_FEE = 500;          // 0.05% pool fee for USDC/WETH swaps

    /* ============ Constructor ============ */

    /**
     * @notice Initializes the IntermediateMigrationExtension with all required parameters.
     * @param _params Struct containing all constructor parameters.
     */
    constructor(ConstructorParams memory _params)
        public
        MigrationExtension(
            _params.manager,
            _params.underlyingToken,
            _params.aaveToken,
            _params.wrappedSetToken,
            _params.tradeModule,
            _params.issuanceModule,
            _params.nonfungiblePositionManager,
            _params.addressProvider,
            _params.morpho,
            _params.balancer
        )
    {
        debtToken = _params.debtToken;
        nestedSetToken = _params.nestedSetToken;
        nestedSetTokenIssuanceModule = _params.nestedSetTokenIssuanceModule;
        swapRouter = _params.swapRouter;
    }

    /* ========== Internal Functions (Overrides) ========== */

    /**
     * @dev Issues the required amount of IntermediateToken for the liquidity increase.
     * This is more complex than the base implementation because we need to:
     * 1. Calculate how much nestedSetToken (ETH2X) is needed for IntermediateToken
     * 2. Calculate how much aWETH is needed for nestedSetToken
     * 3. Supply WETH to Aave → get aWETH
     * 4. Issue nestedSetToken (pay aWETH equity, receive USDC debt)
     * 5. Issue IntermediateToken (pay nestedSetToken)
     * 6. Sell USDC for WETH (helps repay flash loan)
     *
     * @param _wrappedSetTokenSupplyLiquidityAmount The amount of IntermediateToken to supply.
     */
    function _issueRequiredWrappedSetToken(uint256 _wrappedSetTokenSupplyLiquidityAmount) internal override {
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (_wrappedSetTokenSupplyLiquidityAmount <= wrappedSetTokenBalance) return;

        uint256 intermediateIssueAmount = _wrappedSetTokenSupplyLiquidityAmount.sub(wrappedSetTokenBalance);

        // Get how much nestedSetToken (ETH2X) is needed for IntermediateToken
        (address[] memory intComponents, uint256[] memory intUnits,) = issuanceModule.getRequiredComponentIssuanceUnits(
            wrappedSetToken,  // IntermediateToken
            intermediateIssueAmount
        );
        require(intComponents.length == 1, "IntermediateMigrationExtension: invalid intermediate token composition");
        require(intComponents[0] == address(nestedSetToken), "IntermediateMigrationExtension: intermediate token underlying mismatch");
        uint256 nestedSetTokenNeeded = intUnits[0];

        // Get how much aWETH is needed for nestedSetToken (leveraged: equity + debt)
        (address[] memory nestedComponents, uint256[] memory nestedEquityUnits,) = nestedSetTokenIssuanceModule.getRequiredComponentIssuanceUnits(
            nestedSetToken,  // ETH2X
            nestedSetTokenNeeded
        );

        // Find aWETH requirement (equity component)
        uint256 aaveRequired = _findAaveRequirement(nestedComponents, nestedEquityUnits);
        require(aaveRequired > 0, "IntermediateMigrationExtension: aWETH not found in nestedSetToken components");

        // 1. WETH → aWETH via Aave
        underlyingToken.approve(address(POOL), aaveRequired);
        POOL.supply(address(underlyingToken), aaveRequired, address(this), 0);

        // 2. Issue nestedSetToken (pay aWETH equity, receive USDC debt)
        aaveToken.approve(address(nestedSetTokenIssuanceModule), aaveRequired);
        nestedSetTokenIssuanceModule.issue(nestedSetToken, nestedSetTokenNeeded, address(this));

        // 3. Issue IntermediateToken (pay nestedSetToken)
        IERC20(address(nestedSetToken)).approve(address(issuanceModule), nestedSetTokenNeeded);
        issuanceModule.issue(wrappedSetToken, intermediateIssueAmount, address(this));

        // 4. Sell USDC for WETH (helps repay flash loan)
        uint256 usdcBalance = debtToken.balanceOf(address(this));
        if (usdcBalance > 0) {
            _sellDebtTokenForUnderlying(usdcBalance);
        }
    }

    /**
     * @dev Redeems any excess IntermediateToken after liquidity decrease.
     * This is more complex than the base implementation because we need to:
     * 1. Redeem IntermediateToken → nestedSetToken
     * 2. Buy USDC with WETH (to pay back debt)
     * 3. Redeem nestedSetToken (pay USDC debt, receive aWETH equity)
     * 4. Withdraw aWETH → WETH from Aave
     */
    function _redeemExcessWrappedSetToken() internal override {
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (wrappedSetTokenBalance == 0) return;

        // 1. Redeem IntermediateToken → nestedSetToken
        IERC20(address(wrappedSetToken)).approve(address(issuanceModule), wrappedSetTokenBalance);
        issuanceModule.redeem(wrappedSetToken, wrappedSetTokenBalance, address(this));

        uint256 nestedSetTokenBalance = nestedSetToken.balanceOf(address(this));
        if (nestedSetTokenBalance == 0) return;

        // 2. Get USDC required to redeem nestedSetToken (the debt we need to pay back)
        (address[] memory components,, uint256[] memory redemptionDebtUnits) = nestedSetTokenIssuanceModule.getRequiredComponentRedemptionUnits(
            nestedSetToken,
            nestedSetTokenBalance
        );

        // Find USDC debt requirement and buy it with WETH
        uint256 usdcRequired = _findDebtRequirement(components, redemptionDebtUnits);
        if (usdcRequired > 0) {
            _buyDebtTokenWithUnderlying(usdcRequired);
            debtToken.approve(address(nestedSetTokenIssuanceModule), usdcRequired);
        }

        // 3. Redeem nestedSetToken (pay USDC debt, receive aWETH equity)
        IERC20(address(nestedSetToken)).approve(address(nestedSetTokenIssuanceModule), nestedSetTokenBalance);
        nestedSetTokenIssuanceModule.redeem(nestedSetToken, nestedSetTokenBalance, address(this));

        // 4. Withdraw aWETH → WETH from Aave
        uint256 aaveBalance = aaveToken.balanceOf(address(this));
        if (aaveBalance > 0) {
            aaveToken.approve(address(POOL), aaveBalance);
            POOL.withdraw(address(underlyingToken), aaveBalance, address(this));
        }
    }

    /**
     * @dev Finds the aWETH requirement from component arrays.
     */
    function _findAaveRequirement(
        address[] memory _components,
        uint256[] memory _units
    ) internal view returns (uint256) {
        for (uint256 i = 0; i < _components.length; i++) {
            if (_components[i] == address(aaveToken)) {
                return _units[i];
            }
        }
        return 0;
    }

    /**
     * @dev Finds the USDC debt requirement from component arrays.
     */
    function _findDebtRequirement(
        address[] memory _components,
        uint256[] memory _debtUnits
    ) internal view returns (uint256) {
        for (uint256 i = 0; i < _components.length; i++) {
            if (_components[i] == address(debtToken) && _debtUnits[i] > 0) {
                return _debtUnits[i];
            }
        }
        return 0;
    }

    /**
     * @dev Sells USDC (debt token) for WETH (underlying) using Uniswap V3.
     * This is called after issuing nestedSetToken to convert the received USDC
     * back to WETH, which helps repay the flash loan.
     * @param _amount The amount of USDC to sell.
     */
    function _sellDebtTokenForUnderlying(uint256 _amount) internal {
        debtToken.approve(address(swapRouter), _amount);
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(debtToken),
            tokenOut: address(underlyingToken),
            fee: SWAP_FEE,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: _amount,
            amountOutMinimum: 0,  // In production, should add slippage protection
            sqrtPriceLimitX96: 0
        });
        swapRouter.exactInputSingle(params);
    }

    /**
     * @dev Buys USDC (debt token) with WETH (underlying) using Uniswap V3.
     * This is called before redeeming nestedSetToken because we need USDC
     * to pay back the debt component.
     * @param _amount The amount of USDC to buy.
     */
    function _buyDebtTokenWithUnderlying(uint256 _amount) internal {
        // Use exactOutputSingle to get exactly the amount of USDC we need
        // First, approve more WETH than needed (we'll get refund if less is used)
        uint256 maxWethIn = _amount.mul(1e12).mul(105).div(100);  // USDC is 6 decimals, WETH is 18, add 5% buffer
        underlyingToken.approve(address(swapRouter), maxWethIn);

        ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
            tokenIn: address(underlyingToken),
            tokenOut: address(debtToken),
            fee: SWAP_FEE,
            recipient: address(this),
            deadline: block.timestamp,
            amountOut: _amount,
            amountInMaximum: maxWethIn,
            sqrtPriceLimitX96: 0
        });
        swapRouter.exactOutputSingle(params);
    }
}
