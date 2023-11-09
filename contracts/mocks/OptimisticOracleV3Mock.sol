// SPDX-License-Identifier: MIT
pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import {OptimisticOracleV3Interface} from "../interfaces/OptimisticOracleV3Interface.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";


/**
 * @title Optimistic Oracle V3.
 * @notice The OOv3 is used to assert truths about the world which are verified using an optimistic escalation game.
 * @dev Core idea: an asserter makes a statement about a truth, calling "assertTruth". If this statement is not
 * challenged, it is taken as the state of the world. If challenged, it is arbitrated using the UMA DVM, or if
 * configured, an escalation manager. Escalation managers enable integrations to define their own security properties and
 * tradeoffs, enabling the notion of "sovereign security".
 */
contract OptimisticOracleV3Mock is OptimisticOracleV3Interface {
    // Mock implementation of defaultIdentifier
    function defaultIdentifier() public view override returns (bytes32) {
        return (bytes32("helloWorld"));
    }

    // Mock implementation of getAssertion
    function getAssertion(bytes32 ) public view override returns (Assertion memory) {
        return (Assertion({
            escalationManagerSettings: EscalationManagerSettings({
                arbitrateViaEscalationManager: false,
                discardOracle: false,
                validateDisputers: false,
                assertingCaller: address(0),
                escalationManager: address(0)
            }),
            asserter: address(0),
            assertionTime: uint64(0),
            settled: false,
            currency: IERC20(address(0)),
            expirationTime: uint64(0),
            settlementResolution: false,
            domainId: bytes32(0),
            identifier: bytes32(0),
            bond: uint256(0),
            callbackRecipient: address(0),
            disputer: address(0)
        }));
    }

    // Mock implementation of assertTruthWithDefaults
    function assertTruthWithDefaults(bytes memory , address) public override returns (bytes32) {
        return (bytes32(0));
    }

    // Mock implementation of assertTruth
    function assertTruth(bytes memory, address , address , address , uint64 , IERC20 , uint256 , bytes32 , bytes32 ) public override returns (bytes32) {
        return (bytes32("win"));
    }

    // Mock implementation of syncUmaParams
    function syncUmaParams(bytes32 identifier, address currency) public override {
        // No return for void functions
    }

    // Mock implementation of settleAssertion
    function settleAssertion(bytes32 assertionId) public override {
        // No return for void functions
    }

    // Mock implementation of settleAndGetAssertionResult
    function settleAndGetAssertionResult(bytes32 ) public override returns (bool) {
        return (false);
    }

    // Mock implementation of getAssertionResult
    function getAssertionResult(bytes32 ) public view override returns (bool) {
        return (false);
    }

    // Mock implementation of getMinimumBond
    function getMinimumBond(address ) public view override returns (uint256) {
        return (uint256(0));
    }

}