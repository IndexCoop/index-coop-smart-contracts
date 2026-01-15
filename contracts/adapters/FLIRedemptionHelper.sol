/*
    Copyright 2026 Index Coop

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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title FLIRedemptionHelper
 * @author Index Coop
 * @notice Helper contract for redeeming FLI tokens (ETH2xFLI, BTC2xFLI) to receive
 *         the underlying 2X tokens (ETH2X, BTC2X).
 *
 * This contract provides a stable interface that works both before and after the
 * IntermediateToken migration:
 *
 * Before Migration (FLI holds ETH2X directly):
 *   - Redeem: User provides FLI -> contract redeems FLI -> User receives ETH2X
 *
 * After Migration (FLI holds IntermediateToken which holds ETH2X):
 *   - Redeem: User provides FLI -> contract redeems FLI -> receives IntermediateToken
 *             -> contract redeems IntermediateToken -> User receives ETH2X
 *
 * The contract automatically detects the migration state by checking FLI's components.
 */
contract FLIRedemptionHelper {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    /* ============ State Variables ============ */

    ISetToken public immutable fliToken;                              // ETH2xFLI or BTC2xFLI
    ISetToken public immutable nestedToken;                           // ETH2X or BTC2X
    ISetToken public immutable intermediateToken;                     // IntermediateToken (wraps nestedToken 1:1)
    IBasicIssuanceModule public immutable fliIssuanceModule;          // DebtIssuanceModuleV2 for FLI (no hooks)
    IBasicIssuanceModule public immutable intermediateIssuanceModule; // BasicIssuanceModule for IntermediateToken

    /* ============ Constructor ============ */

    /**
     * @notice Constructs the FLIRedemptionHelper
     * @param _fliToken              FLI token address (ETH2xFLI or BTC2xFLI)
     * @param _nestedToken           Nested 2X token address (ETH2X or BTC2X)
     * @param _intermediateToken     IntermediateToken address (wraps nestedToken 1:1)
     * @param _fliIssuanceModule     DebtIssuanceModuleV2 for FLI token (no hooks configured)
     * @param _intermediateIssuanceModule  Issuance module for IntermediateToken
     */
    constructor(
        ISetToken _fliToken,
        ISetToken _nestedToken,
        ISetToken _intermediateToken,
        IBasicIssuanceModule _fliIssuanceModule,
        IBasicIssuanceModule _intermediateIssuanceModule
    ) public {
        fliToken = _fliToken;
        nestedToken = _nestedToken;
        intermediateToken = _intermediateToken;
        fliIssuanceModule = _fliIssuanceModule;
        intermediateIssuanceModule = _intermediateIssuanceModule;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Redeem FLI tokens to receive the underlying 2X token (ETH2X or BTC2X)
     * @dev Caller must approve this contract to spend fliToken before calling
     * @param _fliAmount  Amount of FLI tokens to redeem
     * @param _to         Address to receive the 2X tokens
     */
    function redeem(uint256 _fliAmount, address _to) external {
        // Transfer FLI from caller
        IERC20(address(fliToken)).safeTransferFrom(msg.sender, address(this), _fliAmount);

        if (_isMigrated()) {
            // After migration: redeem FLI -> IntermediateToken -> nestedToken
            fliIssuanceModule.redeem(fliToken, _fliAmount, address(this));

            uint256 intermediateBalance = intermediateToken.balanceOf(address(this));
            intermediateIssuanceModule.redeem(intermediateToken, intermediateBalance, _to);
        } else {
            // Before migration: redeem FLI directly to nestedToken
            fliIssuanceModule.redeem(fliToken, _fliAmount, _to);
        }
    }

    /* ============ External View Functions ============ */

    /**
     * @notice Get the amount of nestedToken received when redeeming FLI
     * @param _fliAmount  Amount of FLI tokens to redeem
     * @return uint256    Amount of nestedToken received
     */
    function getNestedTokenReceivedOnRedemption(uint256 _fliAmount) external view returns (uint256) {
        if (_isMigrated()) {
            // FLI holds IntermediateToken, IntermediateToken holds nestedToken 1:1
            int256 intermediateUnit = fliToken.getDefaultPositionRealUnit(address(intermediateToken));
            require(intermediateUnit > 0, "FLIRedemptionHelper: Invalid intermediate unit");
            return _fliAmount.preciseMul(uint256(intermediateUnit));
        } else {
            // FLI holds nestedToken directly
            int256 nestedUnit = fliToken.getDefaultPositionRealUnit(address(nestedToken));
            require(nestedUnit > 0, "FLIRedemptionHelper: Invalid nested unit");
            return _fliAmount.preciseMul(uint256(nestedUnit));
        }
    }

    /**
     * @notice Check if FLI has migrated to IntermediateToken
     * @return bool  True if FLI holds IntermediateToken, false if it holds nestedToken directly
     */
    function isMigrated() external view returns (bool) {
        return _isMigrated();
    }

    /* ============ Internal Functions ============ */

    /**
     * @notice Check if FLI has migrated to IntermediateToken by checking its components
     */
    function _isMigrated() internal view returns (bool) {
        address[] memory components = fliToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            if (components[i] == address(intermediateToken)) {
                return true;
            }
        }
        return false;
    }
}
