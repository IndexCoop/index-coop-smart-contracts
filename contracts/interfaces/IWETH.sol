// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity >=0.6.10;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint) external;
}
