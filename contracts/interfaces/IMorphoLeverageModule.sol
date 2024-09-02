// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { ISetToken } from "./ISetToken.sol";
import { IMorpho } from "./IMorpho.sol";

interface IMorphoLeverageModule {
    function sync(
        ISetToken _setToken
    ) external;

    function lever(
        ISetToken _setToken,
        uint256 _borrowQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    ) external;

    function delever(
        ISetToken _setToken,
        uint256 _redeemQuantityUnits,
        uint256 _minRepayQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    ) external;

    function marketParams(ISetToken _setToken) external view returns (IMorpho.MarketParams memory);

    function getCollateralAndBorrowBalances(
        ISetToken _setToken
    )
        external
        view 
        returns(uint256 collateralBalance, uint256 borrowBalance, uint256 borrowSharesU256);

}
