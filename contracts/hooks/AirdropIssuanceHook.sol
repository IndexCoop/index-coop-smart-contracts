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

contract AirdropIssuanceHook is IManagerIssuanceHook {

    IAirdropModule public airdropModule;

    constructor(IAirdropModule _airdropModule) public {
        airdropModule = _airdropModule;
    }

    function invokePreIssueHook(ISetToken _setToken, uint256 /* _issueQuantity */, address /* _sender */, address /* _to */) external override {
        _sync(_setToken);
    }

    function invokePreRedeemHook(ISetToken _setToken, uint256 /* _issueQuantity */, address /* _sender */, address /* _to */) external override {
        _sync(_setToken);
    }

    function _sync(ISetToken _setToken) internal {
        address[] memory airdrops = airdropModule.getAirdrops(_setToken);
        airdropModule.batchAbsorb(_setToken, airdrops);
    }
}