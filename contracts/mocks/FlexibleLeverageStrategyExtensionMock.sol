// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;


import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { BaseExtension } from "../lib/BaseExtension.sol";

contract FlexibleLeverageStrategyExtensionMock is BaseExtension {

    /* ============ Enums ============ */

    enum ShouldRebalance {
        NONE,                   // Indicates no rebalance action can be taken
        REBALANCE,              // Indicates rebalance() function can be successfully called
        ITERATE_REBALANCE,      // Indicates iterateRebalance() function can be successfully called
        RIPCORD                 // Indicates ripcord() function can be successfully called
    }

    /* ============ State Variables ============ */
    uint256 public currentLeverageRatio;             // The current leverage ratio
    string public exchangeName;                      // The exchange name

    /* ============ Events ============ */
    event RebalanceEvent(ShouldRebalance _rebalance);    // A rebalance occurred

    /**
     * Instantiate addresses, methodology parameters, execution parameters, and incentive parameters.
     *
     * @param _manager                  Address of IBaseManager contract
     */
    constructor(IBaseManager _manager, uint256 _currentLeverageRatio, string memory _exchangeName) public BaseExtension(_manager) {
        currentLeverageRatio = _currentLeverageRatio;
        exchangeName = _exchangeName;
    }

    /**
     * Helper that checks if conditions are met for rebalance or ripcord. Returns an enum with 0 = no rebalance, 1 = call rebalance(), 2 = call iterateRebalance()
     * 3 = call ripcord()
     *
     * @return (string[] memory, ShouldRebalance[] memory)      List of exchange names and a list of enums representing whether that exchange should rebalance
     */
    function shouldRebalance() external view returns (string[] memory, ShouldRebalance[] memory) {
        return _shouldRebalance(); 
    }

    function shouldRebalanceWithBounds(uint256 _customMinLeverageRatio, uint256 _customMaxLeverageRatio) external view returns (string[] memory, ShouldRebalance[] memory) {
        return _shouldRebalance();
    }

    /**
     * @param _exchangeName     the exchange used for trading
     */
    function rebalance(string memory _exchangeName) external onlyAllowedCaller(msg.sender) {
        require(keccak256(abi.encodePacked(_exchangeName)) == keccak256(abi.encodePacked(exchangeName)), "Exchange names are not equal");
        emit RebalanceEvent(ShouldRebalance.REBALANCE);
    }

    /**
     * @param _exchangeName     the exchange used for trading
     */
    function iterateRebalance(string memory _exchangeName) external onlyAllowedCaller(msg.sender) {
        require(keccak256(abi.encodePacked(_exchangeName)) == keccak256(abi.encodePacked(exchangeName)), "Exchange names are not equal");
        emit RebalanceEvent(ShouldRebalance.ITERATE_REBALANCE);
    }

    /**
     *
     * @param _exchangeName     the exchange used for trading
     */
    function ripcord(string memory _exchangeName) external { 
        require(keccak256(abi.encodePacked(_exchangeName)) == keccak256(abi.encodePacked(exchangeName)), "Exchange names are not equal");
        emit RebalanceEvent(ShouldRebalance.RIPCORD);
    }

    function _shouldRebalance() private view returns (string[] memory, ShouldRebalance[] memory) {
        ShouldRebalance rebalanceStrategy = ShouldRebalance.NONE;
        if (currentLeverageRatio == 1) {
            rebalanceStrategy = ShouldRebalance.REBALANCE;
        } else if (currentLeverageRatio == 2) {
            rebalanceStrategy = ShouldRebalance.ITERATE_REBALANCE;
        } else if (currentLeverageRatio == 3) {
            rebalanceStrategy = ShouldRebalance.RIPCORD;
        }
        string[] memory exchangeNames = new string[](1);
        exchangeNames[0] = exchangeName;

        ShouldRebalance[] memory shouldRebalances = new ShouldRebalance[](1);
        shouldRebalances[0] = rebalanceStrategy;
        return (exchangeNames, shouldRebalances);
    }
}
