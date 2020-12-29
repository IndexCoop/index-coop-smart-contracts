pragma solidity ^0.6.10;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { MutualUpgrade } from "../lib/MutualUpgrade.sol";

contract ICManagerV2 is MutualUpgrade {
    using Address for address;
    using AddressArrayUtils for address[];

    /* ============ Modifiers ============ */

    /**
     * Throws if the sender is not the SetToken operator
     */
    modifier onlyOperator() {
        require(msg.sender == operator, "Must be operator");
        _;
    }

    /**
     * Throws if the sender is not the SetToken methodologist
     */
    modifier onlyMethodologist() {
        require(msg.sender == methodologist, "Must be methodologist");
        _;
    }

    /**
     * Throws if the sender is not a listed adapter
     */
    modifier onlyAdapter() {
        require(isAdapter[msg.sender], "Must be adapter");
        _;
    }

    /* ============ State Variables ============ */

    // Instance of SetToken
    ISetToken public setToken;

    // Array of listed adapters
    address[] adapters;

    // Mapping to check if adapter
    mapping(address => bool) public isAdapter;

    // Address of operator
    address public operator;

    // Address of methodologist
    address public methodologist;

    /* ============ Constructor ============ */

    constructor(
        ISetToken _setToken,
        address _operator,
        address _methodologist
    )
        public
    {
        setToken = _setToken;
        operator = _operator;
        methodologist = _methodologist;
    }

    /* ============ External Functions ============ */

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Update the SetToken manager address. Operator and Methodologist must each call
     * this function to execute the update.
     *
     * @param _newManager           New manager address
     */
    function setManager(address _newManager) external mutualUpgrade(operator, methodologist) {
        setToken.setManager(_newManager);
    }

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Add a new adapter that the ICManagerV2 can call.
     *
     * @param _adapter           New adapter to add
     */
    function addAdapter(address _adapter) external mutualUpgrade(operator, methodologist) {
        require(!isAdapter[_adapter], "Adapter already exists");

        adapters.push(_adapter);

        isAdapter[_adapter] = true;
    }

    /**
     * OPERATOR OR METHODOLOGIST ONLY: Remove an existing adapter tracked by the ICManagerV2.
     *
     * @param _adapter           New adapter to add
     */
    function removeAdapter(address _adapter) external mutualUpgrade(operator, methodologist) {
        require(isAdapter[_adapter], "Adapter does not exist");

        adapters = adapters.remove(_adapter);

        isAdapter[_adapter] = false;
    }

    /**
     * ADAPTER ONLY: Interact with a module registered on the SetToken.
     *
     * @param _module           Module to interact with
     * @param _data             Byte data of function to call in module
     */
    function interactModule(address _module, bytes calldata _data) external onlyAdapter {
        // Invoke call to module, assume value will always be 0
        _module.functionCallWithValue(_data, 0);
    }

    /**
     * OPERATOR ONLY: Add a new module to the SetToken.
     *
     * @param _module           New module to add
     */
    function addModule(address _module) external onlyOperator {
        setToken.addModule(_module);
    }

    /**
     * OPERATOR ONLY: Remove a new module from the SetToken.
     *
     * @param _module           Module to remove
     */
    function removeModule(address _module) external onlyOperator {
        setToken.removeModule(_module);
    }

    /**
     * METHODOLOGIST ONLY: Update the methodologist address
     *
     * @param _newMethodologist           New methodologist address
     */
    function setMethodologist(address _newMethodologist) external onlyMethodologist {
        methodologist = _newMethodologist;
    }

    /**
     * OPERATOR ONLY: Update the operator address
     *
     * @param _newOperator           New operator address
     */
    function setOperator(address _newOperator) external onlyOperator {
        operator = _newOperator;
    }

    function getAdapters() external view returns(address[] memory) {
        return adapters;
    }
}