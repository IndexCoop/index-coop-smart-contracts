/*
    Copyright 2023 IndexCoop.

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
pragma experimental ABIEncoderV2;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IRateProvider } from "../interfaces/external/IRateProvider.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title SetTokenRateReviewer
 * @author FlattestWhite
 *
 * A RateProvider contract that provides the amount of component per set token through the getRate function.
 * Used by balancer in their liquidity pools.
 * https://github.com/balancer-labs/metastable-rate-providers/blob/master/contracts/WstETHRateProvider.sol
 */
contract SetTokenRateViewer is IRateProvider {

    using Address for address;
    using SafeMath for uint256;
    using SafeCast for int256;

    ISetToken public immutable setToken;
    IERC20 public immutable component;

    constructor(ISetToken _setToken, IERC20 _component) public {
        setToken = _setToken;
        component = _component;
    }

    /* =========== External Functions ============ */

    /**
     * @return the amount of component per set token.
     */
    function getRate() external view override returns (uint256) {
        return setToken.getTotalComponentRealUnits(address(component)).toUint256();
    }
}
