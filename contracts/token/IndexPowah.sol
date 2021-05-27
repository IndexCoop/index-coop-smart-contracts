pragma solidity 0.6.10;


import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { StakingRewardsV2 } from "../staking/StakingRewardsV2.sol";
import { IMasterChef } from "../interfaces/IMasterChef.sol";
import { IPair } from "../interfaces/IPair.sol";
import { Vesting } from "./Vesting.sol";

contract IndexPowah is IERC20 {

    using SafeMath for uint256;
    
    IERC20 public indexToken;
    StakingRewardsV2 public dpiFarm;
    StakingRewardsV2 public mviFarm;
    IMasterChef masterChef;
    IPair public uniPair;
    IPair public sushiPair;

    Vesting[] public investorVesting;

    constructor(
        IERC20 _indexToken,
        StakingRewardsV2 _dpiFarm, 
        StakingRewardsV2 _mviFarm,
        IPair _uniPair,
        IPair _sushiPair,
        IMasterChef _masterChef,
        Vesting[] memory _investorVesting
    )
        public
    {
        indexToken = _indexToken;
        dpiFarm = _dpiFarm;
        mviFarm = _mviFarm;
        uniPair = _uniPair;
        sushiPair = _sushiPair;
        masterChef = _masterChef;
        investorVesting = _investorVesting;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint256 indexAmount = indexToken.balanceOf(account);
        uint256 unclaimedInFarms = dpiFarm.earned(account) + mviFarm.earned(account);
        uint256 vestingVotes = _getVestingVotes(account);
        uint256 dexVotes = _getDexVotes(account, uniPair) + _getDexVotes(account, sushiPair) + _getMasterChefVotes(account);

        return indexAmount + unclaimedInFarms + vestingVotes + dexVotes;
    }

    function _getVestingVotes(address account) internal view returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < investorVesting.length; i++) {
            if(investorVesting[i].recipient() == account) {
                sum += indexToken.balanceOf(address(investorVesting[i]));
            }
        }
        return sum;
    }

    function _getDexVotes(address account, IPair pair) internal view returns (uint256) {
        uint256 lpBalance = pair.balanceOf(account);
        return _getDexVotesFromBalance(lpBalance, pair);
    }

    function _getMasterChefVotes(address account) internal view returns (uint256) {
        (uint256 lpBalance,) = masterChef.userInfo(75, account);
        return _getDexVotesFromBalance(lpBalance, sushiPair);
    }

    function _getDexVotesFromBalance(uint256 lpBalance, IPair pair) internal view returns (uint256) {
        uint256 lpIndex = indexToken.balanceOf(address(pair));
        uint256 lpTotal = pair.totalSupply();
        if (lpTotal == 0) return 0;
        return lpIndex.mul(lpBalance).div(lpTotal);
    }


    /**
     * These functions are not used, but have been left in to keep the token ERC20 compliant
     */
    function name() public pure returns (string memory) { return "INDEXPOWAH"; }
    function symbol() public pure returns (string memory) { return "INDEXPOWAH"; }
    function decimals() public pure returns(uint8) { return 18; }
    function totalSupply() public view override returns (uint256) { return indexToken.totalSupply(); }
    function allowance(address, address) public view override returns (uint256) { return 0; }
    function transfer(address, uint256) public override returns (bool) { return false; }
    function approve(address, uint256) public override returns (bool) { return false; }
    function transferFrom(address, address, uint256) public override returns (bool) { return false; }
}