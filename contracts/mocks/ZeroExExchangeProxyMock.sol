// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";



contract ZeroExExchangeProxyMock {

    // Originally I also wanted to test Custom error handling,
    // but refrained from doing so, since the necessary upgrade of ethers lead to a lot of typescript issues.
    // TODO: Add Custom error handling test when ethers.js is upgraded to a compatible version
    enum ErrorType {
        None,
        RevertMessage,
        CustomError
    }

    // Mappings to control amount of buy / sell token transfered
    mapping(address => uint256) public buyAmountMultipliers;
    mapping(address => uint256) public sellAmountMultipliers;
    mapping(address => ErrorType) public errorMapping;


    string public constant testRevertMessage = "test revert message";

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


        _throwErrorIfNeeded(sellToken);

        uint256 multipliedSellAmount = getSellAmount(sellToken, sellAmount);
        sellToken.transferFrom(msg.sender, address(this), multipliedSellAmount);

        buyAmount = getBuyAmount(buyToken, minBuyAmount);
        buyToken.transfer(msg.sender, buyAmount);
    }

    function _throwErrorIfNeeded(IERC20 sellToken) internal
    {
        if (errorMapping[address(sellToken)] == ErrorType.RevertMessage) {
            revert(testRevertMessage);
        } 
    }

    function getBuyAmount(
        IERC20 buyToken,
        uint256 minBuyAmount
    ) public view returns (uint256 buyAmount) {
        uint256 buyMultiplier = buyAmountMultipliers[address(buyToken)];
        if (buyMultiplier == 0) {
            buyAmount = minBuyAmount;
        }
        else{
            buyAmount = (minBuyAmount * buyMultiplier) / 10**18;
        }
    }

    // Function to adjust the amount of buy token that will be returned 
    // Set to 0 to disable / i.e. always return exact minBuyAmount
    function setBuyMultiplier(
        IERC20 buyToken,
        uint256 multiplier
    ) public {
        buyAmountMultipliers[address(buyToken)] = multiplier;
    }

    function getSellAmount(
        IERC20 sellToken,
        uint256 inputSellAmount
    ) public view returns (uint256 sellAmount) {
        uint256 sellMultiplier = sellAmountMultipliers[address(sellToken)];
        if (sellMultiplier == 0) {
            sellAmount = inputSellAmount;
        }
        else{
            sellAmount = (inputSellAmount * sellMultiplier) / 10**18;
        }
    }

    // Function to adjust the amount of sell token that will be returned 
    // Set to 0 to disable / i.e. always return exact minSellAmount
    function setSellMultiplier(
        IERC20 sellToken,
        uint256 multiplier
    ) public {
        sellAmountMultipliers[address(sellToken)] = multiplier;
    }

    function setErrorMapping(
        address sellToken,
        ErrorType errorType
    ) public {
        errorMapping[sellToken] = errorType;
    }
}
