pragma solidity ^0.6.10;

import { IICManagerV2 } from "../interfaces/IICManagerV2.sol";

abstract contract BaseAdapter {

    /* ============ Modifiers ============ */

    /**
     * Throws if the sender is not the SetToken operator
     */
    modifier onlyOperator() {
        require(msg.sender == manager.operator(), "Must be operator");
        _;
    }

    /**
     * Throws if the sender is not the SetToken methodologist
     */
    modifier onlyMethodologist() {
        require(msg.sender == manager.methodologist(), "Must be methodologist");
        _;
    }

    /* ============ State Variables ============ */

    // Instance of manager contract
    IICManagerV2 public manager;


    /* ============ Internal Functions ============ */
    
    /**
     * Invoke call from manager
     *
     * @param _module           Module to interact with
     * @param _encoded          Encoded byte data
     */
    function invokeManager(address _module, bytes calldata _encoded) internal {
        manager.interactModule(_module, _encoded);
    }
}