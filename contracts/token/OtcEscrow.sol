//SPDX-License-Identifier: Unlicense
pragma solidity ^0.6.10;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { Vesting } from "./Vesting.sol";

/**
 * @title OtcEscrow
 * @author Badger DAO (Modified by Set Protocol)
 * 
 * A simple OTC swap contract allowing two users to set the parameters of an OTC
 * deal in the constructor arguments, and deposits the sold tokens into a vesting
 * contract when a swap is completed.
 */
contract OtcEscrow {

    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    /* ========== Events =========== */

    event VestingDeployed(address vesting);
    
    /* ====== Modifiers ======== */

    /**
     * Throws if the sender is not Index Gov
     */
    modifier onlyIndexGov() {
        require(msg.sender == indexGov, "unauthorized");
        _;
    }

    /**
     * Throws if run more than once
     */
    modifier onlyOnce() {
        require(!hasRun, "swap already executed");
        hasRun = true;
        _;
    }

    /* ======== State Variables ======= */

    address public usdc;
    address public index;

    address public indexGov;
    address public beneficiary;

    uint256 public vestingStart;
    uint256 public vestingEnd;
    uint256 public vestingCliff;

    uint256 public usdcAmount;
    uint256 public indexAmount;

    bool hasRun;



    /* ====== Constructor ======== */

    /**
     * Sets the state variables that encode the terms of the OTC sale
     *
     * @param _beneficiary  Address that will purchase INDEX
     * @param _indexGov     Address that will receive USDC
     * @param _vestingStart Timestamp of vesting start
     * @param _vestingCliff Timestamp of vesting cliff
     * @param _vestingEnd   Timestamp of vesting end
     * @param _usdcAmount   Amount of USDC swapped for the sale
     * @param _indexAmount  Amount of INDEX swapped for the sale
     * @param _usdcAddress  Address of the USDC token
     * @param _indexAddress Address of the Index token
     */
    constructor(
        address _beneficiary,
        address _indexGov,
        uint256 _vestingStart,
        uint256 _vestingCliff,
        uint256 _vestingEnd,
        uint256 _usdcAmount,
        uint256 _indexAmount,
        address _usdcAddress,
        address _indexAddress
    ) public {
        beneficiary = _beneficiary;
        indexGov =  _indexGov;

        vestingStart = _vestingStart;
        vestingCliff = _vestingCliff;
        vestingEnd = _vestingEnd;

        usdcAmount = _usdcAmount;
        indexAmount = _indexAmount;

        usdc = _usdcAddress;
        index = _indexAddress;
        hasRun = false;
    }
    
    /* ======= External Functions ======= */

    /**
     * Executes the OTC deal. Sends the USDC from the beneficiary to Index Governance, and
     * locks the INDEX in the vesting contract. Can only be called once.
     */
    function swap() external onlyOnce {

        require(IERC20(index).balanceOf(address(this)) >= indexAmount, "insufficient INDEX");

        // Transfer expected USDC from beneficiary
        IERC20(usdc).safeTransferFrom(beneficiary, address(this), usdcAmount);

        // Create Vesting contract
        Vesting vesting = new Vesting(index, beneficiary, indexAmount, vestingStart, vestingCliff, vestingEnd);

        // Transfer index to vesting contract
        IERC20(index).safeTransfer(address(vesting), indexAmount);

        // Transfer USDC to index governance
        IERC20(usdc).safeTransfer(indexGov, usdcAmount);

        emit VestingDeployed(address(vesting));
    }

    /**
     * Return INDEX to Index Governance to revoke the deal
     */
    function revoke() external onlyIndexGov {
        uint256 indexBalance = IERC20(index).balanceOf(address(this));
        IERC20(index).safeTransfer(indexGov, indexBalance);
    }

    /**
     * Recovers USDC accidentally sent to the contract
     */
    function recoverUsdc() external {
        uint256 usdcBalance = IERC20(usdc).balanceOf(address(this));
        IERC20(usdc).safeTransfer(beneficiary, usdcBalance);
    }
}