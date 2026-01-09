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
import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IBalancerVault } from "../interfaces/IBalancerVault.sol";
import { IMorpho } from "../interfaces/IMorpho.sol";
import { FlashLoanSimpleReceiverBase } from "../lib/FlashLoanSimpleReceiverBase.sol";
import { IPoolAddressesProvider } from "../interfaces/IPoolAddressesProvider.sol";

import { INonfungiblePositionManager } from "../interfaces/external/uniswap-v3/INonfungiblePositionManager.sol";
import { IUniswapV3Pool } from "../interfaces/external/uniswap-v3/IUniswapV3Pool.sol";

import { BaseExtension } from "../lib/BaseExtension.sol";
import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { ITradeModule } from "../interfaces/ITradeModule.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title IntermediateMigrationExtension
 * @author Index Coop
 * @notice Extension for migrating ETH2xFLI from holding ETH2X to holding an IntermediateToken (ETH2XFW).
 * This is a modified version of MigrationExtension that adds an extra layer of wrapping:
 * - Original: WETH → aWETH → ETH2X
 * - This version: WETH → aWETH → ETH2X → IntermediateToken
 *
 * The key differences from MigrationExtension:
 * 1. Adds `intermediateToken` state variable
 * 2. Liquidity pair is ETH2X/IntermediateToken (not WETH/ETH2X)
 * 3. Trade is ETH2X → IntermediateToken (not WETH → ETH2X)
 * 4. Additional issuance/redemption steps for IntermediateToken
 */
