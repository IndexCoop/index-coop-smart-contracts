// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;


import { IBaseManager } from "../interfaces/IBaseManager.sol";
import { BaseExtension } from "../lib/BaseExtension.sol";
import "hardhat/console.sol";

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

    /**
     * ONLY EOA AND ALLOWED CALLER: Rebalance according to flexible leverage methodology. If current leverage ratio is between the max and min bounds, then rebalance
     * can only be called once the rebalance interval has elapsed since last timestamp. If outside the max and min, rebalance can be called anytime to bring leverage
     * ratio back to the max or min bounds. The methodology will determine whether to delever or lever.
     *
     * Note: If the calculated current leverage ratio is above the incentivized leverage ratio or in TWAP then rebalance cannot be called. Instead, you must call
     * ripcord() which is incentivized with a reward in Ether or iterateRebalance().
     *
     * @param _exchangeName     the exchange used for trading
     */
    function rebalance(string memory _exchangeName) external onlyAllowedCaller(msg.sender) {
        require(keccak256(abi.encodePacked(_exchangeName)) == keccak256(abi.encodePacked(exchangeName)), "Exchange names are not equal");
        emit RebalanceEvent(ShouldRebalance.REBALANCE);
    }

    /**
     * ONLY EOA AND ALLOWED CALLER: Iterate a rebalance when in TWAP. TWAP cooldown period must have elapsed. If price moves advantageously, then exit without rebalancing
     * and clear TWAP state. This function can only be called when below incentivized leverage ratio and in TWAP state.
     *
     * @param _exchangeName     the exchange used for trading
     */
    function iterateRebalance(string memory _exchangeName) external onlyAllowedCaller(msg.sender) {
        require(keccak256(abi.encodePacked(_exchangeName)) == keccak256(abi.encodePacked(exchangeName)), "Exchange names are not equal");
        emit RebalanceEvent(ShouldRebalance.ITERATE_REBALANCE);
    }

    /**
     * ONLY EOA: In case the current leverage ratio exceeds the incentivized leverage threshold, the ripcord function can be called by anyone to return leverage ratio
     * back to the max leverage ratio. This function typically would only be called during times of high downside volatility and / or normal keeper malfunctions. The caller
     * of ripcord() will receive a reward in Ether. The ripcord function uses it's own TWAP cooldown period, slippage tolerance and TWAP max trade size which are typically
     * looser than in regular rebalances.
     *
     * @param _exchangeName     the exchange used for trading
     */
    function ripcord(string memory _exchangeName) external { 
        require(keccak256(abi.encodePacked(_exchangeName)) == keccak256(abi.encodePacked(exchangeName)), "Exchange names are not equal");
        emit RebalanceEvent(ShouldRebalance.RIPCORD);
    }
}
