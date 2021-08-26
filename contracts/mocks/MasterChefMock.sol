// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

contract MasterChefMock {

    uint256 private amount;

    constructor() public {
        amount = 0;
    }

    function userInfo(uint256 _id, address /* _user */) external view returns (uint256, uint256) {
        if (_id == 75) return (amount, 0);
        return (0, 0);
    }

    function setAmount(uint256 _amount) external {
        amount = _amount;
    }
}