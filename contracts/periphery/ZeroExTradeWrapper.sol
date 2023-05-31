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

import { Ownable } from "openzeppelin-contracts-4.9/access/Ownable.sol";
import { IERC20 } from "openzeppelin-contracts-4.9/token/ERC20/IERC20.sol";




/**
 * @title ZeroExTradeWrapper
 * @author Index Coop
 *
 * Contract for wrapping ZeroEx trades
 * Developed to fulfil calldata decoding requirments in the ledger integration
 */
contract ZeroExTradeWrapper is Ownable {
    mapping (address => bool) public approvedCallTargets;

    constructor(address[] memory _approvedCallTargets) {
        for (uint256 i = 0; i < _approvedCallTargets.length; i++) {
            approvedCallTargets[_approvedCallTargets[i]] = true;
        }
    }

    /**
     * @notice OWNER ONLY: Changes approval status of callTarget
     * @param _callTarget The address of the 0x contract
     */
    function changeCallTargetApprovalStatus(address _callTarget, bool _newStatus) external onlyOwner {
        approvedCallTargets[_callTarget] = _newStatus;
    }


    /**
     * @notice Executes a trade on behalf of the user with a delegatecall
     * @param _callTarget The address of the 0x contract
     * @param _callData The calldata for the 0x contract
     * @param _tokenIn The token to send
     * @param _maxAmountIn The maximum amount of tokens to send
     * @param _tokenOut The token to receive
     * @param _minAmountOut The minimum amount of tokens to receive
     */
    function executeTrade(
        address _callTarget,
        bytes memory _callData,
        IERC20 _tokenIn,
        uint256 _maxAmountIn,
        IERC20 _tokenOut,
        uint256 _minAmountOut
    ) external payable returns (bytes memory){
        require(approvedCallTargets[_callTarget], "ZeroExTradeWrapper: Call target not approved");

        uint256 outputBalanceBefore = _tokenOut.balanceOf(msg.sender);
        uint256 inputBalanceBefore = _tokenOut.balanceOf(msg.sender);

        (bool success, bytes memory returnData) = _callTarget.delegatecall(_callData);
        require(success, string(returnData));

        require(_tokenOut.balanceOf(msg.sender) - outputBalanceBefore >= _minAmountOut, "ZeroExTradeWrapper: Underreceived");
        require(inputBalanceBefore - _tokenIn.balanceOf(msg.sender) <= _maxAmountIn, "ZeroExTradeWrapper: Overpaid");
        return returnData;
    }


}
