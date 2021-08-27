/*
    Copyright 2021 Index Cooperative.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

pragma solidity 0.6.10;

import { IAirdropModule } from "../interfaces/IAirdropModule.sol";
import { IManagerIssuanceHook } from "../interfaces/IManagerIssuanceHook.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title AirdropIssuanceHook
 * @author Index Coop
 *
 * Issuance hooks that absorbs all airdropped tokens. Useful for ensuring that rebasing tokens are fully accounted for before issuance. Only works
 * with tokens that strictly positively rebase such as aTokens.
 */
contract AirdropIssuanceHook is IManagerIssuanceHook {

    /* ============ State Variables ============ */

    // Address of Set Protocol AirdropModule
    IAirdropModule public airdropModule;

    /* ============== Constructor ================ */

    /**
     * Sets state variables.
     *
     * @param   _airdropModule      address of AirdropModule
     */
    constructor(IAirdropModule _airdropModule) public {
        airdropModule = _airdropModule;
    }

    /* =========== External Functions =========== */

    /**
     * Absorbs all airdropped tokens. Called by some issuance modules before issuance.
     *
     * @param   _setToken           address of SetToken to absorb airdrops for
     */
    function invokePreIssueHook(ISetToken _setToken, uint256 /* _issueQuantity */, address /* _sender */, address /* _to */) external override {
        _sync(_setToken);
    }

    /**
     * Absorbs all airdropped tokens. Called by some issuance modules before redemption.
     *
     * @param   _setToken           address of SetToken to absorb airdrops for
     */
    function invokePreRedeemHook(ISetToken _setToken, uint256 /* _issueQuantity */, address /* _sender */, address /* _to */) external override {
        _sync(_setToken);
    }

    /* =========== Internal Functions ========== */

    /**
     * Absorbs all airdropped tokens. AirdropModule must be added to an initialized for the SetToken. Must have anyoneAbsorb set to true on
     * the AirdropModule.
     *
     * @param   _setToken           address of SetToken to absorb airdrops for
     */
    function _sync(ISetToken _setToken) internal {
        address[] memory airdrops = airdropModule.getAirdrops(_setToken);
        airdropModule.batchAbsorb(_setToken, airdrops);
    }
}