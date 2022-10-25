pragma solidity 0.6.10;

import { PTest } from "pnm-contracts/PTest.sol";

contract FlashMintWrappedTest is PTest {
	uint256 testNumber;

    function setUp() external {
		testNumber = 42;
	}

	function invariantFundLoss() external view {
		require(testNumber == 42, "TestNumber should always be 42");
	}
}
