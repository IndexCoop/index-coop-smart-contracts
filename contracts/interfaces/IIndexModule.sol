// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { ISetToken } from "./ISetToken.sol";

interface IIndexModule {
    function startRebalance(
        address[] calldata _newComponents,
        uint256[] calldata _newComponentsTargetUnits,
        uint256[] calldata _oldComponentsTargetUnits,
        uint256 _positionMultiplier
    ) external;

    function setTradeMaximums(
        address[] calldata _components,
        uint256[] calldata _tradeMaximums
    ) external;

    function setExchanges(
        address[] calldata _components,
        uint256[] calldata _exchanges
    ) external;

    function setCoolOffPeriods(
        address[] calldata _components,
        uint256[] calldata _coolOffPeriods
    ) external;

    function updateTraderStatus(address[] calldata _traders, bool[] calldata _statuses) external;

    function updateAnyoneTrade(bool _status) external;
}