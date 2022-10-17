pragma solidity ^0.8.0;

import { FlashMintWrapped } from '../contracts/exchangeIssuance/FlashMintWrapped.sol';
import { PTest } from "@pwnednomore/contracts/PTest.sol";

contract FlashMintWrappedTest is PTest {

    FlashMintWrapped flashMintWrapped;

    function setUp() external {
		flashMintWrapped = new flashMintWrapped(); 
	}

	function invariantFundLoss() external view {
	}
}
