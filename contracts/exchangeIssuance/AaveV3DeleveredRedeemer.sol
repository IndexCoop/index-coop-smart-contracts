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
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IPool } from "../interfaces/IPool.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { DEXAdapterV3 } from "./DEXAdapterV3.sol";


/**
 * @title AaveV3DeleveredRedeemer
 * @author Index Cooperative
 *
 * Single-purpose helper for redeeming fully-delevered SetTokens whose components are
 * Aave V3 aTokens. The leveraged FlashMint contracts (FlashMintLeveragedAaveFL etc.)
 * assume a 2-component [collateralAToken, debtToken] shape and revert when the debt
 * has been removed; this contract handles the post-disengage case.
 *
 * Three exit modes:
 *   - `redeem(...)`:           delivers each component (or its underlying for aTokens)
 *                              as-is. No DEX involvement. Cheapest, but the recipient
 *                              gets the headline underlying (e.g. AAVE / LINK + dust USDT).
 *   - `redeemForToken(...)`:   per-component DEX swap into a single ERC20 output.
 *                              For each component the contract first unwraps any aToken
 *                              via Aave V3 Pool.withdraw, then swaps the resulting
 *                              underlying into `_outputToken` using DEXAdapterV3.
 *   - `redeemForETH(...)`:     same as `redeemForToken` with WETH as the intermediate
 *                              output, then unwraps to native ETH.
 *
 * Per-component aToken detection uses `try IAToken.UNDERLYING_ASSET_ADDRESS() catch`
 * so the contract is state-transparent across a future operator cleanup that converts
 * aToken positions to underlying positions inside the SetToken — same bytecode handles
 * both states with no SDK config change. Pass `noopSwap` (path=[]) for any component
 * already equal to the requested output token; DEXAdapterV3 short-circuits.
 *
 * Issuance is not supported. These products are deprecated.
 */
