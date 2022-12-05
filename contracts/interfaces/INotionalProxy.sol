// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity ^0.6.10;
pragma experimental ABIEncoderV2;

/// @notice Different types of internal tokens
///  - UnderlyingToken: underlying asset for a cToken (except for Ether)
///  - cToken: Compound interest bearing token
///  - cETH: Special handling for cETH tokens
///  - Ether: the one and only
///  - NonMintable: tokens that do not have an underlying (therefore not cTokens)
enum TokenType {
    UnderlyingToken,
    cToken,
    cETH,
    Ether,
    NonMintable
}

/// @notice Internal object that represents a token
struct Token {
    address tokenAddress;
    bool hasTransferFee;
    int256 decimals;
    TokenType tokenType;
    uint256 maxCollateralBalance;
}

/// @dev Market object as represented in memory
struct MarketParameters {
    bytes32 storageSlot;
    uint256 maturity;
    // Total amount of fCash available for purchase in the market.
    int256 totalfCash;
    // Total amount of cash available for purchase in the market.
    int256 totalAssetCash;
    // Total amount of liquidity tokens (representing a claim on liquidity) in the market.
    int256 totalLiquidity;
    // This is the implied rate that we use to smooth the anchor rate between trades.
    uint256 lastImpliedRate;
    // This is the oracle rate used to value fCash and prevent flash loan attacks
    uint256 oracleRate;
    // This is the timestamp of the previous trade
    uint256 previousTradeTime;
}

interface INotionalProxy {
    function getMaxCurrencyId() external view returns (uint16);

    function getCurrencyId(address tokenAddress) external view returns (uint16 currencyId);

    function getCurrency(uint16 currencyId)
        external
        view
        returns (Token memory assetToken, Token memory underlyingToken);


    function getActiveMarkets(uint16 currencyId) external view returns (MarketParameters[] memory);

    function getfCashNotional(
        address account,
        uint16 currencyId,
        uint256 maturity
    ) external view returns (int256);

    function settleAccount(address account) external;

   function getfCashLendFromDeposit(
        uint16 currencyId,
        uint256 depositAmountExternal,
        uint256 maturity,
        uint32 minLendRate,
        uint256 blockTime,
        bool useUnderlying
    ) external view returns (
        uint88 fCashAmount,
        uint8 marketIndex,
        bytes32 encodedTrade
    );

    function getDepositFromfCashLend(
        uint16 currencyId,
        uint256 fCashAmount,
        uint256 maturity,
        uint32 minLendRate,
        uint256 blockTime
    ) external view returns (
        uint256 depositAmountUnderlying,
        uint256 depositAmountAsset,
        uint8 marketIndex,
        bytes32 encodedTrade
    );

    function getPrincipalFromfCashBorrow(
        uint16 currencyId,
        uint256 fCashBorrow,
        uint256 maturity,
        uint32 maxBorrowRate,
        uint256 blockTime
    ) external view returns (
        uint256 borrowAmountUnderlying,
        uint256 borrowAmountAsset,
        uint8 marketIndex,
        bytes32 encodedTrade
    );    

    function getfCashBorrowFromPrincipal(
        uint16 currencyId,
        uint256 borrowedAmountExternal,
        uint256 maturity,
        uint32 maxBorrowRate,
        uint256 blockTime,
        bool useUnderlying
    ) external view returns (
        uint88 fCashDebt,
        uint8 marketIndex,
        bytes32 encodedTrade
    );

    function initializeMarkets(
        uint16 currencyId,
        bool flag
    ) external;


}
