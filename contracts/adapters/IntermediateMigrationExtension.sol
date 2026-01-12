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
 * 5. Pool is ETH2X/IntermediateToken (single-hop trade) instead of WETH/wrappedSetToken
 * 6. Liquidity management uses nestedSetToken (ETH2X) instead of underlyingToken (WETH)
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
     * @dev Conducts the migration utilizing ETH2X/IntermediateToken pool.
     * Overrides parent to handle the different pool structure where both tokens
     * need to be issued rather than one coming from flash loan directly.
     *
     * Flow:
     * 1. Flash loan WETH
     * 2. Issue both ETH2X and IntermediateToken for pool liquidity
     * 3. Add liquidity to ETH2X/IntermediateToken pool
     * 4. Trade ETH2X → IntermediateToken (single-hop)
     * 5. Remove liquidity
     * 6. Redeem all tokens back to WETH
     * 7. Repay flash loan
     *
     * @param decodedParams The decoded set of parameters needed for migration.
     */
    function _migrate(DecodedParams memory decodedParams) internal override {
        // For ETH2X/IntermediateToken pool, isUnderlyingToken0 means "is ETH2X token0?"
        bool isNestedToken0 = decodedParams.isUnderlyingToken0;

        uint256 nestedSetTokenSupplyAmount = isNestedToken0
            ? decodedParams.supplyLiquidityAmount0Desired
            : decodedParams.supplyLiquidityAmount1Desired;
        uint256 wrappedSetTokenSupplyAmount = isNestedToken0
            ? decodedParams.supplyLiquidityAmount1Desired
            : decodedParams.supplyLiquidityAmount0Desired;

        // Issue both tokens needed for pool liquidity
        _issueRequiredPoolTokens(nestedSetTokenSupplyAmount, wrappedSetTokenSupplyAmount);

        // Increase liquidity (uses overridden method that handles nestedSetToken)
        uint128 liquidity = _increaseLiquidityPosition(
            decodedParams.supplyLiquidityAmount0Desired,
            decodedParams.supplyLiquidityAmount1Desired,
            decodedParams.supplyLiquidityAmount0Min,
            decodedParams.supplyLiquidityAmount1Min,
            decodedParams.tokenId,
            isNestedToken0
        );

        // Execute trade (ETH2X → IntermediateToken)
        _executeMigrationTrade(decodedParams);

        // Decrease liquidity
        _decreaseLiquidityPosition(
            decodedParams.tokenId,
            liquidity,
            decodedParams.redeemLiquidityAmount0Min,
            decodedParams.redeemLiquidityAmount1Min
        );

        // Redeem excess tokens back to WETH
        _redeemExcessWrappedSetToken();
    }

    /**
     * @dev Issues both nestedSetToken (ETH2X) and wrappedSetToken (IntermediateToken) for pool liquidity.
     * For ETH2X/IntermediateToken pool, we need:
     * 1. ETH2X for one side of the pool
     * 2. IntermediateToken for the other side (which requires ETH2X to issue)
     *
     * Total ETH2X needed = eth2xForPool + eth2xForIntermediateToken
     *
     * @param _nestedSetTokenSupplyAmount The amount of ETH2X needed for pool liquidity.
     * @param _wrappedSetTokenSupplyAmount The amount of IntermediateToken needed for pool liquidity.
     */
    function _issueRequiredPoolTokens(
        uint256 _nestedSetTokenSupplyAmount,
        uint256 _wrappedSetTokenSupplyAmount
    ) internal {
        // Calculate existing balances
        uint256 nestedSetTokenBalance = nestedSetToken.balanceOf(address(this));
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));

        // Calculate how much IntermediateToken we need to issue
        uint256 intermediateIssueAmount = 0;
        if (_wrappedSetTokenSupplyAmount > wrappedSetTokenBalance) {
            intermediateIssueAmount = _wrappedSetTokenSupplyAmount.sub(wrappedSetTokenBalance);
        }

        // Calculate how much ETH2X is needed to issue IntermediateToken
        uint256 nestedForIntermediate = 0;
        if (intermediateIssueAmount > 0) {
            (address[] memory intComponents, uint256[] memory intUnits,) = issuanceModule.getRequiredComponentIssuanceUnits(
                wrappedSetToken,
                intermediateIssueAmount
            );
            require(intComponents.length == 1, "IntermediateMigrationExtension: invalid intermediate token composition");
            require(intComponents[0] == address(nestedSetToken), "IntermediateMigrationExtension: intermediate token underlying mismatch");
            nestedForIntermediate = intUnits[0];
        }

        // Calculate additional ETH2X needed for pool (beyond what we have and what we'll consume for IntermediateToken)
        uint256 nestedNeededAfterIntermediate = _nestedSetTokenSupplyAmount;
        uint256 totalNestedToIssue = 0;

        // We need: nestedForPool + nestedForIntermediate
        // We have: nestedSetTokenBalance
        // After issuing IntermediateToken, we'll have: nestedSetTokenBalance - nestedForIntermediate (if we had enough) or 0
        // Actually, we need to issue ALL the nested tokens first, then use some for IntermediateToken

        uint256 totalNestedNeeded = nestedForIntermediate.add(_nestedSetTokenSupplyAmount);
        if (totalNestedNeeded > nestedSetTokenBalance) {
            totalNestedToIssue = totalNestedNeeded.sub(nestedSetTokenBalance);
        }

        // Issue nestedSetToken (ETH2X) if needed
        if (totalNestedToIssue > 0) {
            // Get how much aWETH is needed
            (address[] memory nestedComponents, uint256[] memory nestedEquityUnits,) = nestedSetTokenIssuanceModule.getRequiredComponentIssuanceUnits(
                nestedSetToken,
                totalNestedToIssue
            );

            uint256 aaveRequired = _findAaveRequirement(nestedComponents, nestedEquityUnits);
            require(aaveRequired > 0, "IntermediateMigrationExtension: aWETH not found in nestedSetToken components");

            // WETH → aWETH via Aave
            underlyingToken.approve(address(POOL), aaveRequired);
            POOL.supply(address(underlyingToken), aaveRequired, address(this), 0);

            // Issue nestedSetToken (pay aWETH equity, receive USDC debt)
            aaveToken.approve(address(nestedSetTokenIssuanceModule), aaveRequired);
            nestedSetTokenIssuanceModule.issue(nestedSetToken, totalNestedToIssue, address(this));
        }

        // Issue IntermediateToken if needed (consuming some of the ETH2X we just issued)
        if (intermediateIssueAmount > 0) {
            IERC20(address(nestedSetToken)).approve(address(issuanceModule), nestedForIntermediate);
            issuanceModule.issue(wrappedSetToken, intermediateIssueAmount, address(this));
        }

        // Sell USDC for WETH (helps repay flash loan)
        uint256 usdcBalance = debtToken.balanceOf(address(this));
        if (usdcBalance > 0) {
            _sellDebtTokenForUnderlying(usdcBalance);
        }
    }

    /**
     * @dev Not used in this extension. Pool tokens are issued via _issueRequiredPoolTokens.
     * This override prevents the parent's implementation from being called.
     */
    function _issueRequiredWrappedSetToken(uint256) internal override {
        // No-op: Pool token issuance is handled by _issueRequiredPoolTokens in _migrate override
    }

    /**
     * @dev Redeems any excess pool tokens (ETH2X and IntermediateToken) after liquidity decrease.
     * For ETH2X/IntermediateToken pool, after decreasing liquidity we may have both tokens.
     *
     * Steps:
     * 1. Redeem IntermediateToken → ETH2X (if any)
     * 2. Redeem all ETH2X → aWETH → WETH (requires buying USDC to pay debt)
     */
    function _redeemExcessWrappedSetToken() internal override {
        // 1. Redeem any IntermediateToken → ETH2X
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (wrappedSetTokenBalance > 0) {
            IERC20(address(wrappedSetToken)).approve(address(issuanceModule), wrappedSetTokenBalance);
            issuanceModule.redeem(wrappedSetToken, wrappedSetTokenBalance, address(this));
        }

        // 2. Redeem all ETH2X → aWETH → WETH
        // Note: ETH2X balance includes both:
        // - ETH2X received from redeeming IntermediateToken above
        // - ETH2X received directly from decreasing pool liquidity
        uint256 nestedSetTokenBalance = nestedSetToken.balanceOf(address(this));
        if (nestedSetTokenBalance > 0) {
            // Get USDC required to redeem nestedSetToken (the debt we need to pay back)
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

            // Redeem nestedSetToken (pay USDC debt, receive aWETH equity)
            IERC20(address(nestedSetToken)).approve(address(nestedSetTokenIssuanceModule), nestedSetTokenBalance);
            nestedSetTokenIssuanceModule.redeem(nestedSetToken, nestedSetTokenBalance, address(this));
        }

        // 3. Withdraw aWETH → WETH from Aave
        uint256 aaveBalance = aaveToken.balanceOf(address(this));
        if (aaveBalance > 0) {
            aaveToken.approve(address(POOL), aaveBalance);
            POOL.withdraw(address(underlyingToken), aaveBalance, address(this));
        }
    }

    /**
     * @dev Executes the migration trade. Overrides parent to trade:
     * nestedSetToken (ETH2X) → wrappedSetToken (IntermediateToken)
     * instead of underlyingToken (WETH) → wrappedSetToken.
     *
     * The exchange data should specify a single-hop path: ETH2X → IntermediateToken
     * using the ETH2X/IntermediateToken pool.
     *
     * Note: In this context, `underlyingTradeUnits` is repurposed to mean
     * the amount of nestedSetToken to trade.
     *
     * @param decodedParams The decoded parameters containing trade info.
     */
    function _executeMigrationTrade(DecodedParams memory decodedParams) internal override {
        _trade(
            decodedParams.exchangeName,
            address(nestedSetToken),           // ETH2X (instead of WETH)
            decodedParams.underlyingTradeUnits,
            address(wrappedSetToken),          // IntermediateToken
            decodedParams.wrappedSetTokenTradeUnits,
            decodedParams.exchangeData
        );
    }

    /**
     * @dev Internal function to mint a new liquidity position in the Uniswap V3 pool.
     * Overrides parent to use nestedSetToken/wrappedSetToken pool instead of underlyingToken/wrappedSetToken.
     * @param _amount0Desired The desired amount of token0 to be added as liquidity.
     * @param _amount1Desired The desired amount of token1 to be added as liquidity.
     * @param _amount0Min The minimum amount of token0 to be added as liquidity.
     * @param _amount1Min The minimum amount of token1 to be added as liquidity.
     * @param _tickLower The lower end of the desired tick range for the position.
     * @param _tickUpper The upper end of the desired tick range for the position.
     * @param _fee The fee tier of the Uniswap V3 pool in which to add liquidity.
     * @param _isNestedToken0 True if the nestedSetToken is token0, false if it is token1.
     */
    function _mintLiquidityPosition(
        uint256 _amount0Desired,
        uint256 _amount1Desired,
        uint256 _amount0Min,
        uint256 _amount1Min,
        int24 _tickLower,
        int24 _tickUpper,
        uint24 _fee,
        bool _isNestedToken0
    ) internal override {
        // Sort tokens and amounts (nestedSetToken/wrappedSetToken instead of underlyingToken/wrappedSetToken)
        (
            address token0,
            address token1,
            uint256 nestedAmount,
            uint256 wrappedSetTokenAmount
        ) = _isNestedToken0
            ? (address(nestedSetToken), address(wrappedSetToken), _amount0Desired, _amount1Desired)
            : (address(wrappedSetToken), address(nestedSetToken), _amount1Desired, _amount0Desired);

        // Approve tokens
        if (nestedAmount > 0) {
            IERC20(address(nestedSetToken)).approve(address(nonfungiblePositionManager), nestedAmount);
        }
        if (wrappedSetTokenAmount > 0) {
            wrappedSetToken.approve(address(nonfungiblePositionManager), wrappedSetTokenAmount);
        }

        // Mint liquidity position
        INonfungiblePositionManager.MintParams memory mintParams = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: _fee,
            tickLower: _tickLower,
            tickUpper: _tickUpper,
            amount0Desired: _amount0Desired,
            amount1Desired: _amount1Desired,
            amount0Min: _amount0Min,
            amount1Min: _amount1Min,
            recipient: address(this),
            deadline: block.timestamp
        });
        (uint256 tokenId,,,) = nonfungiblePositionManager.mint(mintParams);
        tokenIds.push(tokenId);
    }

    /**
     * @dev Internal function to increase liquidity in a Uniswap V3 pool position.
     * Overrides parent to use nestedSetToken instead of underlyingToken.
     * @param _amount0Desired The desired amount of token0 to be added as liquidity.
     * @param _amount1Desired The desired amount of token1 to be added as liquidity.
     * @param _amount0Min The minimum amount of token0 to be added as liquidity.
     * @param _amount1Min The minimum amount of token1 to be added as liquidity.
     * @param _tokenId The ID of the UniV3 LP Token for which liquidity is being increased.
     * @param _isNestedToken0 True if the nestedSetToken is token0, false if it is token1.
     * @return liquidity The new liquidity amount as a result of the increase.
     */
    function _increaseLiquidityPosition(
        uint256 _amount0Desired,
        uint256 _amount1Desired,
        uint256 _amount0Min,
        uint256 _amount1Min,
        uint256 _tokenId,
        bool _isNestedToken0
    )
        internal
        override
        returns (uint128 liquidity)
    {
        (uint256 nestedAmount, uint256 wrappedSetTokenAmount) = _isNestedToken0
            ? (_amount0Desired, _amount1Desired)
            : (_amount1Desired, _amount0Desired);

        // Approve tokens (nestedSetToken instead of underlyingToken)
        if (nestedAmount > 0) {
            IERC20(address(nestedSetToken)).approve(address(nonfungiblePositionManager), nestedAmount);
        }
        if (wrappedSetTokenAmount > 0) {
            wrappedSetToken.approve(address(nonfungiblePositionManager), wrappedSetTokenAmount);
        }

        // Increase liquidity
        INonfungiblePositionManager.IncreaseLiquidityParams memory increaseParams = INonfungiblePositionManager.IncreaseLiquidityParams({
            tokenId: _tokenId,
            amount0Desired: _amount0Desired,
            amount1Desired: _amount1Desired,
            amount0Min: _amount0Min,
            amount1Min: _amount1Min,
            deadline: block.timestamp
        });
        (liquidity,,) = nonfungiblePositionManager.increaseLiquidity(increaseParams);
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
