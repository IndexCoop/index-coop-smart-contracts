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

pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

/**
 * @title CompoundV3WrapV2Adapter
 * @author Index Cooperative
 *
 * Wrap adapter for Compound V3 that returns data for wraps/unwraps of tokens
 */
contract CompoundV3WrapV2Adapter {

    /* ========== State Variables ========= */

    // Address of the Compound V3 comet contract
    address public comet;

    /* ============ Constructor ============ */

    constructor(address _comet) public {
        comet = _comet;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to wrap an underlying asset into a wrappedToken.
     *
     * @param _underlyingToken      Address of the component to be wrapped
     * @param _underlyingUnits      Total quantity of underlying units to wrap
     *
     * @return address              Target contract address
     * @return bytes                Wrap calldata
     */
    function getWrapCallData(
        address _underlyingToken,
        address /* _wrappedToken  */,
        uint256 _underlyingUnits,
        address /* _to */,
        bytes memory /* _wrapData */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "supply(address,uint256)",
            _underlyingToken,
            _underlyingUnits
        );

        return (comet, 0, callData);
    }

    /**
     * Generates the calldata to unwrap a wrapped asset into its underlying.
     * 
     * @param _underlyingToken      Address of the component to be unwrapped to
     * @param _wrappedTokenUnits    Total quantity of units to unwrap
     *
     * @return address              Target contract address
     * @return bytes                Unwrap calldata
     */
    function getUnwrapCallData(
        address _underlyingToken,
        address /* _wrappedToken */,
        uint256 _wrappedTokenUnits,
        address /* _to */,
        bytes memory /* _unwrapData */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "withdraw(address,uint256)",
            _underlyingToken,
            _wrappedTokenUnits
        );

        return (comet, 0, callData);
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     */
     function getSpenderAddress(address /* _underlyingToken */, address /*  _wrappedToken */) external view returns(address) {
         return comet;
     }
}
