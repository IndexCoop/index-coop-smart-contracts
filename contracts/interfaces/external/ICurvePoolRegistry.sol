/*
    Copyright 2022 Index Cooperative

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

// Implementation: https://etherscan.io/address/0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5#readContract
interface ICurvePoolRegistry {
    // amplification factor
    function get_A(address _pool) external view returns(uint256);
    function get_balances(address _pool) external view returns(uint256[8] memory);
    function get_coins(address _pool) external view returns(address[8] memory);
    function get_coin_indices(address _pool, address _from, address _to) external view returns(int128, int128, bool);
    function get_decimals(address _pool) external view returns(uint256[8] memory);
    function get_n_coins(address _pool) external view returns(uint256[2] memory);
    function get_fees(address _pool) external view returns(uint256[2] memory);
    function get_rates(address _pool) external view returns(uint256[8] memory);
}
