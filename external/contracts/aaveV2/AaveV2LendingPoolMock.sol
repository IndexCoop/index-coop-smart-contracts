// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;
import {
    LendingPool,
    IFlashLoanReceiver,
    Errors
} from "../../contracts/protocol/lendingpool/LendingPool.sol";

contract AaveV2LendingPoolMock is LendingPool {
    function flashLoanMock(
    address receiverAddress,
    address[] calldata assets,
    uint256[] calldata amounts,
    uint256[] calldata premiums,
    bytes calldata params
  ) external {
    IFlashLoanReceiver receiver = IFlashLoanReceiver(receiverAddress);

    address _receiverAddress = receiverAddress;

    require(
      receiver.executeOperation(assets, amounts, premiums, _receiverAddress, params),
      Errors.LP_INVALID_FLASH_LOAN_EXECUTOR_RETURN
    );
  }
}