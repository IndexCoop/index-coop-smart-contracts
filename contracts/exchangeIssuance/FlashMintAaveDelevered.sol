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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAToken } from "../interfaces/IAToken.sol";
import { IController } from "../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IPool } from "../interfaces/IPool.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { DEXAdapterV3 } from "./DEXAdapterV3.sol";


/**
 * @title FlashMintAaveDelevered
 * @author Index Cooperative
 *
 * Single-purpose FlashMint variant for redeeming fully-delevered SetTokens whose
 * components are Aave V3 aTokens. The leveraged FlashMint contracts assume a
 * 2-component [collateralAToken, debtToken] shape and revert when the debt has
 * been removed; FlashMintDexV5's per-component DEX swap loop can't help either
 * because aTokens have no DEX liquidity. This contract handles the gap.
 *
 * Per-component flow inside redeemExactSetForETH / redeemExactSetForERC20:
 *   1. SetToken pulled from msg.sender, redeemed via DebtIssuanceModuleV3 — the
 *      contract receives each component.
 *   2. For each component: if it exposes IAToken.UNDERLYING_ASSET_ADDRESS(),
 *      Aave V3 Pool.withdraw burns the contract's aToken balance for underlying.
 *      Otherwise the component is treated as the underlying directly.
 *   3. The resulting underlying is swapped to the requested output via
 *      DEXAdapterV3 using the per-component swap data the caller supplied.
 *      Empty SwapData (path=[]) short-circuits the swap — use this when a
 *      component (or its underlying) is already the output token.
 *
 * The try/catch on UNDERLYING_ASSET_ADDRESS() makes the contract state-
 * transparent across a future operator cleanup that converts aToken positions
 * to underlying positions inside the SetToken — same bytecode handles both
 * states with no SDK config change.
 *
 * Issuance is intentionally not supported. These products are deprecated; users
 * only need an exit ramp.
 *
 * Interface alignment: external function names, parameter names, event shape
 * and ETH sentinel mirror FlashMintLeveraged / FlashMintLeveragedAaveFL so SDK
 * adapters and downstream tooling can reuse the same patterns.
 */
