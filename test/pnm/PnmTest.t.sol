// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;

import "@pwnednomore/contracts/PTest.sol";

contract StructTest is PTest {
    uint256 testNumber;

    function setUp() public {
        testNumber = 42;
    }

    function invariantFlagIsTrue() public view {
        assert(testNumber == 42);
    }
}