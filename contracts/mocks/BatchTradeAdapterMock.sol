// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Trade Adapter that doubles as a mock exchange
 */
contract BatchTradeAdapterMock {

    /* ============ Helper Functions ============ */

    function withdraw(address _token)
        external
    {
        uint256 balance = ERC20(_token).balanceOf(address(this));
        require(ERC20(_token).transfer(msg.sender, balance), "ERC20 transfer failed");
    }

    /* ============ Trade Functions ============ */

    function trade(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity
    )
        external
    {
        uint256 destinationBalance = ERC20(_destinationToken).balanceOf(address(this));
        require(ERC20(_sourceToken).transferFrom(_destinationAddress, address(this), _sourceQuantity), "ERC20 TransferFrom failed");
        if (_minDestinationQuantity == 1) { // byte revert case, min nonzero uint256 minimum receive quantity
            bytes memory data = abi.encodeWithSelector(
                bytes4(keccak256("trade(address,address,address,uint256,uint256)")),
                _sourceToken,
                _destinationToken,
                _destinationAddress,
                _sourceQuantity,
                _minDestinationQuantity
            );
            assembly { revert(add(data, 32), mload(data)) }
        }
        if (destinationBalance >= _minDestinationQuantity) { // normal case
            require(ERC20(_destinationToken).transfer(_destinationAddress, destinationBalance), "ERC20 transfer failed");
        }
        else { // string revert case, minimum destination quantity not in exchange
            revert("Insufficient funds in exchange");
        }
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
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity,
        bytes memory /* _data */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        // Encode method data for SetToken to invoke
        bytes memory methodData = abi.encodeWithSignature(
            "trade(address,address,address,uint256,uint256)",
            _sourceToken,
            _destinationToken,
            _destinationAddress,
            _sourceQuantity,
            _minDestinationQuantity
        );

        return (address(this), 0, methodData);
    }
}
