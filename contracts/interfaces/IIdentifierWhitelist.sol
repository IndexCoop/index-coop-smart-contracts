// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.4;

interface IIdentifierWhitelist {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SupportedIdentifierAdded(bytes32 indexed identifier);
    event SupportedIdentifierRemoved(bytes32 indexed identifier);

    function addSupportedIdentifier(bytes32 identifier) external;
    function isIdentifierSupported(bytes32 identifier) external view returns (bool);
    function owner() external view returns (address);
    function removeSupportedIdentifier(bytes32 identifier) external;
    function renounceOwnership() external;
    function transferOwnership(address newOwner) external;
}
