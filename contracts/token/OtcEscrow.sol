//SPDX-License-Identifier: Unlicense
pragma solidity ^0.6.10;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { Vesting } from "./Vesting.sol";

/*
    Simple OTC Escrow contract to transfer index in exchange for specified USDC amount
*/
contract OtcEscrow {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    event VestingDeployed(address vesting);

    address public usdc;
    address public index;

    address public indexGov;
    address public beneficiary;

    uint256 public vestingStart;
    uint256 public vestingEnd;
    uint256 public vestingCliff;

    uint256 public usdcAmount;
    uint256 public indexAmount;

    constructor(
        address _beneficiary,
        address _indexGov,
        uint256 _vestingStart,
        uint256 _vestingEnd,
        uint256 _vestingCliff,
        uint256 _usdcAmount,
        uint256 _indexAmount,
        address _indexAddress,
        address _usdcAddress
    ) public {
        beneficiary = _beneficiary;
        indexGov =  _indexGov;

        vestingStart = _vestingStart;
        vestingCliff = _vestingCliff;
        vestingEnd = _vestingEnd;

        usdcAmount = _usdcAmount;
        indexAmount = _indexAmount;

        index = _indexAddress;
        usdc = _usdcAddress;
    }

    modifier onlyApprovedParties() {
        require(msg.sender == indexGov || msg.sender == beneficiary);
        _;
    }

    /// @dev Atomically trade specified amonut of USDC for control over index in vesting contract
    /// @dev Either counterparty may execute swap if sufficient token approval is given by recipient
    function swap() public onlyApprovedParties {
        // Transfer expected USDC from beneficiary
        IERC20(usdc).safeTransferFrom(beneficiary, address(this), usdcAmount);

        // Create Vesting contract
        Vesting vesting = new Vesting(index, beneficiary, indexAmount, vestingStart, vestingCliff, vestingEnd);

        // Transfer index to vesting contract
        IERC20(index).safeTransfer(address(vesting), indexAmount);

        // Transfer USDC to badger governance
        IERC20(usdc).safeTransfer(indexGov, usdcAmount);

        emit VestingDeployed(address(vesting));
    }

    /// @dev Return index to Index Governance to revoke escrow deal
    function revoke() external {
        require(msg.sender == indexGov, "onlyIndexGovernance");
        uint256 indexBalance = IERC20(index).balanceOf(address(this));
        IERC20(index).safeTransfer(indexGov, indexBalance);
    }

    function revokeUsdc() external onlyApprovedParties {
        uint256 usdcBalance = IERC20(usdc).balanceOf(address(this));
        IERC20(usdc).safeTransfer(beneficiary, usdcBalance);
    }
}