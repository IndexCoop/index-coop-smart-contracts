/*
    Copyright 2021 IndexCooperative

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Index Exchange Adapter that doubles as a mock exchange
 */
contract IndexExchangeAdapterMock {

    /* ============ Helper Functions ============ */

    function withdraw(address _token)
        external
    {
        uint256 balance = IERC20(_token).balanceOf(address(this));
        require(IERC20(_token).transfer(msg.sender, balance), "ERC20 transfer failed");
    }

    /* ============ Trade Functions ============ */

    function tradeExactInput(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 _sourceQuantity,
        uint256 /* _minDestinationQuantity */
    )
        external
    {
        uint256 destinationBalance = IERC20(_destinationToken).balanceOf(address(this));
        require(IERC20(_sourceToken).transferFrom(_destinationAddress, address(this), _sourceQuantity), "ERC20 TransferFrom failed");
        require(IERC20(_destinationToken).transfer(_destinationAddress, destinationBalance), "ERC20 transfer failed");
    }

    function tradeExactOutput(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 /* _maxSourceQuantity */,
        uint256 _destinationQuantity
    )
        external
    {
        uint256 sourceBalance = IERC20(_sourceToken).balanceOf(msg.sender);
        require(IERC20(_sourceToken).transferFrom(_destinationAddress, address(this), sourceBalance), "ERC20 TransferFrom failed");
        require(IERC20(_destinationToken).transfer(_destinationAddress, _destinationQuantity), "ERC20 transfer failed");
    }

    /* ============ Adapter Functions ============ */

    function getSpender()
        external
        view
        returns (address)
    {
        return address(this);
    }

    function getTradeCalldata(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        bool _isSendTokenFixed,
        uint256 _sourceQuantity,
        uint256 _destinationQuantity,
        bytes memory /* _data */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        bytes memory methodData = _isSendTokenFixed ?
            abi.encodeWithSignature(
                "tradeExactInput(address,address,address,uint256,uint256)",
                _sourceToken,
                _destinationToken,
                _destinationAddress,
                _sourceQuantity,
                _destinationQuantity
            ) :
            abi.encodeWithSignature(
                "tradeExactOutput(address,address,address,uint256,uint256)",
                _sourceToken,
                _destinationToken,
                _destinationAddress,
                _sourceQuantity,
                _destinationQuantity
            );
        
        return (address(this), 0, methodData);
    }
}