pragma solidity 0.6.10;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { StakingRewardsV2 } from "../staking/StakingRewardsV2.sol";

contract IndexPowah is IERC20 {
    
    IERC20 public indexToken;
    StakingRewardsV2 public dpiFarm;
    StakingRewardsV2 public mviFarm;

    constructor(IERC20 _indexToken, StakingRewardsV2 _dpiFarm, StakingRewardsV2 _mviFarm) public {
        indexToken = _indexToken;
        dpiFarm = _dpiFarm;
        mviFarm = _mviFarm;
    }

    function name() public pure returns (string memory) { return "INDEXPOWAH"; }
    function symbol() public pure returns (string memory) { return "INDEXPOWAH"; }
    function decimals() public pure returns(uint8) { return 18; }

    function totalSupply() public view override returns (uint256) {
        return indexToken.totalSupply();
    }

    function allowance(address, address) public view override returns (uint256) { return 0; }
    function transfer(address, uint256) public override returns (bool) { return false; }
    function approve(address, uint256) public override returns (bool) { return false; }
    function transferFrom(address, address, uint256) public override returns (bool) { return false; }

    function balanceOf(address account) public view override returns (uint256) {
        uint256 indexAmount = indexToken.balanceOf(account);
        uint256 unclaimedInFarms = dpiFarm.earned(account) + mviFarm.earned(account);

        return indexAmount + unclaimedInFarms;
    }
}