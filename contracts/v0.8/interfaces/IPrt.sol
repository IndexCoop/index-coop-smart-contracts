// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import { IERC20 } from "openzeppelin-contracts-v0.8/token/ERC20/IERC20.sol";

interface IPrt is IERC20 {
    function setToken() external view returns (address);
}
