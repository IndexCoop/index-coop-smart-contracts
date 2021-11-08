// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";


contract ZeroExExchangeProxyMock {


    // Method mocking the UniswapFeature of the zeroEx setup in tests
    // Returns the `minBuyAmount` of target token to the caller, which needs to be deposited into this contract beforehand
    // Original Implementation: https://github.com/0xProject/protocol/blob/development/contracts/zero-ex/contracts/src/features/UniswapFeature.sol#L99
    function sellToUniswap(
        IERC20[] calldata tokens,
        uint256 sellAmount,
        uint256 minBuyAmount,
        bool // isSushi
    )
        external
        payable
        returns (uint256 buyAmount)
    {
        require(tokens.length > 1, "UniswapFeature/InvalidTokensLength");
        IERC20 sellToken = tokens[0];
        IERC20 buyToken = tokens[tokens.length - 1];
        sellToken.transferFrom(msg.sender, address(this), sellAmount);
        buyToken.transferFrom(address(this), msg.sender, minBuyAmount);
        buyAmount = minBuyAmount;
    }
    



}
