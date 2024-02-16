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

import "hardhat/console.sol";

/**
 * @title MigrationExtension
 * @author Index Coop
 * @notice Manager extension for migrating a SetToken position from a collateral asset
 * to a SetToken composed only of that collateral asset.
 * Facilitates the migration by
 * 1) Taking a flash loan of the collateral asset
 * 2) Issuing any required units of the wrapped SetToken
 * 3) Adding liquidity to the Uniswap V3 pool
 * 4) Trading the collateral asset for the wrapped SetToken
 * 5) Removing liquidity from the Uniswap V3 pool
 * 6) Redeeming any excess wrapped SetToken
 * 7) Repaying the flash loan
 */
contract MigrationExtension is BaseExtension, FlashLoanSimpleReceiverBase, IERC721Receiver {
    using SafeCast for int256;
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

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
    ISetToken public immutable wrappedSetToken;
    ITradeModule public immutable tradeModule;
    IDebtIssuanceModule public immutable issuanceModule;
    INonfungiblePositionManager public immutable nonfungiblePositionManager;

    uint256[] public tokenIds;
    mapping(uint256 => uint128) public tokenIdToLiquidity;

    /* ============ Modifiers ============ */
 
    modifier onlyPool() {
        require(msg.sender == address(POOL), "MigrationExtension: Aave Pool only");
        _;
    }

    /* ============ Constructor ============ */

    /**
     * Sets immutable migration variables
     *
     * @param _manager                       BaseManager contract
     * @param _underlyingToken               Address of underlying token
     * @param _wrappedSetToken               Set Token which is a wrapper of underlying token
     * @param _tradeModule                   TradeModule for the SetToken
     * @param _issuanceModule                IssuanceModule for the Wrapped SetToken
     * @param _nonfungiblePositionManager    Uniswap V3 NonFungiblePositionManager
     * @param _addressProvider               Aave V3 Pool Address Provider
     */
    constructor(
        IBaseManager _manager, 
        IERC20 _underlyingToken,
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
        wrappedSetToken = _wrappedSetToken;
        tradeModule = _tradeModule;
        issuanceModule = _issuanceModule;
        nonfungiblePositionManager = _nonfungiblePositionManager;
    }

    /* ========== External Functions ========== */

    /**
     * OPERATOR ONLY: Initializes the Set Token on the Trade Module.
     */
    function initialize() external onlyOperator {
        bytes memory data = abi.encodeWithSelector(tradeModule.initialize.selector, setToken);
        invokeManager(address(tradeModule), data);
    }

    /**
     * ONLY OPERATOR: Executes a trade on a supported DEX.
     * @dev Although the SetToken units are passed in for the send and receive quantities, the total quantity
     * sent and received is the quantity of SetToken units multiplied by the SetToken totalSupply.
     *
     * @param _exchangeName         Human readable name of the exchange in the integrations registry
     * @param _sendToken            Address of the token to be sent to the exchange
     * @param _sendQuantity         Units of token in SetToken sent to the exchange
     * @param _receiveToken         Address of the token that will be received from the exchange
     * @param _minReceiveQuantity   Min units of token in SetToken to be received from the exchange
     * @param _data                 Arbitrary bytes to be used to construct trade call data
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
     * OPERATOR ONLY: Mints a new liquidity position in the Uniswap V3 pool.
     * @dev Used to seed the position used in the migration.
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
        if (_underlyingSupplyLiquidityAmount > 0) {
            underlyingToken.approve(address(nonfungiblePositionManager), _underlyingSupplyLiquidityAmount);
        }
        if (_wrappedSetTokenSupplyLiquidityAmount > 0) {
            wrappedSetToken.approve(address(nonfungiblePositionManager), _wrappedSetTokenSupplyLiquidityAmount);
        }
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
        (uint256 tokenId, uint128 liquidity,,) = nonfungiblePositionManager.mint(mintParams);
        require(liquidity > 0, "MigrationExtension: No liquidity minted");
        tokenIds.push(tokenId);
        tokenIdToLiquidity[tokenId] = liquidity;
    }

    /**
     * OPERATOR ONLY: Increases liquidity position in the Uniswap V3 pool.
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
        tokenIdToLiquidity[_tokenId] += liquidity;
    }

    /**
     * OPERATOR ONLY: Decreases liquidity position in the Uniswap V3 pool.
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
        tokenIdToLiquidity[_tokenId] -= _liquidity;
    }

    /**
     * OPERATOR ONLY: Migrates a SetToken position from a collateral asset to a SetToken composed only of that collateral asset.
     */
    function migrate(
        uint256 _underlyingLoanAmount,
        uint256 _underlyingSupplyLiquidityAmount,
        uint256 _wrappedSetTokenSupplyLiquidityAmount,
        uint256 _tokenId,
        string memory _exchangeName,
        uint256 _underlyingTradeUnits,
        uint256 _wrappedSetTokenTradeUnits,
        bytes memory _exchangeData,
        uint256 _underlyingRedeemLiquidityMinAmount,
        uint256 _wrappedSetTokenRedeemLiquidityMinAmount
    )
        external
        onlyOperator
    {
        // Encode migration parameters
        bytes memory params = abi.encode(
            DecodedParams(
                _underlyingSupplyLiquidityAmount,
                _wrappedSetTokenSupplyLiquidityAmount,
                _tokenId,
                _exchangeName,
                _underlyingTradeUnits,
                _wrappedSetTokenTradeUnits,
                _exchangeData,
                _underlyingRedeemLiquidityMinAmount,
                _wrappedSetTokenRedeemLiquidityMinAmount
           )
        );

        // Flash loan the underlying
        POOL.flashLoanSimple(
            address(this),
            address(underlyingToken),
            _underlyingLoanAmount,
            params,
            0
        );
    }

    /**
     * This is the callback function that will be called by the Aave V3 Pool after flashloaned tokens have been sent
     * to this contract.
     * After exiting this function the Pool will transfer back the loaned tokens plus a premium. If that check fails
     * the whole transaction gets reverted
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
        onlyPool
        returns (bool) 
    {
        require(initiator == address(this), "MigrationExtension: invalid flashloan initiator");

        // Decode parameters and migrate
        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));
        _migrate(decodedParams);

        // Approve flashloan repayment
        uint256 totalAmount = amount + premium;
        underlyingToken.approve(address(POOL), totalAmount);
        return true;
    }

    /**
     * Callback function used to receive ERC721 tokens
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

    receive() external payable {}

    /* ========== Internal Functions ========== */

    /**
     * Execute the token migraiton after the flash loan amount has been received
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

        console.log("Underlying token balance before", underlyingToken.balanceOf(address(this)));
        console.log("Wrapped token balance before", wrappedSetToken.balanceOf(address(this)));
        _decreaseLiquidityPosition(
            decodedParams.tokenId,
            liquidity,
            decodedParams.underlyingRedeemLiquidityMinAmount,
            decodedParams.wrappedSetTokenRedeemLiquidityMinAmount
        );
        console.log("Underlying token balance after", underlyingToken.balanceOf(address(this)));
        console.log("Wrapped token balance after", wrappedSetToken.balanceOf(address(this)));

        _redeemExcessWrappedSetToken();
    }

    /// @dev Although the SetToken units are passed in for the send and receive quantities, the total quantity
    /// sent and received is the quantity of SetToken units multiplied by the SetToken totalSupply.
    /// @param _exchangeName         Human readable name of the exchange in the integrations registry
    /// @param _sendToken            Address of the token to be sent to the exchange
    /// @param _sendQuantity         Units of token in SetToken sent to the exchange
    /// @param _receiveToken         Address of the token that will be received from the exchange
    /// @param _minReceiveQuantity   Min units of token in SetToken to be received from the exchange
    /// @param _data                 Arbitrary bytes to be used to construct trade call data
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

    /// @dev Issues the required amount of wrapped SetToken for the liquidity increase
    /// @param _wrappedSetTokenSupplyLiquidityAmount The amount of wrapped SetToken to be supplied to the pool
    function _issueRequiredWrappedSetToken(uint256 _wrappedSetTokenSupplyLiquidityAmount) internal {
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (_wrappedSetTokenSupplyLiquidityAmount > wrappedSetTokenBalance) {
            uint256 wrappedSetTokenIssueAmount = _wrappedSetTokenSupplyLiquidityAmount.sub(wrappedSetTokenBalance);
            (address[] memory underlyingAssets ,uint256[] memory underlyingUnits,) = issuanceModule.getRequiredComponentIssuanceUnits(
                wrappedSetToken,
                wrappedSetTokenIssueAmount
            );
            require(underlyingAssets.length == 1);
            require(underlyingAssets[0] == address(underlyingToken));

            underlyingToken.approve(address(issuanceModule), underlyingUnits[0]);
            issuanceModule.issue(wrappedSetToken, wrappedSetTokenIssueAmount, address(this));
        }
    }

    /// @dev Redeems any excess wrapped SetToken after liquidity decrease
    function _redeemExcessWrappedSetToken() internal {
        uint256 wrappedSetTokenBalance = wrappedSetToken.balanceOf(address(this));
        if (wrappedSetTokenBalance > 0) {
            wrappedSetToken.approve(address(issuanceModule), wrappedSetTokenBalance);
            issuanceModule.redeem(wrappedSetToken, wrappedSetTokenBalance, address(this));
        }
    }

    /// @param _underlyingSupplyLiquidityAmount The amount of underlying to be supplied to the pool
    /// @param _wrappedSetTokenSupplyLiquidityAmount The amount of wrapped SetToken to be supplied to the pool
    /// @param _tokenId The ID of the token for which liquidity is being increased
    function _increaseLiquidityPosition(
        uint256 _underlyingSupplyLiquidityAmount,
        uint256 _wrappedSetTokenSupplyLiquidityAmount,
        uint256 _tokenId
    )
        internal
        returns (uint128 liquidity)
    {
        if (_underlyingSupplyLiquidityAmount > 0) {
            underlyingToken.approve(address(nonfungiblePositionManager), _underlyingSupplyLiquidityAmount);
        }
        if (_wrappedSetTokenSupplyLiquidityAmount > 0) {
            wrappedSetToken.approve(address(nonfungiblePositionManager), _wrappedSetTokenSupplyLiquidityAmount);
        }

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

    /// @param _tokenId The ID of the token for which liquidity is being decreased
    /// @param _liquidity The amount by which liquidity will be decreased
    /// @param _underlyingRedeemLiquidityMinAmount The minimum amount of token0 that should be accounted for the burned liquidity
    /// @param _wrappedSetTokenRedeemLiquidityMinAmount The minimum amount of token1 that should be accounted for the burned liquidity
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

        // Collect fees / and liquidity
        INonfungiblePositionManager.CollectParams memory params =
            INonfungiblePositionManager.CollectParams({
                tokenId: _tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        nonfungiblePositionManager.collect(params);

    }
}