contract IntermediateMigrationExtension is BaseExtension, FlashLoanSimpleReceiverBase, IERC721Receiver {
    using PreciseUnitMath for uint256;
    using SafeCast for int256;
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    /* ============ Structs ============ */

    struct DecodedParams {
        uint256 supplyLiquidityAmount0Desired;
        uint256 supplyLiquidityAmount1Desired;
        uint256 supplyLiquidityAmount0Min;
        uint256 supplyLiquidityAmount1Min;
        uint256 tokenId;
        string exchangeName;
        uint256 wrappedSetTokenTradeUnits;      // ETH2X units to trade (sendToken)
        uint256 intermediateTokenTradeUnits;    // IntermediateToken units expected (receiveToken)
        bytes exchangeData;
        uint256 redeemLiquidityAmount0Min;
        uint256 redeemLiquidityAmount1Min;
        bool isWrappedSetToken0;                // True if ETH2X is token0 in the pool
    }

    /* ========== State Variables ========= */

    ISetToken public immutable setToken;
    IERC20 public immutable underlyingToken;       // WETH
    IERC20 public immutable aaveToken;             // aWETH
    ISetToken public immutable wrappedSetToken;    // ETH2X
    ISetToken public immutable intermediateToken;  // IntermediateToken (ETH2XFW)
    ITradeModule public immutable tradeModule;
    IDebtIssuanceModule public immutable issuanceModule;
    INonfungiblePositionManager public immutable nonfungiblePositionManager;
    IMorpho public immutable morpho;
    IBalancerVault public immutable balancer;

    uint256[] public tokenIds; // UniV3 LP Token IDs

    /* ============ Constructor ============ */

    /**
     * @notice Initializes the IntermediateMigrationExtension with immutable migration variables.
     * @param _manager BaseManager contract for managing the SetToken's operations and permissions.
     * @param _underlyingToken Address of the underlying token (WETH).
     * @param _aaveToken Address of Aave's wrapped collateral asset (aWETH).
     * @param _wrappedSetToken SetToken that consists of Aave's wrapped collateral (ETH2X).
     * @param _intermediateToken SetToken that wraps ETH2X (IntermediateToken/ETH2XFW).
     * @param _tradeModule TradeModule address for executing trades on behalf of the SetToken.
     * @param _issuanceModule IssuanceModule address for managing issuance and redemption.
     * @param _nonfungiblePositionManager Uniswap V3's NonFungiblePositionManager.
     * @param _addressProvider Aave V3's Pool Address Provider.
     * @param _morpho Morpho flash loan provider.
     * @param _balancer Balancer vault for flash loans.
     */
    constructor(
        IBaseManager _manager,
        IERC20 _underlyingToken,
        IERC20 _aaveToken,
        ISetToken _wrappedSetToken,
        ISetToken _intermediateToken,
        ITradeModule _tradeModule,
        IDebtIssuanceModule _issuanceModule,
        INonfungiblePositionManager _nonfungiblePositionManager,
        IPoolAddressesProvider _addressProvider,
        IMorpho _morpho,
        IBalancerVault _balancer
    )
        public
        BaseExtension(_manager)
        FlashLoanSimpleReceiverBase(_addressProvider)
    {
        manager = _manager;
        setToken = manager.setToken();
        underlyingToken = _underlyingToken;
        aaveToken = _aaveToken;
        wrappedSetToken = _wrappedSetToken;
        intermediateToken = _intermediateToken;
        tradeModule = _tradeModule;
        issuanceModule = _issuanceModule;
        nonfungiblePositionManager = _nonfungiblePositionManager;
        morpho = _morpho;
        balancer = _balancer;
    }

    /* ========== External Functions ========== */

    /**
     * @notice OPERATOR ONLY: Initializes the Set Token on the Trade Module.
     */
    function initialize() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(tradeModule.initialize.selector, setToken);
        invokeManager(address(tradeModule), data);
    }

    /**
     * @notice OPERATOR ONLY: Executes a trade on a supported DEX.
     */
    function trade(
        string memory _exchangeName,
        address _sendToken,
        uint256 _sendQuantity,
        address _receiveToken,
        uint256 _minReceiveQuantity,
        bytes memory _data
    )
        external
        onlyOperator
    {
        _trade(
            _exchangeName,
            _sendToken,
            _sendQuantity,
            _receiveToken,
            _minReceiveQuantity,
            _data
        );
    }

    /**
     * @notice OPERATOR ONLY: Mints a new liquidity position in the Uniswap V3 pool.
     * Pool is ETH2X/IntermediateToken.
     */
    function mintLiquidityPosition(
        uint256 _amount0Desired,
        uint256 _amount1Desired,
        uint256 _amount0Min,
        uint256 _amount1Min,
        int24 _tickLower,
        int24 _tickUpper,
        uint24 _fee,
        bool _isWrappedSetToken0
    )
        external
        onlyOperator
    {
        _mintLiquidityPosition(
            _amount0Desired,
            _amount1Desired,
            _amount0Min,
            _amount1Min,
            _tickLower,
            _tickUpper,
            _fee,
            _isWrappedSetToken0
        );
    }

    /**
     * @notice OPERATOR ONLY: Increases liquidity position in the Uniswap V3 pool.
     */
    function increaseLiquidityPosition(
        uint256 _amount0Desired,
        uint256 _amount1Desired,
        uint256 _amount0Min,
        uint256 _amount1Min,
        uint256 _tokenId,
        bool _isWrappedSetToken0
    )
        external
        onlyOperator
        returns (uint128 liquidity)
    {
        liquidity = _increaseLiquidityPosition(
            _amount0Desired,
            _amount1Desired,
            _amount0Min,
            _amount1Min,
            _tokenId,
            _isWrappedSetToken0
        );
    }

    /**
     * @notice OPERATOR ONLY: Decreases and collects from a liquidity position.
     */
    function decreaseLiquidityPosition(
        uint256 _tokenId,
        uint128 _liquidity,
        uint256 _amount0Min,
        uint256 _amount1Min
    )
        external
        onlyOperator
    {
        _decreaseLiquidityPosition(
            _tokenId,
            _liquidity,
            _amount0Min,
            _amount1Min
        );
    }

    /**
     * @notice OPERATOR ONLY: Migrates ETH2xFLI from holding ETH2X to holding IntermediateToken
     * using Aave Flashloan.
     */
    function migrateAave(
        DecodedParams memory _decodedParams,
        uint256 _underlyingLoanAmount,
        uint256 _maxSubsidy
    )
        external
        onlyOperator
        returns (uint256 underlyingOutputAmount)
    {
        // Subsidize the migration
        if (_maxSubsidy > 0) {
            underlyingToken.transferFrom(msg.sender, address(this), _maxSubsidy);
        }

        // Encode migration parameters for flash loan callback
        bytes memory params = abi.encode(_decodedParams);

        // Request flash loan for the underlying token
        POOL.flashLoanSimple(
            address(this),
            address(underlyingToken),
            _underlyingLoanAmount,
            params,
            0
        );

        // Return remaining underlying token to the operator
        underlyingOutputAmount = _returnExcessUnderlying();
    }

    /**
     * @notice OPERATOR ONLY: Migrates ETH2xFLI using Balancer Flashloan.
     */
    function migrateBalancer(
        DecodedParams memory _decodedParams,
        uint256 _underlyingLoanAmount,
        uint256 _maxSubsidy
    )
        external
        onlyOperator
        returns (uint256 underlyingOutputAmount)
    {
        // Subsidize the migration
        if (_maxSubsidy > 0) {
            underlyingToken.transferFrom(msg.sender, address(this), _maxSubsidy);
        }

        // Encode migration parameters for flash loan callback
        bytes memory params = abi.encode(_decodedParams);
        address[] memory tokens = new address[](1);
        tokens[0] = address(underlyingToken);
        uint256[] memory amounts = new  uint256[](1);
        amounts[0] = _underlyingLoanAmount;

        // Request flash loan for the underlying token
        balancer.flashLoan(address(this), tokens, amounts, params);

        // Return remaining underlying token to the operator
        underlyingOutputAmount = _returnExcessUnderlying();
    }

    /**
     * @dev Callback function for Balancer flashloan
    */
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory params
    ) external {
        require(msg.sender == address(balancer));
        // Decode parameters and migrate
        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));
        _migrate(decodedParams);

        underlyingToken.transfer(address(balancer), amounts[0] + feeAmounts[0]);
    }

    /**
     * @notice OPERATOR ONLY: Migrates ETH2xFLI using Morpho Flashloan.
     */
    function migrateMorpho(
        DecodedParams memory _decodedParams,
        uint256 _underlyingLoanAmount,
        uint256 _maxSubsidy
    )
        external
        onlyOperator
        returns (uint256 underlyingOutputAmount)
    {
        // Subsidize the migration
        if (_maxSubsidy > 0) {
            underlyingToken.transferFrom(msg.sender, address(this), _maxSubsidy);
        }

        // Encode migration parameters for flash loan callback
        bytes memory params = abi.encode(_decodedParams);

        // Request flash loan for the underlying token
        morpho.flashLoan(address(underlyingToken), _underlyingLoanAmount, params);

        // Return remaining underlying token to the operator
        underlyingOutputAmount = _returnExcessUnderlying();
    }

    /**
     * @dev Callback function for Morpho Flashloan
    */
    function onMorphoFlashLoan(uint256 assets, bytes calldata params) external
    {
        require(msg.sender == address(morpho), "IntermediateMigrationExtension: invalid flashloan sender");

        // Decode parameters and migrate
        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));
        _migrate(decodedParams);

        underlyingToken.approve(address(morpho), assets);
    }

    /**
     * @dev Callback function for Aave V3 flash loan.
     */
    function executeOperation(
        address, // asset
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    )
        external
        override
        returns (bool)
    {
        require(msg.sender == address(POOL), "IntermediateMigrationExtension: invalid flashloan sender");
        require(initiator == address(this), "IntermediateMigrationExtension: invalid flashloan initiator");

        // Decode parameters and migrate
        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));
        _migrate(decodedParams);

        underlyingToken.approve(address(POOL), amount + premium);
        return true;
    }

    /**
     * @notice Receives ERC721 tokens, required for Uniswap V3 LP NFT handling.
     */
    function onERC721Received(
        address, // operator
        address, // from
        uint256, // tokenId
        bytes calldata // data
    )
        external
        override
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    /**
     * @notice OPERATOR ONLY: Transfers any residual balances to the operator's address.
     */
    function sweepTokens(address _token) external onlyOperator {
        IERC20 token = IERC20(_token);
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "IntermediateMigrationExtension: no balance to sweep");
        token.transfer(manager.operator(), balance);
    }

    /* ========== Internal Functions ========== */

    /**
     * @dev Conducts the actual migration steps:
     * 1. Issue ETH2X and IntermediateToken
     * 2. Add ETH2X/IntermediateToken liquidity
     * 3. Trade ETH2xFLI's ETH2X → IntermediateToken
     * 4. Remove liquidity
     * 5. Redeem excess tokens back to WETH
     */
    function _migrate(DecodedParams memory decodedParams) internal {
        uint256 intermediateTokenSupplyLiquidityAmount = decodedParams.isWrappedSetToken0
            ? decodedParams.supplyLiquidityAmount1Desired
            : decodedParams.supplyLiquidityAmount0Desired;

        _issueRequiredTokens(intermediateTokenSupplyLiquidityAmount);

        uint128 liquidity = _increaseLiquidityPosition(
            decodedParams.supplyLiquidityAmount0Desired,
            decodedParams.supplyLiquidityAmount1Desired,
            decodedParams.supplyLiquidityAmount0Min,
            decodedParams.supplyLiquidityAmount1Min,
            decodedParams.tokenId,
            decodedParams.isWrappedSetToken0
        );

        // Trade ETH2X → IntermediateToken (different from original which was WETH → ETH2X)
        _trade(
            decodedParams.exchangeName,
            address(wrappedSetToken),           // sendToken: ETH2X
            decodedParams.wrappedSetTokenTradeUnits,
            address(intermediateToken),         // receiveToken: IntermediateToken
            decodedParams.intermediateTokenTradeUnits,
            decodedParams.exchangeData
        );

        _decreaseLiquidityPosition(
            decodedParams.tokenId,
            liquidity,
            decodedParams.redeemLiquidityAmount0Min,
            decodedParams.redeemLiquidityAmount1Min
        );

        _redeemExcessTokens();
    }

    /**
     * @dev Internal function to execute trades.
     */
    function _trade(
        string memory _exchangeName,
        address _sendToken,
        uint256 _sendQuantity,
        address _receiveToken,
        uint256 _minReceiveQuantity,
        bytes memory _data
    )
        internal
    {
        bytes memory callData = abi.encodeWithSignature(
            "trade(address,string,address,uint256,address,uint256,bytes)",
            setToken,
            _exchangeName,
            _sendToken,
            _sendQuantity,
            _receiveToken,
            _minReceiveQuantity,
            _data
        );
        invokeManager(address(tradeModule), callData);
    }

    /**
     * @dev Issues the required tokens for liquidity:
     * 1. Supply WETH to Aave → get aWETH
     * 2. Issue ETH2X using aWETH
     * 3. Issue IntermediateToken using ETH2X
     */
    function _issueRequiredTokens(uint256 _intermediateTokenSupplyLiquidityAmount) internal {
        uint256 intermediateTokenBalance = intermediateToken.balanceOf(address(this));
        if (_intermediateTokenSupplyLiquidityAmount > intermediateTokenBalance) {
            uint256 intermediateTokenIssueAmount = _intermediateTokenSupplyLiquidityAmount.sub(intermediateTokenBalance);

            // First, we need ETH2X to issue IntermediateToken
            // Get required ETH2X amount (IntermediateToken is 1:1 with ETH2X)
            (address[] memory intermediateAssets, uint256[] memory intermediateUnits,) = issuanceModule.getRequiredComponentIssuanceUnits(
                intermediateToken,
                intermediateTokenIssueAmount
            );
            require(intermediateAssets.length == 1, "IntermediateMigrationExtension: invalid intermediate token composition");
            require(intermediateAssets[0] == address(wrappedSetToken), "IntermediateMigrationExtension: intermediate token underlying mismatch");

            uint256 wrappedSetTokenRequired = intermediateUnits[0];

            // Now get required aWETH to issue ETH2X
            uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
            if (wrappedSetTokenRequired > wrappedSetTokenBalance) {
                uint256 wrappedSetTokenIssueAmount = wrappedSetTokenRequired.sub(wrappedSetTokenBalance);

                (address[] memory wrappedAssets, uint256[] memory wrappedUnits,) = issuanceModule.getRequiredComponentIssuanceUnits(
                    wrappedSetToken,
                    wrappedSetTokenIssueAmount
                );
                require(wrappedAssets.length == 1, "IntermediateMigrationExtension: invalid wrapped SetToken composition");
                require(wrappedAssets[0] == address(aaveToken), "IntermediateMigrationExtension: wrapped SetToken underlying mismatch");

                // Supply underlying for Aave wrapped token (WETH → aWETH)
                underlyingToken.approve(address(POOL), wrappedUnits[0]);
                POOL.supply(
                    address(underlyingToken),
                    wrappedUnits[0],
                    address(this),
                    0
                );

                // Issue ETH2X (wrappedSetToken)
                aaveToken.approve(address(issuanceModule), wrappedSetTokenIssueAmount);
                issuanceModule.issue(wrappedSetToken, wrappedSetTokenIssueAmount, address(this));
            }

            // Issue IntermediateToken using ETH2X
            IERC20(address(wrappedSetToken)).approve(address(issuanceModule), intermediateTokenIssueAmount);
            issuanceModule.issue(intermediateToken, intermediateTokenIssueAmount, address(this));
        }
    }

    /**
     * @dev Redeems excess tokens back to WETH:
     * 1. Redeem IntermediateToken → ETH2X
     * 2. Redeem ETH2X → aWETH
     * 3. Withdraw aWETH → WETH
     */
    function _redeemExcessTokens() internal {
        // First redeem IntermediateToken → ETH2X
        uint256 intermediateTokenBalance = intermediateToken.balanceOf(address(this));
        if (intermediateTokenBalance > 0) {
            IERC20(address(intermediateToken)).approve(address(issuanceModule), intermediateTokenBalance);
            issuanceModule.redeem(intermediateToken, intermediateTokenBalance, address(this));
        }

        // Then redeem ETH2X → aWETH
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (wrappedSetTokenBalance > 0) {
            IERC20(address(wrappedSetToken)).approve(address(issuanceModule), wrappedSetTokenBalance);
            issuanceModule.redeem(wrappedSetToken, wrappedSetTokenBalance, address(this));

            // Withdraw underlying from Aave (aWETH → WETH)
            uint256 aaveBalance = aaveToken.balanceOf(address(this));
            aaveToken.approve(address(POOL), aaveBalance);
            POOL.withdraw(
                address(underlyingToken),
                aaveBalance,
                address(this)
            );
        }
    }

    /**
     * @dev Internal function to mint a new liquidity position.
     * Pool is ETH2X/IntermediateToken.
     */
    function _mintLiquidityPosition(
        uint256 _amount0Desired,
        uint256 _amount1Desired,
        uint256 _amount0Min,
        uint256 _amount1Min,
        int24 _tickLower,
        int24 _tickUpper,
        uint24 _fee,
        bool _isWrappedSetToken0
    ) internal {
        // Sort tokens and amounts
        (
            address token0,
            address token1,
            uint256 wrappedSetTokenAmount,
            uint256 intermediateTokenAmount
        ) = _isWrappedSetToken0
            ? (address(wrappedSetToken), address(intermediateToken), _amount0Desired, _amount1Desired)
            : (address(intermediateToken), address(wrappedSetToken), _amount1Desired, _amount0Desired);

        // Approve tokens
        if (wrappedSetTokenAmount > 0) {
            IERC20(address(wrappedSetToken)).approve(address(nonfungiblePositionManager), wrappedSetTokenAmount);
        }
        if (intermediateTokenAmount > 0) {
            IERC20(address(intermediateToken)).approve(address(nonfungiblePositionManager), intermediateTokenAmount);
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
     * @dev Internal function to increase liquidity.
     * Pool is ETH2X/IntermediateToken.
     */
    function _increaseLiquidityPosition(
        uint256 _amount0Desired,
        uint256 _amount1Desired,
        uint256 _amount0Min,
        uint256 _amount1Min,
        uint256 _tokenId,
        bool _isWrappedSetToken0
    )
        internal
        returns (uint128 liquidity)
    {
        (uint256 wrappedSetTokenAmount, uint256 intermediateTokenAmount) = _isWrappedSetToken0
            ? (_amount0Desired, _amount1Desired)
            : (_amount1Desired, _amount0Desired);

        // Approve tokens
        if (wrappedSetTokenAmount > 0) {
            IERC20(address(wrappedSetToken)).approve(address(nonfungiblePositionManager), wrappedSetTokenAmount);
        }
        if (intermediateTokenAmount > 0) {
            IERC20(address(intermediateToken)).approve(address(nonfungiblePositionManager), intermediateTokenAmount);
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
     * @dev Internal function to decrease liquidity and collect.
     */
    function _decreaseLiquidityPosition(
        uint256 _tokenId,
        uint128 _liquidity,
        uint256 _amount0Min,
        uint256 _amount1Min
    ) internal {
        // Decrease liquidity
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
            tokenId: _tokenId,
            liquidity: _liquidity,
            amount0Min: _amount0Min,
            amount1Min: _amount1Min,
            deadline: block.timestamp
        });
        nonfungiblePositionManager.decreaseLiquidity(decreaseParams);

        // Collect liquidity and fees
        INonfungiblePositionManager.CollectParams memory params = INonfungiblePositionManager.CollectParams({
            tokenId: _tokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });
        nonfungiblePositionManager.collect(params);
    }

    /**
     * @dev Internal function to return any remaining WETH to the operator.
     */
    function _returnExcessUnderlying() internal returns (uint256 underlyingOutputAmount) {
        underlyingOutputAmount = underlyingToken.balanceOf(address(this));
        if (underlyingOutputAmount > 0) {
            underlyingToken.transfer(msg.sender, underlyingOutputAmount);
        }
    }
}
