// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

import { MutualUpgradeV2 } from "../lib/MutualUpgradeV2.sol";


// Mock contract implementation of MutualUpgradeV2 functions
contract MutualUpgradeV2Mock is
    MutualUpgradeV2
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