contract FlashMintAaveDelevered is ReentrancyGuard {
    using Address for address payable;
    using SafeERC20 for IERC20;
    using DEXAdapterV3 for DEXAdapterV3.Addresses;

    /* ============ Constants ============ */

    address public constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    IController public immutable setController;
    IPool public immutable aaveV3Pool;
    IDebtIssuanceModule public immutable debtIssuanceModule;
    DEXAdapterV3.Addresses public addresses;

    /* ============ Events ============ */

    event FlashRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens (always msg.sender)
        ISetToken indexed _setToken,    // The redeemed SetToken
        address indexed _outputToken,   // The output asset (ETH_ADDRESS for native ETH)
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed
        uint256 _amountOutputToken      // The amount of output tokens delivered to the recipient
    );

    /* ============ Modifiers ============ */

    /**
     * Reverts if the address is not a Set on the configured controller. Aligned
     * with FlashMintDexV5 / FlashMintLeveraged validation.
     */
    modifier validSetToken(ISetToken _setToken) {
        require(setController.isSet(address(_setToken)), "FlashMintAaveDelevered: INVALID SET");
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @param _setController        SetToken controller, used to verify the SetToken arg.
     * @param _aaveV3Pool           Aave V3 Pool on the host chain (e.g. 0x794a61358D6845594F94dc1DB02A252b5b4814aD on Arbitrum).
     * @param _debtIssuanceModule   DebtIssuanceModuleV3 the SetTokens are managed by.
     * @param _addresses            DEX router / quoter / WETH addresses for the host chain.
     */
    constructor(
        IController _setController,
        IPool _aaveV3Pool,
        IDebtIssuanceModule _debtIssuanceModule,
        DEXAdapterV3.Addresses memory _addresses
    )
        public
    {
        require(address(_setController) != address(0), "FlashMintAaveDelevered: ZERO CONTROLLER");
        require(address(_aaveV3Pool) != address(0), "FlashMintAaveDelevered: ZERO POOL");
        require(address(_debtIssuanceModule) != address(0), "FlashMintAaveDelevered: ZERO MODULE");
        require(_addresses.weth != address(0), "FlashMintAaveDelevered: ZERO WETH");
        setController = _setController;
        aaveV3Pool = _aaveV3Pool;
        debtIssuanceModule = _debtIssuanceModule;
        addresses = _addresses;
    }

    /* ============ Receive ============ */

    // Accepts ETH from WETH.withdraw during redeemExactSetForETH.
    receive() external payable {}

    /* ============ External Functions ============ */

    /**
     * Trigger redemption of `_setToken` to pay msg.sender with native ETH.
     * Per-component swap data must therefore route into WETH (or be a no-op
     * SwapData when the component is already WETH).
     *
     * @param _setToken                 SetToken to redeem.
     * @param _setAmount                Amount of SetToken to redeem.
     * @param _minAmountOutputToken     Minimum acceptable total ETH delivered.
     * @param _componentSwapData        One swap data per SetToken component, in
     *                                  component order. The swap is FROM the
     *                                  component's underlying (or the component
     *                                  itself if not an aToken) TO WETH. Use a
     *                                  no-op (path=[]) when the component is
     *                                  already WETH.
     * @return                          The amount of ETH delivered to msg.sender.
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _setAmount,
        uint256 _minAmountOutputToken,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        external
        nonReentrant
        validSetToken(_setToken)
        returns (uint256)
    {
        uint256 wethAmount = _redeemAndSwap(_setToken, _setAmount, addresses.weth, _componentSwapData);
        require(wethAmount >= _minAmountOutputToken, "FlashMintAaveDelevered: INSUFFICIENT OUTPUT");

        IWETH(addresses.weth).withdraw(wethAmount);
        payable(msg.sender).sendValue(wethAmount);
        emit FlashRedeem(msg.sender, _setToken, ETH_ADDRESS, _setAmount, wethAmount);
        return wethAmount;
    }

    /**
     * Trigger redemption of `_setToken` to pay msg.sender with an arbitrary ERC20.
     * Per-component swap data routes each component (or its underlying after
     * aToken unwrap) to `_outputToken`. Components already equal to
     * `_outputToken` should pass an empty SwapData — DEXAdapterV3 short-circuits.
     *
     * @param _setToken                 SetToken to redeem.
     * @param _setAmount                Amount of SetToken to redeem.
     * @param _outputToken              ERC20 to deliver to msg.sender.
     * @param _minAmountOutputToken     Minimum acceptable total `_outputToken` delivered.
     * @param _componentSwapData        One swap data per SetToken component, in
     *                                  component order.
     * @return                          The amount of `_outputToken` delivered to msg.sender.
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        external
        nonReentrant
        validSetToken(_setToken)
        returns (uint256)
    {
        require(_outputToken != address(0), "FlashMintAaveDelevered: ZERO OUTPUT");
        uint256 outputAmount = _redeemAndSwap(_setToken, _setAmount, _outputToken, _componentSwapData);
        require(outputAmount >= _minAmountOutputToken, "FlashMintAaveDelevered: INSUFFICIENT OUTPUT");

        IERC20(_outputToken).safeTransfer(msg.sender, outputAmount);
        emit FlashRedeem(msg.sender, _setToken, _outputToken, _setAmount, outputAmount);
        return outputAmount;
    }

    /**
     * View-style estimator for the SDK's `_minAmountOutputToken` sizing. Calls
     * the DEX quoters (which are non-view but state-revert safe under eth_call).
     *
     * Aave V3 aTokens redeem 1:1 with their underlying so the per-aToken
     * contribution is just the per-share unit times the amount; non-aToken
     * components run through DEXAdapterV3.getAmountOut.
     *
     * `_outputToken` may be ETH_ADDRESS to estimate the WETH-equivalent that
     * `redeemExactSetForETH` would unwrap and forward.
     */
    function getRedeemExactSet(
        ISetToken _setToken,
        uint256 _setAmount,
        address _outputToken,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        external
        validSetToken(_setToken)
        returns (uint256 outputAmount)
    {
        address effectiveOutput = _outputToken == ETH_ADDRESS ? addresses.weth : _outputToken;

        (address[] memory components, uint256[] memory componentUnits, ) =
            debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, _setAmount);
        require(_componentSwapData.length == components.length, "FlashMintAaveDelevered: BAD SWAPDATA LENGTH");

        for (uint256 i = 0; i < components.length; i++) {
            uint256 componentAmount = componentUnits[i];
            if (componentAmount == 0) continue;

            address tokenAfterUnwrap = _tryGetUnderlying(components[i]);
            if (tokenAfterUnwrap == address(0)) tokenAfterUnwrap = components[i];

            if (tokenAfterUnwrap == effectiveOutput) {
                outputAmount = outputAmount + componentAmount;
            } else {
                outputAmount = outputAmount + addresses.getAmountOut(_componentSwapData[i], componentAmount);
            }
        }
    }

    /* ============ Internal Functions ============ */

    /**
     * Pulls SetToken from msg.sender, redeems via DebtIssuanceModuleV3, unwraps
     * any aToken components via Aave V3 Pool.withdraw, then swaps each resulting
     * underlying into `_outputToken` (skipping the swap if the underlying
     * already equals the output). Returns the contract's `_outputToken` balance
     * delta (= total output assembled).
     */
    function _redeemAndSwap(
        ISetToken _setToken,
        uint256 _setAmount,
        address _outputToken,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        internal
        returns (uint256 outputAmount)
    {
        require(_setAmount > 0, "FlashMintAaveDelevered: ZERO AMOUNT");
        address[] memory components = _setToken.getComponents();
        require(_componentSwapData.length == components.length, "FlashMintAaveDelevered: BAD SWAPDATA LENGTH");

        IERC20(address(_setToken)).safeTransferFrom(msg.sender, address(this), _setAmount);

        uint256 outputBefore = IERC20(_outputToken).balanceOf(address(this));
        debtIssuanceModule.redeem(_setToken, _setAmount, address(this));

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 componentBalance = IERC20(component).balanceOf(address(this));
            if (componentBalance == 0) continue;

            // Resolve to the token we'll actually be swapping (or accumulating).
            address tokenAfterUnwrap = _tryGetUnderlying(component);
            uint256 tokenBalance;
            if (tokenAfterUnwrap != address(0)) {
                // aToken: burn for underlying held by this contract.
                tokenBalance = aaveV3Pool.withdraw(tokenAfterUnwrap, type(uint256).max, address(this));
            } else {
                tokenAfterUnwrap = component;
                tokenBalance = componentBalance;
            }

            if (tokenAfterUnwrap == _outputToken) {
                // No swap needed — already accumulated against the `outputBefore` baseline.
                continue;
            }

            // Swap the entire balance into `_outputToken`. DEXAdapterV3 short-circuits if
            // path is empty (caller can opt-in to skip a per-component swap), and uses
            // safeIncreaseAllowance internally so we don't pre-approve here.
            addresses.swapExactTokensForTokens(
                tokenBalance,
                0,
                _componentSwapData[i]
            );
        }

        outputAmount = IERC20(_outputToken).balanceOf(address(this)) - outputBefore;
    }

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
