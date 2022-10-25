pragma solidity 0.6.10;

import "forge-std/test.sol";

contract FlashMintWrappedTest is Test {
    uint256 testNumber;

    function setUp() public {
        testNumber = 42;
    }

    function testNumberIs42() public {
        assertEq(testNumber, 42);
    }
}
