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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAToken } from "../interfaces/IAToken.sol";
import { IAaveLeverageModule } from "../interfaces/IAaveLeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { UniSushiV2Library } from "../../external/contracts/UniSushiV2Library.sol";
import { FlashLoanReceiverBaseV2 } from "../../external/contracts/aaveV2/FlashLoanReceiverBaseV2.sol";
import { DEXAdapter } from "./DEXAdapter.sol";


/**
 * @title ExchangeIssuanceIcEth
 * @author Index Coop
 *
 * Contract for redeeming deleveraged icETH
 */
contract ExchangeIssuanceIcEth is ReentrancyGuard, FlashLoanReceiverBaseV2{

    using DEXAdapter for DEXAdapter.Addresses;
    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Structs ============ */

    struct LeveragedTokenData {
        address collateralAToken;
        address collateralToken;
        uint256 collateralAmount;
        address debtToken;
        uint256 debtAmount;
    }

    struct DecodedParams {
        ISetToken setToken;
        uint256 setAmount;
        address originalSender;
        bool isIssuance;
        address paymentToken;
        uint256 limitAmount;
        LeveragedTokenData leveragedTokenData;
        DEXAdapter.SwapData collateralAndDebtSwapData;
        DEXAdapter.SwapData paymentTokenSwapData;
    }

    /* ============ Constants ============= */

    uint256 constant private MAX_UINT256 = type(uint256).max;
    uint256 public constant ROUNDING_ERROR_MARGIN = 2;

    /* ============ State Variables ============ */

    IController public immutable setController;
    IDebtIssuanceModule public immutable debtIssuanceModule;
    IAaveLeverageModule public immutable aaveLeverageModule;
    DEXAdapter.Addresses public addresses;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        address indexed _inputToken,    // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        address indexed _outputToken,   // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier onlyLendingPool() {
         require(msg.sender == address(LENDING_POOL), "ExchangeIssuance: LENDING POOL ONLY");
         _;
    }

    modifier isValidPath(
        address[] memory _path,
        address _inputToken,
        address _outputToken
    )
    {
        if(_inputToken != _outputToken){
            require(
                _path[0] == _inputToken || (_inputToken == addresses.weth && _path[0] == DEXAdapter.ETH_ADDRESS),
                "ExchangeIssuance: INPUT_TOKEN_NOT_IN_PATH"
            );
            require(
                _path[_path.length-1] == _outputToken ||
                (_outputToken == addresses.weth && _path[_path.length-1] == DEXAdapter.ETH_ADDRESS),
                "ExchangeIssuance: OUTPUT_TOKEN_NOT_IN_PATH"
            );
        }
        _;
    }


    /* ============ Constructor ============ */

    /**
    * Sets various contract addresses 
    * 
    * @param _weth                  Address of wrapped native token
    * @param _quickRouter           Address of quickswap router
    * @param _sushiRouter           Address of sushiswap router
    * @param _uniV3Router           Address of uniswap v3 router
    * @param _uniV3Quoter           Address of uniswap v3 quoter
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _debtIssuanceModule    DebtIssuanceModule used to issue and redeem tokens
    * @param _aaveLeverageModule    AaveLeverageModule to sync before every issuance / redemption
    * @param _aaveAddressProvider   Address of address provider for aaves addresses
    * @param _curveAddressProvider  Contract to get current implementation address of curve registry
    * @param _curveCalculator       Contract to calculate required input to receive given output in curve (for exact output swaps)
    */
    constructor(
        address _weth,
        address _quickRouter,
        address _sushiRouter,
        address _uniV3Router,
        address _uniV3Quoter,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        IAaveLeverageModule _aaveLeverageModule,
        address _aaveAddressProvider,
        address _curveAddressProvider,
        address _curveCalculator
    )
        public
        FlashLoanReceiverBaseV2(_aaveAddressProvider)
    {
        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;
        aaveLeverageModule = _aaveLeverageModule;

        addresses.weth = _weth;
        addresses.quickRouter = _quickRouter;
        addresses.sushiRouter = _sushiRouter;
        addresses.uniV3Router = _uniV3Router;
        addresses.uniV3Quoter = _uniV3Quoter;
        addresses.curveAddressProvider = _curveAddressProvider;
        addresses.curveCalculator = _curveCalculator;
    }

    /* ============ External Functions ============ */

    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a SetToken during a
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     */
    function approveToken(IERC20 _token) external {
        _approveToken(_token);
    }

    /**
     * Gets the proceeds of a redemption of a given amount of a set token. This
     * function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter
     * contract and call sync on AaveLeverageModule. Note: If the two SwapData
     * paths contain the same tokens, there will be a slight error introduced
     * in the result.
     *
     * @param _setToken                     the set token to issue
     * @param _setAmount                    amount of set tokens
     * @param _swapDataCollateralForDebt    swap data for the collateral to debt swap
     * @param _swapDataOutputToken          swap data for the collateral token to the output token
     *
     * @return                              amount of _outputToken that would be obtained from the redemption
     */
    function getRedeemExactSet(
        ISetToken _setToken,
        uint256 _setAmount,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
        external
        returns (uint256)
    {
        aaveLeverageModule.sync(_setToken);

        address[] memory components;
        uint256[] memory equityPositions;
        (components, equityPositions,) = debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, _setAmount);
        address collateralToken;
        uint256 collateralAmount;
        if (components[0] == addresses.weth) {
            collateralToken = IAToken(components[1]).UNDERLYING_ASSET_ADDRESS();
            collateralAmount = equityPositions[1] + ROUNDING_ERROR_MARGIN;
        } else {
            collateralToken = IAToken(components[0]).UNDERLYING_ASSET_ADDRESS();
            collateralAmount = equityPositions[0] + ROUNDING_ERROR_MARGIN;
        }
        return DEXAdapter.getAmountOut(addresses, _swapDataOutputToken, collateralAmount);
    }

    /**
     * Trigger redemption of set token to pay the user with Eth
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _minAmountOutputToken       Minimum amount of ETH to send to the user
     * @param _swapDataCollateralForDebt  Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Eth
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _setAmount,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
        external
        nonReentrant
    {
        aaveLeverageModule.sync(_setToken);

        address[] memory components;
        uint256[] memory equityPositions;
        (components, equityPositions,) = debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, _setAmount);
        address collateralToken;
        uint256 collateralAmount;
        if (components[0] == addresses.weth) {
            collateralToken = IAToken(components[1]).UNDERLYING_ASSET_ADDRESS();
            collateralAmount = equityPositions[1] + ROUNDING_ERROR_MARGIN;
        } else {
            collateralToken = IAToken(components[0]).UNDERLYING_ASSET_ADDRESS();
            collateralAmount = equityPositions[0] + ROUNDING_ERROR_MARGIN;
        }

        _redeemSet(
            _setToken,
            _setAmount,
            msg.sender
        );

        _withdrawCollateralToken(
            collateralToken,
            collateralAmount - ROUNDING_ERROR_MARGIN
        );

        uint256 ethAmount = _swapCollateralForOutputToken(
            collateralToken,
            collateralAmount - ROUNDING_ERROR_MARGIN,
            addresses.weth,
            _minAmountOutputToken,
            _swapDataCollateralForDebt
        );
        if (ethAmount > 0) {
            IWETH(addresses.weth).withdraw(ethAmount);
            (payable(msg.sender)).sendValue(ethAmount);
        }
        emit ExchangeRedeem(msg.sender, _setToken, 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, _setAmount, ethAmount);
        require(ethAmount >= _minAmountOutputToken, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");
    }

    function executeOperation(
        address[] memory assets,
        uint256[] memory amounts,
        uint256[] memory premiums,
        address initiator, 
        bytes memory params
    )
        external
        override 
        onlyLendingPool
        returns (bool)
    {
        require(1 == 0, "ExchangeIssuanceIcEth: No flash loans");
        return true;
    }

    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     */
    function approveTokens(IERC20[] memory _tokens) external {
        for (uint256 i = 0; i < _tokens.length; i++) {
            _approveToken(_tokens[i]);
        }
    }

    /**
     * Runs all the necessary approval functions required before issuing
     * or redeeming a SetToken. This function need to be called only once before the first time
     * this smart contract is used on any particular SetToken.
     *
     * @param _setToken    Address of the SetToken being initialized
     */
    function approveSetToken(ISetToken _setToken) external {
        address[] memory components;
        uint256[] memory equityPositions;
        (components, equityPositions,) = debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, 1 ether);
        address collateralAToken;
        address collateralToken;
        uint256 collateralAmount;
        if (components[0] == addresses.weth) {
            collateralAToken = components[1];
            collateralToken = IAToken(components[1]).UNDERLYING_ASSET_ADDRESS();
            collateralAmount = equityPositions[1] + ROUNDING_ERROR_MARGIN;
        } else {
            collateralAToken = components[0];
            collateralToken = IAToken(components[0]).UNDERLYING_ASSET_ADDRESS();
            collateralAmount = equityPositions[0] + ROUNDING_ERROR_MARGIN;
        }

        _approveToken(IERC20(collateralAToken));
        _approveTokenToLendingPool(IERC20(collateralToken));

        _approveToken(IERC20(addresses.weth));
        _approveTokenToLendingPool(IERC20(addresses.weth));
    }

    /* ============ Internal Functions ============ */

    /**
     * Approves max amount of given token to all exchange routers and the debt issuance module
     *
     * @param _token  Address of the token to be approved
     */
    function _approveToken(IERC20 _token) internal {
        _safeApprove(_token, address(debtIssuanceModule), MAX_UINT256);
    }

    /**
     * Redeems set token using the previously obtained debt token
     * Results in collateral token being returned to the contract
     *
     * @param _setToken         Address of the SetToken to be redeemed
     * @param _setAmount        Amount of SetTokens to redeem
     * @param _originalSender   Adress that initiated the token redemption which is the source of the set tokens to be redeemed
     */
    function _redeemSet(ISetToken _setToken, uint256 _setAmount, address _originalSender) internal {
        _setToken.safeTransferFrom(_originalSender, address(this), _setAmount);
        debtIssuanceModule.redeem(_setToken, _setAmount, address(this));
    }

    /**
     * Swaps the collateral tokens obtained from redemption for the selected output token
     * If both tokens are the same, does nothing
     *
     * @param _collateralToken        Address of collateral token
     * @param _collateralTokenAmount  Amount of colalteral token to swap
     * @param _outputToken            Address of the ERC20 token to swap into
     * @param _minAmountOutputToken   Minimum amount of output token to return to the user
     * @param _swapData               Data (token addresses and fee levels) describing the swap path
     *
     * @return Amount of output token obtained
     */
    function _swapCollateralForOutputToken(
        address _collateralToken,
        uint256 _collateralTokenAmount,
        address _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        isValidPath(_swapData.path, _collateralToken, _outputToken)
        returns (uint256)
    {
        return addresses.swapExactTokensForTokens(
            _collateralTokenAmount,
            _minAmountOutputToken,
            _swapData
        );
    }

    /**
     * Convert collateralAToken from set redemption to collateralToken by withdrawing underlying from Aave
     *
     * @param _collateralToken       Address of the collateralToken to withdraw from Aave lending pool
     * @param _collateralAmount      Amount of collateralToken to withdraw
     */
    function _withdrawCollateralToken(
        address _collateralToken,
        uint256 _collateralAmount
    ) internal {
        LENDING_POOL.withdraw(_collateralToken, _collateralAmount, address(this));
    }

    /**
     * Sets a max approval limit for an ERC20 token, provided the current allowance
     * is less than the required allownce.
     *
     * @param _token              Token to approve
     * @param _spender            Spender address to approve
     * @param _requiredAllowance  Target allowance to set
     */
    function _safeApprove(
        IERC20 _token,
        address _spender,
        uint256 _requiredAllowance
    )
        internal
    {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < _requiredAllowance) {
            _token.safeIncreaseAllowance(_spender, MAX_UINT256 - allowance);
        }
    }

    /**
     * Approves max amount of token to lending pool
     *
     * @param _token              Address of the token to approve
     */
    function _approveTokenToLendingPool(
        IERC20 _token
    )
    internal
    {
        uint256 allowance = _token.allowance(address(this), address(LENDING_POOL));
        if (allowance > 0) {
            _token.approve(address(LENDING_POOL), 0);
        }
        _token.approve(address(LENDING_POOL), MAX_UINT256);
    }

    /**
     * Redeems a given amount of SetToken.
     *
     * @param _setToken     Address of the SetToken to be redeemed
     * @param _amount       Amount of SetToken to be redeemed
     */
    function _redeemExactSet(ISetToken _setToken, uint256 _amount) internal returns (uint256) {
        _setToken.safeTransferFrom(msg.sender, address(this), _amount);
        debtIssuanceModule.redeem(_setToken, _amount, address(this));
    }
}
