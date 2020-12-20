pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { ISetToken } from "./ISetToken.sol";

interface IStreamingFeeModule {
    function getFee(ISetToken _setToken) external view returns (uint256);
    function accrueFee(ISetToken _setToken) external;
    function updateStreamingFee(ISetToken _setToken, uint256 _newFee) external;
    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient) external;
}