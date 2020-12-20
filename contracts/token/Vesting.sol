pragma solidity ^0.6.10;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";


contract Vesting {
    using SafeMath for uint256;

    address public index;
    address public recipient;

    uint256 public vestingAmount;
    uint256 public vestingBegin;
    uint256 public vestingCliff;
    uint256 public vestingEnd;

    uint256 public lastUpdate;

    constructor(
        address index_,
        address recipient_,
        uint256 vestingAmount_,
        uint256 vestingBegin_,
        uint256 vestingCliff_,
        uint256 vestingEnd_
    ) public {
        require(vestingBegin_ >= block.timestamp, "TreasuryVester.constructor: vesting begin too early");
        require(vestingCliff_ >= vestingBegin_, "TreasuryVester.constructor: cliff is too early");
        require(vestingEnd_ > vestingCliff_, "TreasuryVester.constructor: end is too early");

        index = index_;
        recipient = recipient_;

        vestingAmount = vestingAmount_;
        vestingBegin = vestingBegin_;
        vestingCliff = vestingCliff_;
        vestingEnd = vestingEnd_;

        lastUpdate = vestingBegin;
    }

    function setRecipient(address recipient_) public {
        require(msg.sender == recipient, "TreasuryVester.setRecipient: unauthorized");
        recipient = recipient_;
    }

    function claim() public {
        require(block.timestamp >= vestingCliff, "TreasuryVester.claim: not time yet");
        uint256 amount;
        if (block.timestamp >= vestingEnd) {
            amount = IERC20(index).balanceOf(address(this));
        } else {
            amount = vestingAmount.mul(block.timestamp.sub(lastUpdate)).div(vestingEnd.sub(vestingBegin));
            lastUpdate = block.timestamp;
        }
        IERC20(index).transfer(recipient, amount);
    }
}