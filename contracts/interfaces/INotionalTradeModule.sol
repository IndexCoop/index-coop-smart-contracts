// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.6.10;
import { ISetToken } from "../interfaces/ISetToken.sol";

interface INotionalTradeModule {
    function redeemMaturedPositions(ISetToken) external;
    function initialize(ISetToken) external;
    function updateAllowedSetToken(ISetToken, bool) external;
    function owner() external view returns(address);
    function settleAccount(address) external;
    function setRedeemToUnderlying(ISetToken, bool) external;
    function getFCashComponents(ISetToken _setToken) external view returns(address[] memory fCashComponents);
    function mintFixedFCashForToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _mintAmount,
        address _sendToken,
        uint256 _maxSendAmount
    ) external returns(uint256);
    function redeemFixedFCashForToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _redeemAmount,
        address _receiveToken,
        uint256 _minReceiveAmount
    ) external returns(uint256);

    function mintFCashForFixedToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _minMintAmount,
        address _sendToken,
        uint256 _sendAmount
    ) external returns(uint256);

    function redeemFCashForFixedToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _maxRedeemAmount,
        address _receiveToken,
        uint256 _receiveAmount,
        uint256 _maxReceiveAmountDeviation
    ) external returns(uint256);


}

