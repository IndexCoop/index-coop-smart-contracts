/*
    Copyright 2021 Index Coop.

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

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WrapAdapterMock is ERC20 {
    constructor(address _owner, uint256 _initAmount) public ERC20("Wrapped Token", "WTOKEN") {
        _mint(_owner, _initAmount);
    }

    /* ========= Wrapped Token Functions ========== */

    function mint(IERC20 _underlying, uint256 _amount) external {
        _underlying.transferFrom(msg.sender, address(this), _amount);
        _mint(msg.sender, _amount);
    }

    function mintWithEther(uint256 _amount) external payable {
        require(msg.value == _amount, "msg.value to low");
        _mint(msg.sender, _amount);
    }

    function burn(IERC20 _underlying, uint256 _amount) external {
        _burn(msg.sender, _amount);
        _underlying.transfer(msg.sender, _amount);
    }

    function burnWithEther(uint256 _amount) external {
        _burn(msg.sender, _amount);
        msg.sender.transfer(_amount);
    }

    receive() external payable {}

    /* ========= Wrap Adapter Functions =========== */

    address public constant ETH_TOKEN_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    function getWrapCallData(
        address _underlyingToken,
        address /* _wrappedToken */,
        uint256 _underlyingUnits
    )
        external
        view
        returns (address _subject, uint256 _value, bytes memory _calldata)
    {
        if (_underlyingToken == ETH_TOKEN_ADDRESS) {
            bytes memory data = abi.encodeWithSelector(this.mintWithEther.selector, _underlyingUnits);
            return (address(this), _underlyingUnits, data);
        } else {
            bytes memory data = abi.encodeWithSelector(this.mint.selector, _underlyingToken, _underlyingUnits);
            return (address(this), 0, data);
        }
    }

    function getUnwrapCallData(
        address _underlyingToken,
        address /* _wrappedToken */,
        uint256 _wrappedTokenUnits
    )
        external
        view
        returns
        (address _subject, uint256 _value, bytes memory _calldata)
    {
        if (_underlyingToken == ETH_TOKEN_ADDRESS) {
            bytes memory data = abi.encodeWithSelector(this.burnWithEther.selector, _wrappedTokenUnits);
            return (address(this), 0, data);
        } else {
            bytes memory data = abi.encodeWithSelector(this.burn.selector, _underlyingToken, _wrappedTokenUnits);
            return (address(this), 0, data);
        }
    }

    function getSpenderAddress(
        address /* underlyingToken */,
        address /* _wrappedToken */
    )
        external
        view
        returns(address) 
    {
        return address(this);
    }
}