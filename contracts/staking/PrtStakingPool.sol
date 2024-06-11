/*
    Copyright 2024 Index Cooperative

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

pragma solidity ^0.6.10;
pragma experimental ABIEncoderV2;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Snapshot } from "@openzeppelin/contracts/token/ERC20/ERC20Snapshot.sol";
import { Math } from  "@openzeppelin/contracts/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IPrt } from "../interfaces/IPrt.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title PrtStakingPool
 * @author Index Cooperative
 * @dev A contract for staking PRT tokens and distributing SetTokens.
 */
contract PrtStakingPool is Ownable, ERC20Snapshot, ReentrancyGuard {
    using SafeMath for uint256;

    /* ============ Events ============ */

    event FeeSplitExtensionChanged(address _newFeeSplitExtension);

    /* ============ Immutables ============ */

    /// @notice SetToken to be distributed to stakers
    ISetToken public immutable setToken;

    /// @notice PRT token to be staked
    IPrt public immutable prt;

    /* ============ State Variables ============ */

    /// @notice PRT Fee split extension which accrues fees and distributes setToken
    address public feeSplitExtension;

    /// @notice Snapshot id of the last claim for each staker
    mapping(address => uint256) public lastSnapshotId;

    /// @notice Amount of setToken accrued and distributed with each snapshot
    uint256[] public accrueSnapshots;

    /* ============ Modifiers ============ */

    /**
     * @dev Modifier to restrict snapshot calls to only the fee split extension.
     */
    modifier onlyFeeSplitExtension() {
        require(msg.sender == feeSplitExtension, "Must be FeeSplitExtension");
        _;
    }

    /* ========== Constructor ========== */

    /**
     * @notice Constructor to initialize the PRT Staking Pool.
     * @param _name Name of the staked PRT token
     * @param _symbol Symbol of the staked PRT token
     * @param _prt Instance of the PRT token contract
     * @param _feeSplitExtension Address of the PrtFeeSplitExtension contract
     */
    constructor(
        string memory _name,
        string memory _symbol,
        IPrt _prt,
        address _feeSplitExtension
    )
        public
        ERC20(_name, _symbol)
    {
        prt = _prt;
        setToken = ISetToken(_prt.setToken());
        feeSplitExtension = _feeSplitExtension;
    }

    /* ========== External Functions ========== */

    /**
     * @notice Stake `amount` of PRT tokens from `msg.sender` and mint staked PRT tokens.
     * @param _amount The amount of PRT tokens to stake
     */
    function stake(uint256 _amount) external nonReentrant {
        require(_amount > 0, "Cannot stake 0");
        prt.transferFrom(msg.sender, address(this), _amount);
        super._mint(msg.sender, _amount);
    }

    /**
     * @notice Unstake `amount` of PRT tokens by `msg.sender`.
     * @param _amount The amount of PRT tokens to unstake
     */
    function unstake(uint256 _amount) public nonReentrant {
        require(_amount > 0, "Cannot unstake 0");
        super._burn(msg.sender, _amount);
        prt.transfer(msg.sender, _amount);
    }

    /**
     * @notice ONLY FEE SPLIT EXTENSION: Accrue SetTokens and update snapshot.
     * @param _amount The amount of SetTokens to accrue
     */
    function accrue(uint256 _amount) external nonReentrant onlyFeeSplitExtension {
        require(_amount > 0, "Cannot accrue 0");
        setToken.transferFrom(msg.sender, address(this), _amount);
        accrueSnapshots.push(_amount);
        super._snapshot();
    }

    /**
     * @notice Claim the staking rewards from pending snapshots for `msg.sender`.
     */
    function claim() public nonReentrant {
        uint256 currentId = getCurrentId();
        uint256 amount = _getPendingRewards(currentId, msg.sender);
        require(amount > 0, "No rewards to claim");
        lastSnapshotId[msg.sender] = currentId;
        setToken.transfer(msg.sender, amount);
    }

    /**
     * @notice ONLY OWNER: Update the PrtFeeSplitExtension address.
     */
    function setFeeSplitExtension(address _feeSplitExtension) external onlyOwner {
        feeSplitExtension = _feeSplitExtension;
        FeeSplitExtensionChanged(_feeSplitExtension);
    }

    /* ========== ERC20 Overrides ========== */

    function transfer(address /*recipient*/, uint256 /*amount*/) public override returns (bool) {
        revert("Transfers not allowed");
    }

    function transferFrom(address /*sender*/, address /*recipient*/, uint256 /*amount*/) public override returns (bool) {
        revert("Transfers not allowed");
    }

    /* ========== View Functions ========== */

    /**
     * @notice Get the current snapshot id.
     * @return The current snapshot id
     */
    function getCurrentId() public view returns (uint256) {
        return accrueSnapshots.length;
    }

    /**
     * @notice Get pending rewards for an account.
     * @param _account The address of the account
     * @return The pending rewards for the account
     */
    function getPendingRewards(
        address _account
    ) external view returns (uint256) {
        uint256 currentId = getCurrentId();
        return _getPendingRewards(currentId, _account);
    }

    /**
     * @notice Get rewards for an account from a specific snapshot id.
     * @param _snapshotId The snapshot id
     * @param _account The address of the account
     * @return The rewards for the account from the snapshot id
     */
    function getSnapshotRewards(
        uint256 _snapshotId,
        address _account
    ) external view returns (uint256) {
        return _getSnapshotRewards(_snapshotId, _account);
    }

    /**
     * @notice Get account summary for a specific snapshot id.
     * @param _snapshotId The snapshot id
     * @param _account The address of the account
     * @return snapshotRewards The rewards for the account from the snapshot id
     * @return totalRewards The total rewards accrued from the snapshot id
     * @return totalSupply The total staked supply at the snapshot id
     * @return balance The staked balance of the account at the snapshot id
     */
    function getSnapshotSummary(
        uint256 _snapshotId,
        address _account
    ) 
        external 
        view 
        returns (
            uint256 snapshotRewards, 
            uint256 totalRewards, 
            uint256 totalSupply, 
            uint256 balance
        ) 
    {
        snapshotRewards = _getSnapshotRewards(_snapshotId, _account);
        totalRewards = accrueSnapshots[_snapshotId];
        totalSupply = totalSupplyAt(_snapshotId + 1);
        balance = balanceOfAt(_account, _snapshotId + 1);
    }

    /**
     * @notice Get accrue snapshots.
     * @return The accrue snapshots
     */
    function getAccrueSnapshots() external view returns(uint256[] memory) {
        return accrueSnapshots;
    }

    /* ========== Internal Functions ========== */

    /**
     * @dev Get pending rewards for an account.
     * @param _currentId The current snapshot id
     * @param _account The address of the account
     * @return amount The pending rewards for the account
     */
    function _getPendingRewards(
        uint256 _currentId,
        address _account
    ) 
        private 
        view 
        returns (uint256 amount) 
    {
        uint256 lastRewardId = lastSnapshotId[_account];
        for (uint256 i = lastRewardId; i < _currentId; i++) {
            amount += _getSnapshotRewards(i, _account);
        }
    }

    /**
     * @dev Get rewards for an account from a specific snapshot id.
     * @param _snapshotId The snapshot id
     * @param _account The address of the account
     * @return The rewards for the account from the snapshot id
     */
    function _getSnapshotRewards(
        uint256 _snapshotId,
        address _account
    ) 
        private 
        view 
        returns (uint256) 
    {
        return accrueSnapshots[_snapshotId].mul(
            balanceOfAt(_account, _snapshotId + 1)
        ).div(
            totalSupplyAt(_snapshotId + 1)
        );
    }
}
