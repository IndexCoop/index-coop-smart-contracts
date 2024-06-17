// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity ^0.8.0;

import { IERC20 } from "openzeppelin-contracts-v0.8/contracts/token/ERC20/IERC20.sol";

interface IPrt is IERC20 {
    function setToken() external view returns (address);
}
