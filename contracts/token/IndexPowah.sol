/*
    Copyright 2021 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;


import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { StakingRewardsV2 } from "../staking/StakingRewardsV2.sol";
import { IMasterChef } from "../interfaces/IMasterChef.sol";
import { IPair } from "../interfaces/IPair.sol";
import { Vesting } from "./Vesting.sol";


/**
 * @title IndexPowah
 * @author Set Protocol
 *
 * An ERC20 token used for tracking the voting power for the Index Coop. The mutative functions of
 * the ERC20 interface have been disabled since the token is only designed to count votes for the
 * sake of utilizing Snapshot's erc20-balance-of strategy. This contract is inspired by Sushiswap's
 * SUSHIPOWAH contract which serves the same purpose.
 */
contract IndexPowah is IERC20, Ownable {

    using SafeMath for uint256;

    IERC20 public indexToken;

    IMasterChef public masterChef;
    uint256 public masterChefId;
    IPair public uniPair;
    IPair public sushiPair;

    StakingRewardsV2[] public farms;
    Vesting[] public vesting;

    /**
     * Sets the appropriate state variables for the contract.
     *
     * @param _owner        owner of this contract
     * @param _indexToken   Index Coop's governance token contract
     * @param _uniPair      INDEX-WETH Uniswap pair
     * @param _sushiPair    INDEX-WETH Sushiswap pair
     * @param _masterChef   Sushiswap MasterChef (Onsen) contract
     * @param _farms        array of Index Coop staking farms
     * @param _vesting      array of vesting contracts from the index sale and full time contributors
     */
    constructor(
        address _owner,
        IERC20 _indexToken,
        IPair _uniPair,
        IPair _sushiPair,
        IMasterChef _masterChef,
        uint256 _masterChefId,
        StakingRewardsV2[] memory _farms,
        Vesting[] memory _vesting
    )
        public
    {
        indexToken = _indexToken;
        uniPair = _uniPair;
        sushiPair = _sushiPair;
        masterChef = _masterChef;
        masterChefId = _masterChefId;
        farms = _farms;
        vesting = _vesting;

        transferOwnership(_owner);
    }

    /**
     * Computes an address's balance of IndexPowah. Balances can not be transfered in the traditional way,
     * but are instead computed by the amount of index that an account directly hold, or indirectly holds
     * through the staking contracts, vesting contracts, uniswap, and sushiswap.
     *
     * @param _account  the address of the voter
     */
    function balanceOf(address _account) public view override returns (uint256) {
        uint256 indexAmount = indexToken.balanceOf(_account);
        uint256 unclaimedInFarms = _getFarmVotes(_account);
        uint256 vestingVotes = _getVestingVotes(_account);
        uint256 dexVotes = _getDexVotes(_account, uniPair) + _getDexVotes(_account, sushiPair) + _getMasterChefVotes(_account);

        return indexAmount + unclaimedInFarms + vestingVotes + dexVotes;
    }

    /**
     * ONLY OWNER: Adds new Index farms to be tracked
     *
     * @param _newFarms list of new farms to be tracked
     */
    function addFarms(StakingRewardsV2[] calldata _newFarms) external onlyOwner {
        for (uint256 i = 0; i < _newFarms.length; i++) {
            farms.push(_newFarms[0]);
        }
    }

    /**
     * ONLY OWNER: Adds new Index vesting contracts to be tracked
     *
     * @param _newVesting   list of new vesting contracts to be tracked
     */
    function addVesting(Vesting[] calldata _newVesting) external onlyOwner {
        for (uint256 i = 0; i < _newVesting.length; i++) {
            vesting.push(_newVesting[i]);
        }
    }

    /**
     * ONLY OWNER: Updates the MasterChef contract and pool ID
     *
     * @param _newMasterChef    address of the new MasterChef contract
     * @param _newMasterChefId  new pool id for the index-eth MasterChef rewards
     */
    function updateMasterChef(IMasterChef _newMasterChef, uint256 _newMasterChefId) external onlyOwner {
        masterChef = _newMasterChef;
        masterChefId = _newMasterChefId;
    }

    function _getFarmVotes(address _account) internal view returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < farms.length; i++) {
            sum += farms[i].earned(_account);
        }
        return sum;
    }

    function _getVestingVotes(address _account) internal view returns (uint256) {
        uint256 sum = 0;
        for (uint256 i = 0; i < vesting.length; i++) {
            if(vesting[i].recipient() == _account) {
                sum += indexToken.balanceOf(address(vesting[i]));
            }
        }
        return sum;
    }

    function _getDexVotes(address _account, IPair pair) internal view returns (uint256) {
        uint256 lpBalance = pair.balanceOf(_account);
        return _getDexVotesFromBalance(lpBalance, pair);
    }

    function _getMasterChefVotes(address _account) internal view returns (uint256) {
        (uint256 lpBalance,) = masterChef.userInfo(masterChefId, _account);
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