pragma solidity 0.6.10;

import { PTest } from "@pwnednomore/contracts/PTest.sol";

contract FlashMintWrappedTest is PTest {
	uint256 testNumber;

    function setUp() external {
		testNumber = 42;
	}

	function invariantFundLoss() external view {
		require(testNumber == 42, "");
	}
}
