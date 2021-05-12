pragma solidity ^0.6.10;

import "deps/@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "deps/@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "deps/@openzeppelin/contracts/math/SafeMath.sol";
import "deps/@openzeppelin/contracts/token/ERC20/TokenTimelock.sol";

/*
    Simple OTC Escrow contract to transfer vested INDEX in exchange for specified USDC amount
    Forked from BadgerDAO https://github.com/Badger-Finance/badger-system/blob/develop/contracts/badger-timelock/OtcEscrow.sol
*/
contract OtcEscrow {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    address constant usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    event VestingDeployed(address vesting);

    address public beneficiary;
    address public indexToken;
    address public indexTreasuryWallet;
    uint256 public duration;
    uint256 public usdcAmount;
    uint256 public bBadgerAmount;

    constructor(
        address beneficiary_,
        address indexToken_,
        address indexTreasuryWallet_,
        uint256 duration_,
        uint256 usdcAmount_,
        uint256 bBadgerAmount_
    ) public {
        beneficiary = beneficiary_;
        indexToken = indexToken_;
        indexTreasuryWallet = indexTreasuryWallet_;
        duration = duration_;
        usdcAmount = usdcAmount_;
        bBadgerAmount = bBadgerAmount_;
    }

    modifier onlyApprovedParties() {
        require(msg.sender == badgerGovernance || msg.sender == beneficiary, "Escrow.onlyApprovedParties: unauthorized");
        _;
    }

    /// @dev Atomically trade specified amonut of USDC for control over bBadger in vesting contract
    /// @dev Either counterparty may execute swap if sufficient token approval is given by recipient
    function swap() public onlyApprovedParties {
        // Transfer expected USDC from beneficiary
        IERC20(usdc).safeTransferFrom(beneficiary, address(this), usdcAmount);

        // Create Vesting contract
        TokenTimelock vesting = new TokenTimelock(IERC20(bBadger), beneficiary, now + duration);

        // Transfer bBadger to vesting contract
        IERC20(bBadger).safeTransfer(address(vesting), bBadgerAmount);

        // Transfer USDC to badger governance
        IERC20(usdc).safeTransfer(badgerGovernance, usdcAmount);

        emit VestingDeployed(address(vesting));
    }

    /// @dev Return bBadger to Badger Governance to revoke escrow deal
    function revoke() external {
        require(msg.sender == badgerGovernance, "onlyBadgerGovernance");
        uint256 bBadgerBalance = IERC20(bBadger).balanceOf(address(this));
        IERC20(bBadger).safeTransfer(badgerGovernance, bBadgerBalance);
    }

    function revokeUsdc() external onlyApprovedParties {
        uint256 usdcBalance = IERC20(usdc).balanceOf(address(this));
        IERC20(usdc).safeTransfer(beneficiary, usdcBalance);
    }
}