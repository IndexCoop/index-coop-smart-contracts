/*
    Copyright 2023 Index Cooperative

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
pragma experimental "ABIEncoderV2";

import { IMorpho } from "../interfaces/external/IMorpho.sol";

/**
 * @title MorphoAaveWrapV2Adapter
 * @author pblivin0x
 *
 * Wrap adapter for Morpho Aave that returns data for wraps/unwraps of tokens
 */
contract MorphoAaveWrapV2Adapter {

    /* ========== State Variables ========= */

    // Address of the Morpho contract
    IMorpho public morpho;

    /* ============ Constructor ============ */

    constructor(IMorpho _morpho) public {
        morpho = _morpho;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to wrap an aToken into an maToken.
     *
     * @param _underlyingToken      Address of the aToken to be wrapped
     * @param _underlyingUnits      Total quantity of underlying units to wrap
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of underlying units (if underlying is ETH). This will always be 0 for aTokens.
     * @return bytes                Wrap calldata
     */
    function getWrapCallData(
        address _underlyingToken,
        address /* _wrappedToken */,
        uint256 _underlyingUnits,
        address /* _to */,
        bytes memory /* _wrapData */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "supply(address, uint256)",
            _underlyingToken,
            _underlyingUnits
        );

        return (address(morpho), 0, callData);
    }

    /**
     * Generates the calldata to unwrap an maToken into its underlying aToken.
     *
     * @param _wrappedToken         Address of the maToken to be unwrapped
     * @param _wrappedTokenUnits    Total quantity of wrapped token units to unwrap
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of wrapped token units to unwrap. This will always be 0 for unwrapping
     * @return bytes                Unwrap calldata
     */
    function getUnwrapCallData(
        address /* _underlyingToken */,
        address _wrappedToken,
        uint256 _wrappedTokenUnits,
        address /* _to */,
        bytes memory /* _wrapData */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "withdraw(address, uint256)",
            _wrappedToken,
            _wrappedTokenUnits
        );

        return (address(morpho), 0, callData);
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address  /* _wrappedToken */) external view returns(address) {
        return address(morpho);
    }
}
