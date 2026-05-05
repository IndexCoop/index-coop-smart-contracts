/*
    Copyright 2026 Index Cooperative

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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAToken } from "../interfaces/IAToken.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IPool } from "../interfaces/IPool.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";


/**
 * @title AaveV3DeleveredRedeemer
 * @author Index Cooperative
 *
 * Single-purpose helper for redeeming fully-delevered SetTokens whose components are
 * Aave V3 aTokens. The leveraged FlashMint contracts (FlashMintLeveragedAaveFL etc.)
 * assume a 2-component [collateralAToken, debtToken] shape and revert when the debt
 * has been removed; this contract handles the post-disengage case.
 *
 * Redeems via DebtIssuanceModuleV3, then for each component:
 *   - If the component reports an Aave underlying via IAToken.UNDERLYING_ASSET_ADDRESS(),
 *     calls IPool.withdraw(underlying, type(uint256).max, recipient) to burn the aToken
 *     for the underlying directly to the recipient.
 *   - Otherwise, transfers the component to the recipient as-is.
 *
 * The `try`/`catch` on UNDERLYING_ASSET_ADDRESS() makes the contract state-transparent
 * across a future operator cleanup that converts aToken positions to underlying positions
 * inside the SetToken — same bytecode handles both states with no SDK config change.
 *
 * Issuance is not supported. These products are deprecated.
 */
contract AaveV3DeleveredRedeemer is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ State Variables ============ */

    IPool public immutable pool;
    IDebtIssuanceModule public immutable issuanceModule;

    /* ============ Events ============ */

    event Redeemed(
        address indexed caller,
        address indexed recipient,
        ISetToken indexed setToken,
        uint256 setTokenAmount
    );

    /* ============ Constructor ============ */

    /**
     * @param _pool             Aave V3 Pool on the host chain (e.g. 0x794a61358D6845594F94dc1DB02A252b5b4814aD on Arbitrum).
     * @param _issuanceModule   DebtIssuanceModuleV3 the SetTokens are managed by.
     */
    constructor(IPool _pool, IDebtIssuanceModule _issuanceModule) public {
        require(address(_pool) != address(0), "AaveV3DeleveredRedeemer: ZERO POOL");
        require(address(_issuanceModule) != address(0), "AaveV3DeleveredRedeemer: ZERO MODULE");
        pool = _pool;
        issuanceModule = _issuanceModule;
    }

    /* ============ External Functions ============ */

    /**
     * Pulls `_amount` of `_setToken` from the caller, redeems via DebtIssuanceModuleV3,
     * then forwards each component to `_recipient` — unwrapping aTokens to underlying
     * via the Aave V3 Pool when possible.
     *
     * The caller must have approved this contract for at least `_amount` SetTokens.
     *
     * @param _setToken    SetToken to redeem.
     * @param _amount      Amount of SetToken to redeem.
     * @param _recipient   Receiver of the resulting tokens. Pass address(0) to default
     *                     to msg.sender (lets SDKs encode the calldata without knowing
     *                     the connected wallet address).
     * @return components       Components in the order they appear on the SetToken.
     * @return amountsToUser    Per-component amount delivered to `_recipient`. For
     *                          aTokens this is the amount of underlying received from
     *                          IPool.withdraw; for non-aTokens it is the raw transfer
     *                          amount.
     */
    function redeem(
        ISetToken _setToken,
        uint256 _amount,
        address _recipient
    )
        external
        nonReentrant
        returns (address[] memory components, uint256[] memory amountsToUser)
    {
        require(_amount > 0, "AaveV3DeleveredRedeemer: ZERO AMOUNT");

        address recipient = _recipient == address(0) ? msg.sender : _recipient;

        IERC20(address(_setToken)).safeTransferFrom(msg.sender, address(this), _amount);
        issuanceModule.redeem(_setToken, _amount, address(this));

        components = _setToken.getComponents();
        amountsToUser = new uint256[](components.length);

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 balance = IERC20(component).balanceOf(address(this));
            if (balance == 0) {
                continue;
            }

            address underlying = _tryGetUnderlying(component);
            if (underlying != address(0)) {
                // aToken — burn 1:1 for underlying directly to `recipient`. We pass
                // `type(uint256).max` so Aave withdraws the full aToken balance and
                // returns the actual underlying amount delivered.
                amountsToUser[i] = pool.withdraw(underlying, type(uint256).max, recipient);
            } else {
                IERC20(component).safeTransfer(recipient, balance);
                amountsToUser[i] = balance;
            }
        }

        emit Redeemed(msg.sender, recipient, _setToken, _amount);
    }

    /* ============ Internal Functions ============ */

    /**
     * Returns the Aave underlying for `_component` if it is an Aave V3 aToken, otherwise
     * address(0). Uses try/catch so non-aToken components (regular ERC20s) don't revert
     * the whole flow — making the contract state-transparent across a future operator
     * cleanup that swaps aToken positions for underlying positions inside the SetToken.
     */
    function _tryGetUnderlying(address _component) internal view returns (address) {
        try IAToken(_component).UNDERLYING_ASSET_ADDRESS() returns (address u) {
            return u;
        } catch {
            return address(0);
        }
    }
}
