// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

interface IPendlePrincipalToken {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function SY() external view returns (address);
    function YT() external view returns (address);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function burnByYT(address user, uint256 amount) external;
    function decimals() external view returns (uint8);
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
    function expiry() external view returns (uint256);
    function factory() external view returns (address);
    function initialize(address _YT) external;
    function isExpired() external view returns (bool);
    function mintByYT(address user, uint256 amount) external;
    function name() external view returns (string memory);
    function nonces(address owner) external view returns (uint256);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
