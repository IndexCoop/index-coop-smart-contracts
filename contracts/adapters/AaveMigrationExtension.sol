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
 * @title AaveMigrationExtension
 * @author Index Coop
 * @notice This extension facilitates the migration of a SetToken's position from an unwrapped collateral
 * asset to another SetToken that consists solely of Aave's wrapped collateral asset. The migration is
 * executed through several steps: obtaining a flash loan of the unwrapped collateral, minting the required
 * quantity of the wrapped SetToken, adding liquidity to the Uniswap V3 pool, swapping the unwrapped
 * collateral for the wrapped SetToken, removing liquidity from the Uniswap V3 pool, and finally,
 * redeeming any excess wrapped SetToken. This process is specifically designed to efficiently migrate
 * the SetToken's collateral using only the TradeModule on the SetToken.
 */
contract AaveMigrationExtension is BaseExtension, FlashLoanSimpleReceiverBase, IERC721Receiver {
    using PreciseUnitMath for uint256;
    using SafeCast for int256;
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    /* ============ Structs ============ */

    struct DecodedParams {
        uint256 underlyingSupplyLiquidityAmount;
        uint256 wrappedSetTokenSupplyLiquidityAmount;
        uint256 tokenId;
        string exchangeName;
        uint256 underlyingTradeUnits;
        uint256 wrappedSetTokenTradeUnits;
        bytes exchangeData;
        uint256 underlyingRedeemLiquidityMinAmount;
        uint256 wrappedSetTokenRedeemLiquidityMinAmount;
    }

    /* ========== State Variables ========= */

    ISetToken public immutable setToken; 
    IERC20 public immutable underlyingToken;
    IERC20 public immutable aaveToken;
    ISetToken public immutable wrappedSetToken;
    ITradeModule public immutable tradeModule;
    IDebtIssuanceModule public immutable issuanceModule;
    INonfungiblePositionManager public immutable nonfungiblePositionManager;

    uint256[] public tokenIds;

    /* ============ Constructor ============ */

    /**
     * @notice Initializes the AaveMigrationExtension with immutable migration variables.
     * @param _manager BaseManager contract for managing the SetToken's operations and permissions.
     * @param _underlyingToken Address of the underlying token to be migrated.
     * @param _aaveToken Address of Aave's wrapped collateral asset.
     * @param _wrappedSetToken SetToken that consists solely of Aave's wrapped collateral asset.
     * @param _tradeModule TradeModule address for executing trades on behalf of the SetToken.
     * @param _issuanceModule IssuanceModule address for managing issuance and redemption of the Wrapped SetToken.
     * @param _nonfungiblePositionManager Uniswap V3's NonFungiblePositionManager for managing liquidity positions.
     * @param _addressProvider Aave V3's Pool Address Provider, used for accessing the Aave lending pool.
     */
    constructor(
        IBaseManager _manager, 
        IERC20 _underlyingToken,
        IERC20 _aaveToken,
        ISetToken _wrappedSetToken,
        ITradeModule _tradeModule,
        IDebtIssuanceModule _issuanceModule,
        INonfungiblePositionManager _nonfungiblePositionManager,
        IPoolAddressesProvider _addressProvider
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
        tradeModule = _tradeModule;
        issuanceModule = _issuanceModule;
        nonfungiblePositionManager = _nonfungiblePositionManager;
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
     * @dev Although the SetToken units are passed in for the send and receive quantities, the total quantity
     * sent and received is the quantity of SetToken units multiplied by the SetToken totalSupply.
     * @param _exchangeName The human-readable name of the exchange in the integrations registry.
     * @param _sendToken The address of the token being sent to the exchange.
     * @param _sendQuantity The amount of the token (in SetToken units) being sent to the exchange.
     * @param _receiveToken The address of the token being received from the exchange.
     * @param _minReceiveQuantity The minimum amount of the receive token (in SetToken units) expected from the exchange.
     * @param _data Arbitrary data used to construct the trade call data.
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
     * @param _underlyingSupplyLiquidityAmount The amount of the underlying token to add as liquidity.
     * @param _wrappedSetTokenSupplyLiquidityAmount The amount of the wrapped SetToken to add as liquidity.
     * @param _tickLower The lower end of the desired tick range for the position.
     * @param _tickUpper The upper end of the desired tick range for the position.
     * @param _fee The fee tier of the Uniswap V3 pool in which to add liquidity.
     */
    function mintLiquidityPosition(
        uint256 _underlyingSupplyLiquidityAmount,
        uint256 _wrappedSetTokenSupplyLiquidityAmount,
        int24 _tickLower,
        int24 _tickUpper,
        uint24 _fee
    )
        external
        onlyOperator
    {
        // Approve tokens
        if (_underlyingSupplyLiquidityAmount > 0) {
            underlyingToken.approve(address(nonfungiblePositionManager), _underlyingSupplyLiquidityAmount);
        }
        if (_wrappedSetTokenSupplyLiquidityAmount > 0) {
            wrappedSetToken.approve(address(nonfungiblePositionManager), _wrappedSetTokenSupplyLiquidityAmount);
        }

        // Mint liquidity position
        INonfungiblePositionManager.MintParams memory mintParams = INonfungiblePositionManager.MintParams({
            token0: address(wrappedSetToken),
            token1: address(underlyingToken),
            fee: _fee,
            tickLower: _tickLower,
            tickUpper: _tickUpper,
            amount0Desired: _wrappedSetTokenSupplyLiquidityAmount,
            amount1Desired: _underlyingSupplyLiquidityAmount,
            amount0Min: _wrappedSetTokenSupplyLiquidityAmount,
            amount1Min: _underlyingSupplyLiquidityAmount,
            recipient: address(this),
            deadline: block.timestamp
        });
        (uint256 tokenId,,,) = nonfungiblePositionManager.mint(mintParams);
        tokenIds.push(tokenId);
    }

    /**
     * @notice OPERATOR ONLY: Increases liquidity position in the Uniswap V3 pool.
     * @param _underlyingSupplyLiquidityAmount The amount of the underlying token to add as liquidity.
     * @param _wrappedSetTokenSupplyLiquidityAmount The amount of the wrapped SetToken to add as liquidity.
     * @param _tokenId The ID of the token for which liquidity is being increased.
     * @return liquidity The new liquidity amount as a result of the increase.
     */
    function increaseLiquidityPosition(
        uint256 _underlyingSupplyLiquidityAmount,
        uint256 _wrappedSetTokenSupplyLiquidityAmount,
        uint256 _tokenId
    )
        external
        onlyOperator
        returns (uint128 liquidity)
    {
        liquidity = _increaseLiquidityPosition(
            _underlyingSupplyLiquidityAmount,
            _wrappedSetTokenSupplyLiquidityAmount,
            _tokenId
        );
    }

    /**
     * @notice OPERATOR ONLY: Decreases and collects from a liquidity position in the Uniswap V3 pool.
     * @param _tokenId The ID of the token for which liquidity is being decreased.
     * @param _liquidity The amount of liquidity to decrease.
     * @param _underlyingRedeemLiquidityMinAmount The minimum amount of the underlying token to be redeemed from the decreased liquidity.
     * @param _wrappedSetTokenRedeemLiquidityMinAmount The minimum amount of the wrapped SetToken to be redeemed from the decreased liquidity.
     */
    function decreaseLiquidityPosition(
        uint256 _tokenId,
        uint128 _liquidity,
        uint256 _underlyingRedeemLiquidityMinAmount,
        uint256 _wrappedSetTokenRedeemLiquidityMinAmount
    )
        external
        onlyOperator
    {
        _decreaseLiquidityPosition(
            _tokenId,
            _liquidity,
            _underlyingRedeemLiquidityMinAmount,
            _wrappedSetTokenRedeemLiquidityMinAmount
        );
    }


    /**
     * @notice OPERATOR ONLY: Migrates a SetToken's position from an unwrapped collateral asset to another SetToken 
     * that consists solely of Aave's wrapped collateral asset
     * @param _decodedParams The decoded migration parameters.
     * @param _underlyingLoanAmount The amount of unwrapped collateral asset to be borrowed via flash loan.
     * @param _maxSubsidy The maximum amount of unwrapped collateral asset to be transferred to the Extension as a subsidy.
     * @return underlyingOutputAmount The amount of unwrapped collateral asset returned to the operator.
     */
    function migrate(
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
     * @dev Callback function for Aave V3 flash loan, executed post-loan. It decodes the provided parameters, conducts the migration, and repays the flash loan.
     * @param asset The asset borrowed in the flash loan.
     * @param amount The amount borrowed.
     * @param premium The additional fee charged for the flash loan.
     * @param initiator The initiator of the flash loan.
     * @param params Encoded migration parameters.
     * @return True if the operation is successful.
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    )
        external
        override
        returns (bool) 
    {
        require(msg.sender == address(POOL), "MigrationExtension: invalid flashloan sender");
        require(asset == address(underlyingToken), "MigrationExtension: invalid flashloan asset");
        require(initiator == address(this), "MigrationExtension: invalid flashloan initiator");

        // Decode parameters and migrate
        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));
        _migrate(decodedParams);

        underlyingToken.approve(address(POOL), amount + premium);
        return true;
    }

    /**
     * @notice Receives ERC721 tokens, required for Uniswap V3 LP NFT handling.
     * @dev Callback function for ERC721 token transfers, enabling the contract to receive Uniswap V3 LP NFTs. Always returns the selector to indicate successful receipt.
     * @return The selector of the `onERC721Received` function.
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
     * @notice OPERATOR ONLY: Transfers any residual balances of the underlying token, Aave's 
     * wrapped token, and the wrapped SetToken to the operator's address.
     * @dev This function is intended to recover tokens that might have been left behind
     * due to the migration process or any other operation. It ensures that the contract
     * does not retain any assets inadvertently. Only callable by the operator.
     */
    function sweepTokens() external onlyOperator {
        // Sweep underlying token
        uint256 underlyingTokenBalance = underlyingToken.balanceOf(address(this));
        if (underlyingTokenBalance > 0) {
            underlyingToken.transfer(manager.operator(), underlyingTokenBalance);
        }

        // Sweep Aave's wrapped token
        uint256 aaveTokenBalance = aaveToken.balanceOf(address(this));
        if (aaveTokenBalance > 0) {
            aaveToken.transfer(manager.operator(), aaveTokenBalance);
        }

        // Sweep wrapped SetToken
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (wrappedSetTokenBalance > 0) {
            wrappedSetToken.transfer(manager.operator(), wrappedSetTokenBalance);
        }
    }

    receive() external payable {}

    /* ========== Internal Functions ========== */

    /**
     * @dev Conducts the actual migration steps utilizing the decoded parameters from the flash loan callback.
     * @param decodedParams The decoded set of parameters needed for migration.
     */
    function _migrate(DecodedParams memory decodedParams) internal {
        _issueRequiredWrappedSetToken(decodedParams.wrappedSetTokenSupplyLiquidityAmount);

        uint128 liquidity = _increaseLiquidityPosition(
            decodedParams.underlyingSupplyLiquidityAmount,
            decodedParams.wrappedSetTokenSupplyLiquidityAmount,
            decodedParams.tokenId
        );

        _trade(
            decodedParams.exchangeName,
            address(underlyingToken),
            decodedParams.underlyingTradeUnits,
            address(wrappedSetToken),
            decodedParams.wrappedSetTokenTradeUnits,
            decodedParams.exchangeData
        );

        _decreaseLiquidityPosition(
            decodedParams.tokenId,
            liquidity,
            decodedParams.underlyingRedeemLiquidityMinAmount,
            decodedParams.wrappedSetTokenRedeemLiquidityMinAmount
        );

        _redeemExcessWrappedSetToken();
    }

    /**
     * @dev Internal function to execute trades. This function constructs the trade call data and invokes the trade module
     * to execute the trade. The SetToken units for send and receive quantities are automatically scaled up by the SetToken's
     * total supply.
     * @param _exchangeName The human-readable name of the exchange in the integrations registry.
     * @param _sendToken The address of the token being sent to the exchange.
     * @param _sendQuantity The amount of the token (in SetToken units) being sent to the exchange.
     * @param _receiveToken The address of the token being received from the exchange.
     * @param _minReceiveQuantity The minimum amount of the receive token (in SetToken units) expected from the exchange.
     * @param _data Arbitrary data used to construct the trade call data.
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
     * @dev Issues the required amount of wrapped SetToken for the liquidity increase
     * @param _wrappedSetTokenSupplyLiquidityAmount The amount of wrapped SetToken to be supplied to the pool.
     */
    function _issueRequiredWrappedSetToken(uint256 _wrappedSetTokenSupplyLiquidityAmount) internal {
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (_wrappedSetTokenSupplyLiquidityAmount > wrappedSetTokenBalance) {
            uint256 wrappedSetTokenIssueAmount = _wrappedSetTokenSupplyLiquidityAmount.sub(wrappedSetTokenBalance);
            (address[] memory underlyingAssets ,uint256[] memory underlyingUnits,) = issuanceModule.getRequiredComponentIssuanceUnits(
                wrappedSetToken,
                wrappedSetTokenIssueAmount
            );
            require(underlyingAssets.length == 1, "MigrationExtension: invalid wrapped SetToken composition");
            require(underlyingAssets[0] == address(aaveToken), "MigrationExtension: wrapped SetToken underlying mismatch");

            // Supply underlying for Aave wrapped token
            underlyingToken.approve(address(POOL), underlyingUnits[0]);
            POOL.supply(
                address(underlyingToken),
                underlyingUnits[0],
                address(this),
                0
            );

            // Issue wrapped SetToken
            aaveToken.approve(address(issuanceModule), wrappedSetTokenIssueAmount);
            issuanceModule.issue(wrappedSetToken, wrappedSetTokenIssueAmount, address(this));
        }
    }

    /**
     * @dev Redeems any excess wrapped SetToken after liquidity decrease
     */
    function _redeemExcessWrappedSetToken() internal {
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (wrappedSetTokenBalance > 0) {
            // Redeem wrapped SetToken
            wrappedSetToken.approve(address(issuanceModule), wrappedSetTokenBalance);
            issuanceModule.redeem(wrappedSetToken, wrappedSetTokenBalance, address(this));

            // Withdraw underlying from Aave
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
     * @dev Internal function to increase liquidity in a Uniswap V3 pool position.
     * Calls Uniswap's `increaseLiquidity` function with specified parameters.
     * @param _underlyingSupplyLiquidityAmount The amount of underlying token to be supplied to the pool.
     * @param _wrappedSetTokenSupplyLiquidityAmount The amount of wrapped SetToken to be supplied to the pool.
     * @param _tokenId The ID of the token for which liquidity is being increased.
     * @return liquidity The new liquidity amount as a result of the increase.
     */
    function _increaseLiquidityPosition(
        uint256 _underlyingSupplyLiquidityAmount,
        uint256 _wrappedSetTokenSupplyLiquidityAmount,
        uint256 _tokenId
    )
        internal
        returns (uint128 liquidity)
    {
        // Approve tokens
        if (_underlyingSupplyLiquidityAmount > 0) {
            underlyingToken.approve(address(nonfungiblePositionManager), _underlyingSupplyLiquidityAmount);
        }
        if (_wrappedSetTokenSupplyLiquidityAmount > 0) {
            wrappedSetToken.approve(address(nonfungiblePositionManager), _wrappedSetTokenSupplyLiquidityAmount);
        }

        // Increase liquidity
        INonfungiblePositionManager.IncreaseLiquidityParams memory increaseParams = INonfungiblePositionManager.IncreaseLiquidityParams({
            tokenId: _tokenId,
            amount0Desired: _wrappedSetTokenSupplyLiquidityAmount,
            amount1Desired: _underlyingSupplyLiquidityAmount,
            amount0Min: _wrappedSetTokenSupplyLiquidityAmount,
            amount1Min: _underlyingSupplyLiquidityAmount,
            deadline: block.timestamp
        });
        (liquidity,,) = nonfungiblePositionManager.increaseLiquidity(increaseParams);
    }

    /**
     * @dev Internal function to decrease liquidity and collect fees for a Uniswap V3 position.
     * Calls Uniswap's `decreaseLiquidity` and `collect` functions with specified parameters.
     * @param _tokenId The ID of the token for which liquidity is being decreased.
     * @param _liquidity The amount by which liquidity will be decreased.
     * @param _underlyingRedeemLiquidityMinAmount The minimum amount of the underlying token that should be accounted for the burned liquidity.
     * @param _wrappedSetTokenRedeemLiquidityMinAmount The minimum amount of the wrapped SetToken that should be accounted for the burned liquidity.
     */
    function _decreaseLiquidityPosition(
        uint256 _tokenId,
        uint128 _liquidity,
        uint256 _underlyingRedeemLiquidityMinAmount,
        uint256 _wrappedSetTokenRedeemLiquidityMinAmount
    ) internal {
        // Decrease liquidity
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
            tokenId: _tokenId,
            liquidity: _liquidity,
            amount0Min: _wrappedSetTokenRedeemLiquidityMinAmount,
            amount1Min: _underlyingRedeemLiquidityMinAmount,
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
     * @dev Internal function to return any remaining unwrapped collateral asset to the operator.
     * @return underlyingOutputAmount The amount of unwrapped collateral asset returned to the operator.
     */
    function _returnExcessUnderlying() internal returns (uint256 underlyingOutputAmount) {
        underlyingOutputAmount = underlyingToken.balanceOf(address(this));
        if (underlyingOutputAmount > 0) {
            underlyingToken.transfer(msg.sender, underlyingOutputAmount);
        }
    }
}
