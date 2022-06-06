// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.6.10;
import { ISetToken } from "../interfaces/ISetToken.sol";

interface INotionalTradeModule {
    function redeemMaturedPositions(ISetToken) external;
}

