/*
    Copyright 2023 Index Cooperative
    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.19;

import { IERC20 } from "openzeppelin-contracts-4.9/token/ERC20/IERC20.sol";




/**
 * @title ZeroExTradeWrapper
 * @author Index Coop
 *
 * Contract for wrapping ZeroEx trades
 * Developed to fulfil calldata decoding requirments in the ledger integration and enforce minOutput and maxInput amounts
 */
contract ZeroExTradeWrapper {
    address public constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public immutable CALL_TARGET;

    constructor (address _callTarget) {
        CALL_TARGET = _callTarget;
    }

    /**
     * @notice Executes a trade on behalf of the user with a delegatecall
     * @param _callData The calldata for the 0x contract
     * @param _tokenIn The token to send / Set to zeroAddress to bypass inputToken handling
     * @param _maxAmountIn The maximum amount of tokens to send
     * @param _tokenOut The token to receive / Set to zeroAddress to bypass outputToken handling
     * @param _minAmountOut The minimum amount of tokens to receive
     */
    function executeTrade(
        bytes memory _callData,
        IERC20 _tokenIn,
        uint256 _maxAmountIn,
        IERC20 _tokenOut,
        uint256 _minAmountOut
    ) external payable returns (bytes memory){

        bool tokenInIsERC20;
        if(address(_tokenIn) != address(0)) {
            tokenInIsERC20 = address(_tokenIn) != ETH_ADDRESS;
            if(tokenInIsERC20) {
                _tokenIn.transferFrom(msg.sender, address(this), _maxAmountIn);
                if(_tokenIn.allowance(address(this), CALL_TARGET) < _maxAmountIn) {
                    _tokenIn.approve(CALL_TARGET, type(uint256).max);
                }
            }
        }

        (bool success, bytes memory returnData) = CALL_TARGET.call{value: msg.value}(_callData);
        require(success, string(returnData));


        // Instead of checking the spent amounts we just transfer out the full token balances
        if(tokenInIsERC20) {
            _tokenIn.transfer(msg.sender, _tokenIn.balanceOf(address(this)));
        }

        if(address(_tokenOut) != address(0)) {
            if(address(_tokenOut) != ETH_ADDRESS) {
                uint256 tokenOutBalance = _tokenOut.balanceOf(address(this));
                require(tokenOutBalance >= _minAmountOut, "ZeroExTradeWrapper: Insufficient tokens received");
                _tokenOut.transfer(msg.sender, tokenOutBalance);
            } else {
                require(address(this).balance >= _minAmountOut, "ZeroExTradeWrapper: Insufficient ETH received");
            }
        }

        if (address(this).balance > 0) {
            payable(msg.sender).transfer(address(this).balance);
        }
    }


}