contract AaveV3DeleveredRedeemer is ReentrancyGuard {
    using Address for address payable;
    using SafeERC20 for IERC20;
    using DEXAdapterV3 for DEXAdapterV3.Addresses;

    /* ============ State Variables ============ */

    IPool public immutable pool;
    IDebtIssuanceModule public immutable issuanceModule;
    DEXAdapterV3.Addresses public addresses;

    /* ============ Events ============ */

    event Redeemed(
        address indexed caller,
        address indexed recipient,
        ISetToken indexed setToken,
        address outputToken,    // address(0) for the per-component as-is exit
        uint256 setTokenAmount,
        uint256 outputAmount    // 0 for the per-component as-is exit
    );

    /* ============ Constructor ============ */

    /**
     * @param _pool             Aave V3 Pool on the host chain (e.g. 0x794a61358D6845594F94dc1DB02A252b5b4814aD on Arbitrum).
     * @param _issuanceModule   DebtIssuanceModuleV3 the SetTokens are managed by.
     * @param _addresses        DEX router / quoter / WETH addresses for the host chain.
     *                          Required for `redeemForToken` and `redeemForETH`. The
     *                          per-component as-is `redeem` does not touch the DEX.
     */
    constructor(
        IPool _pool,
        IDebtIssuanceModule _issuanceModule,
        DEXAdapterV3.Addresses memory _addresses
    )
        public
    {
        require(address(_pool) != address(0), "AaveV3DeleveredRedeemer: ZERO POOL");
        require(address(_issuanceModule) != address(0), "AaveV3DeleveredRedeemer: ZERO MODULE");
        require(_addresses.weth != address(0), "AaveV3DeleveredRedeemer: ZERO WETH");
        pool = _pool;
        issuanceModule = _issuanceModule;
        addresses = _addresses;
    }

    /* ============ Receive ============ */

    // Accept ETH from WETH.withdraw() during redeemForETH.
    receive() external payable {}

    /* ============ External Functions ============ */

    /**
     * Pulls `_amount` of `_setToken` from the caller, redeems via DebtIssuanceModuleV3,
     * then forwards each component to `_recipient` — unwrapping aTokens to underlying
     * via the Aave V3 Pool when possible.
     *
     * No DEX involvement. Cheapest exit; recipient receives the SetToken's headline
     * underlying(s), not a chosen output token. Use `redeemForToken` / `redeemForETH`
     * if you need a single chosen output.
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

        emit Redeemed(msg.sender, recipient, _setToken, address(0), _amount, 0);
    }

    /**
     * Redeem `_amount` of `_setToken` and deliver the proceeds as `_outputToken`.
     * For each component the contract first unwraps any aToken via Aave V3 Pool.withdraw
     * (so we hold the underlying), then swaps that underlying into `_outputToken` using
     * the DEX route described by `_componentSwapData[i]`. If a component (or its
     * underlying) is already equal to `_outputToken`, pass a no-op SwapData with `path=[]`
     * — DEXAdapterV3 short-circuits and the balance contributes to the total directly.
     *
     * Reverts if the total `_outputToken` delivered is below `_minOutputAmount`.
     *
     * @param _setToken            SetToken to redeem.
     * @param _amount              Amount of SetToken to redeem.
     * @param _outputToken         ERC20 to deliver to the recipient.
     * @param _minOutputAmount     Minimum acceptable total `_outputToken` delivered.
     * @param _recipient           Receiver. Pass address(0) to default to msg.sender.
     * @param _componentSwapData   One swap data per SetToken component, in component
     *                             order. The swap is FROM the component's underlying
     *                             (or the component itself if not an aToken) TO
     *                             `_outputToken`. Use a no-op (path=[]) when the
     *                             component is already `_outputToken`.
     * @return outputAmount        Total amount of `_outputToken` delivered to recipient.
     */
    function redeemForToken(
        ISetToken _setToken,
        uint256 _amount,
        IERC20 _outputToken,
        uint256 _minOutputAmount,
        address _recipient,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        external
        nonReentrant
        returns (uint256 outputAmount)
    {
        require(address(_outputToken) != address(0), "AaveV3DeleveredRedeemer: ZERO OUTPUT");
        outputAmount = _redeemAndSwap(
            _setToken,
            _amount,
            address(_outputToken),
            _componentSwapData
        );
        require(outputAmount >= _minOutputAmount, "AaveV3DeleveredRedeemer: INSUFFICIENT OUTPUT");

        address recipient = _recipient == address(0) ? msg.sender : _recipient;
        _outputToken.safeTransfer(recipient, outputAmount);
        emit Redeemed(msg.sender, recipient, _setToken, address(_outputToken), _amount, outputAmount);
    }

    /**
     * Same as `redeemForToken` with WETH as the swap target, plus a final WETH.withdraw
     * to deliver native ETH to the recipient. Per-component swap data must therefore
     * route into WETH (or be a no-op when the component is already WETH).
     */
    function redeemForETH(
        ISetToken _setToken,
        uint256 _amount,
        uint256 _minEthAmount,
        address payable _recipient,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        external
        nonReentrant
        returns (uint256 ethAmount)
    {
        ethAmount = _redeemAndSwap(_setToken, _amount, addresses.weth, _componentSwapData);
        require(ethAmount >= _minEthAmount, "AaveV3DeleveredRedeemer: INSUFFICIENT OUTPUT");

        IWETH(addresses.weth).withdraw(ethAmount);
        address payable recipient = _recipient == address(0) ? msg.sender : _recipient;
        recipient.sendValue(ethAmount);
        emit Redeemed(msg.sender, recipient, _setToken, addresses.weth, _amount, ethAmount);
    }

    /**
     * View-style estimator (calls the DEX quoters, which are non-view but state-revert
     * safe under eth_call). Returns the predicted total `_outputToken` a redemption of
     * `_amount` SetTokens would deliver, given the supplied per-component swap data.
     *
     * Aave V3 aTokens redeem 1:1 with their underlying so the per-aToken contribution is
     * just the per-share unit times the amount; for non-aToken components the predicted
     * output is the per-share unit run through DEXAdapterV3.getAmountOut.
     */
    function getRedeemQuote(
        ISetToken _setToken,
        uint256 _amount,
        address _outputToken,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        external
        returns (uint256 outputAmount)
    {
        (address[] memory components, uint256[] memory componentUnits, ) =
            issuanceModule.getRequiredComponentRedemptionUnits(_setToken, _amount);
        require(_componentSwapData.length == components.length, "AaveV3DeleveredRedeemer: BAD SWAPDATA LENGTH");

        for (uint256 i = 0; i < components.length; i++) {
            uint256 componentAmount = componentUnits[i];
            if (componentAmount == 0) continue;

            address tokenAfterUnwrap = _tryGetUnderlying(components[i]);
            if (tokenAfterUnwrap == address(0)) tokenAfterUnwrap = components[i];

            if (tokenAfterUnwrap == _outputToken) {
                outputAmount = outputAmount + componentAmount;
            } else {
                outputAmount = outputAmount + addresses.getAmountOut(_componentSwapData[i], componentAmount);
            }
        }
    }

    /* ============ Internal Functions ============ */

    /**
     * Pulls SetToken from caller, redeems via DebtIssuanceModuleV3, unwraps any aToken
     * components via Aave V3 Pool.withdraw, then swaps each resulting underlying into
     * `_outputToken` (skipping the swap if the underlying already equals the output).
     * Returns the contract's `_outputToken` balance delta (= total output assembled).
     */
    function _redeemAndSwap(
        ISetToken _setToken,
        uint256 _amount,
        address _outputToken,
        DEXAdapterV3.SwapData[] memory _componentSwapData
    )
        internal
        returns (uint256 outputAmount)
    {
        require(_amount > 0, "AaveV3DeleveredRedeemer: ZERO AMOUNT");
        address[] memory components = _setToken.getComponents();
        require(_componentSwapData.length == components.length, "AaveV3DeleveredRedeemer: BAD SWAPDATA LENGTH");

        IERC20(address(_setToken)).safeTransferFrom(msg.sender, address(this), _amount);

        uint256 outputBefore = IERC20(_outputToken).balanceOf(address(this));
        issuanceModule.redeem(_setToken, _amount, address(this));

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            uint256 componentBalance = IERC20(component).balanceOf(address(this));
            if (componentBalance == 0) continue;

            // Resolve to the token we'll actually be swapping (or accumulating).
            address tokenAfterUnwrap = _tryGetUnderlying(component);
            uint256 tokenBalance;
            if (tokenAfterUnwrap != address(0)) {
                // aToken: burn for underlying held by this contract.
                tokenBalance = pool.withdraw(tokenAfterUnwrap, type(uint256).max, address(this));
            } else {
                tokenAfterUnwrap = component;
                tokenBalance = componentBalance;
            }

            if (tokenAfterUnwrap == _outputToken) {
                // No swap needed — already accumulated in `outputBefore` baseline diff.
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
