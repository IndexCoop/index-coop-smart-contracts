// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

import { MutualUpgrade } from "../lib/MutualUpgrade.sol";


// Mock contract implementation of MutualUpgrade functions
contract MutualUpgradeMock is
    MutualUpgrade
{
    uint256 public testUint;
    address public owner;
    address public methodologist;

    constructor(address _owner, address _methodologist) public {
        owner = _owner;
        methodologist = _methodologist;
    }

    function testMutualUpgrade(
        uint256 _testUint
    )
        external
        mutualUpgrade(owner, methodologist)
    {
        testUint = _testUint;
    }
}