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

import { ECDSA } from "@openzeppelin/contracts/cryptography/ECDSA.sol";
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

    bytes32 private constant TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string private constant MESSAGE_TYPE = "Stake(string message)";

    /* ============ Events ============ */

    event FeeSplitExtensionChanged(address _newFeeSplitExtension);
    event SnapshotDelayChanged(uint256 _newSnapshotDelay);

    /* ============ Immutables ============ */

    /// @notice SetToken to be distributed to stakers
    ISetToken public immutable setToken;

    /// @notice PRT token to be staked
    IPrt public immutable prt;

    /* ============ EIP712 ============ */

    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;
    address private immutable _cachedThis;

    bytes32 private immutable _hashedName;
    bytes32 private immutable _hashedVersion;

    string private _eip712Name;
    string private _eip712Version;

    string public message;

    /* ============ State Variables ============ */

    /// @notice PRT Fee split extension which accrues fees and distributes setToken
    address public feeSplitExtension;

    /// @notice Snapshot id of the last claim for each staker
    mapping(address => uint256) public lastSnapshotId;

    /// @notice Amount of setToken accrued and distributed with each snapshot
    uint256[] public accrueSnapshots;

    /// @notice The minimum amount of time between snapshots
    uint256 public snapshotDelay;

    /// @notice The last time a snapshot was taken
    uint256 public lastSnapshotTime;

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
     * @param eip712Name_ Name of the EIP712 signing domain
     * @param eip712Version_ Current major version of the EIP712 signing domain
     * @param _message The message to sign when staking
     * @param _name Name of the staked PRT token
     * @param _symbol Symbol of the staked PRT token
     * @param _prt Instance of the PRT token contract
     * @param _feeSplitExtension Address of the PrtFeeSplitExtension contract
     * @param _snapshotDelay The minimum amount of time between snapshots
     */
    constructor(
        string memory eip712Name_,
        string memory eip712Version_,
        string memory _message,
        string memory _name,
        string memory _symbol,
        IPrt _prt,
        address _feeSplitExtension,
        uint256 _snapshotDelay
    )
        public
        ERC20(_name, _symbol)
    {
        prt = _prt;
        setToken = ISetToken(_prt.setToken());
        feeSplitExtension = _feeSplitExtension;
        snapshotDelay = _snapshotDelay;
        message = _message;

        uint256 _chainId;
        assembly {
            _chainId := chainid()
        }
        _cachedChainId = _chainId;
        _cachedDomainSeparator = keccak256(
            abi.encode(
                TYPE_HASH, 
                keccak256(bytes(eip712Name_)), 
                keccak256(bytes(eip712Version_)), 
                _chainId, 
                address(this)
            )
        );
        _cachedThis = address(this);
        _eip712Name = eip712Name_;
        _eip712Version = eip712Version_;
        _hashedName = keccak256(bytes(eip712Name_));
        _hashedVersion = keccak256(bytes(eip712Version_));
    }

    /* ========== External Functions ========== */

    /**
     * @notice Stake `amount` of PRT tokens from `msg.sender` and mint staked PRT tokens.
     * @param _amount The amount of PRT tokens to stake
     */
    function stake(uint256 _amount, bytes memory _signature) external nonReentrant {
        require(getSigner(_signature) == msg.sender, "Invalid signature");
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
        require(totalSupply() > 0, "Cannot accrue with 0 staked supply");
        require(canAccrue(), "Snapshot delay not passed");
        setToken.transferFrom(msg.sender, address(this), _amount);
        lastSnapshotTime = block.timestamp;
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
     * @notice Claim partial staking rewards from pending snapshots for `msg.sender` up to `_endClaimId`.
     * @param _endClaimId The snapshot id to end the partial claim
     */
    function claimPartial(uint256 _endClaimId) public nonReentrant {
        uint256 currentId = getCurrentId();
        uint256 amount = _getPendingPartialRewards(currentId, _endClaimId, msg.sender);
        require(amount > 0, "No rewards to claim");
        lastSnapshotId[msg.sender] = _endClaimId;
        setToken.transfer(msg.sender, amount);
    }

    /**
     * @notice ONLY OWNER: Update the PrtFeeSplitExtension address.
     */
    function setFeeSplitExtension(address _feeSplitExtension) external onlyOwner {
        feeSplitExtension = _feeSplitExtension;
        emit FeeSplitExtensionChanged(_feeSplitExtension);
    }

    /**
     * @notice ONLY OWNER: Update the snapshot delay. Can set to 0 to disable snapshot delay.
     * @param _snapshotDelay The new snapshot delay
     */
    function setSnapshotDelay(uint256 _snapshotDelay) external onlyOwner {
        snapshotDelay = _snapshotDelay;
        emit SnapshotDelayChanged(_snapshotDelay);
    }

    /* ========== ERC20 Overrides ========== */

    function transfer(address /*recipient*/, uint256 /*amount*/) public override returns (bool) {
        revert("Transfers not allowed");
    }

    function transferFrom(address /*sender*/, address /*recipient*/, uint256 /*amount*/) public override returns (bool) {
        revert("Transfers not allowed");
    }

    /* ========== View Functions ========== */

    function getSigner(bytes memory _signature) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparatorV4(),
                keccak256(
                    abi.encode(
                        keccak256(abi.encodePacked(MESSAGE_TYPE)),
                        message
                    )
                )
            )
        );
        return ECDSA.recover(hash, _signature);
    }

    /**
     * @notice ERC-5267 retrieval of EIP-712 domain
     */
    function eip712Domain()
        public
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        assembly {
            chainId := chainid()
        }
        return (
            hex"0f", // 01111
            _eip712Name,
            _eip712Version,
            chainId,
            address(this),
            bytes32(0),
            new uint256[](0)
        );
    }

    /**
     * @notice Check if rewards can be accrued.
     * @return Boolean indicating if rewards can be accrued
     */
    function canAccrue() public view returns (bool) {
        return block.timestamp >= lastSnapshotTime.add(snapshotDelay);
    }

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
     * @notice Get pending partial rewards for an account.
     * @param _account The address of the account
     * @param _endClaimId The snapshot id to end the partial claim
     * @return The pending partial rewards for the account
     */
    function getPendingPartialRewards(
        address _account,
        uint256 _endClaimId
    ) external view returns (uint256) {
        uint256 currentId = getCurrentId();
        return _getPendingPartialRewards(currentId, _endClaimId, _account);
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
     * @dev Get pending partial rewards for an account.
     * @param _currentId The current snapshot id
     * @param _endClaimId The snapshot id to end the partial claim
     * @param _account The address of the account
     * @return amount The pending partial rewards for the account
     */
    function _getPendingPartialRewards(
        uint256 _currentId,
        uint256 _endClaimId,
        address _account
    ) 
        private 
        view 
        returns (uint256 amount) 
    {
        require(_endClaimId < _currentId, "End claim id must be less than current id");
        uint256 lastRewardId = lastSnapshotId[_account];
        for (uint256 i = lastRewardId; i < _endClaimId; i++) {
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

    /**
     * @dev Returns the domain separator for the current chain.
     */
    function _domainSeparatorV4() internal view returns (bytes32) {
        uint256 _chainId;
        assembly {
            _chainId := chainid()
        }
        if (address(this) == _cachedThis && _chainId == _cachedChainId) {
            return _cachedDomainSeparator;
        } else {
            return _buildDomainSeparator(_chainId);
        }
    }

    function _buildDomainSeparator(uint256 _chainId) private view returns (bytes32) {
        return keccak256(abi.encode(TYPE_HASH, _hashedName, _hashedVersion, _chainId, address(this)));
    }
}
