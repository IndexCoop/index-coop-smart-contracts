// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;

interface IRsEthAdapter {
    function depositRsETH(uint256 rsETHAmount, string memory referralId) external;
    function getRSETHWithERC20(address asset, uint256 depositAmount, string memory referralId) external;
    function getRSETHWithETH(string memory referralId) external payable;
    function lrtDepositPool() external view returns (address);
    function rsETH() external view returns (address);
    function vault() external view returns (address);
}
