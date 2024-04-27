// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

interface IPendleStandardizedYield {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function accruedRewards(address) external view returns (uint256[] memory rewardAmounts);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function assetInfo() external view returns (uint8, address, uint8);
    function balanceOf(address account) external view returns (uint256);
    function claimOwnership() external;
    function claimRewards(address) external returns (uint256[] memory rewardAmounts);
    function decimals() external view returns (uint8);
    function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut)
        external
        payable
        returns (uint256 amountSharesOut);
    function eETH() external view returns (address);
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
    function exchangeRate() external view returns (uint256);
    function getRewardTokens() external view returns (address[] memory rewardTokens);
    function getTokensIn() external view returns (address[] memory res);
    function getTokensOut() external view returns (address[] memory res);
    function isValidTokenIn(address token) external view returns (bool);
    function isValidTokenOut(address token) external view returns (bool);
    function liquidityPool() external view returns (address);
    function name() external view returns (string memory);
    function nonces(address owner) external view returns (uint256);
    function owner() external view returns (address);
    function pause() external;
    function paused() external view returns (bool);
    function pendingOwner() external view returns (address);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function previewDeposit(address tokenIn, uint256 amountTokenToDeposit)
        external
        view
        returns (uint256 amountSharesOut);
    function previewRedeem(address tokenOut, uint256 amountSharesToRedeem)
        external
        view
        returns (uint256 amountTokenOut);
    function redeem(
        address receiver,
        uint256 amountSharesToRedeem,
        address tokenOut,
        uint256 minTokenOut,
        bool burnFromInternalBalance
    ) external returns (uint256 amountTokenOut);
    function referee() external view returns (address);
    function rewardIndexesCurrent() external returns (uint256[] memory indexes);
    function rewardIndexesStored() external view returns (uint256[] memory indexes);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transferOwnership(address newOwner, bool direct, bool renounce) external;
    function unpause() external;
    function weETH() external view returns (address);
    function yieldToken() external view returns (address);
}
