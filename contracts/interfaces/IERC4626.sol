// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;

interface IERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets_, address receiver_) external returns (uint256 shares_);
    function mint(uint256 shares_, address receiver_) external returns (uint256 assets_);
    function redeem(uint256 shares_, address receiver_, address owner_) external returns (uint256 assetsAfterFee_);
    function withdraw(uint256 assets_, address receiver_, address owner_) external returns (uint256 shares_);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewMint(uint256 shares) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function previewWithdraw(uint256 assets) external view returns (uint256);
}
