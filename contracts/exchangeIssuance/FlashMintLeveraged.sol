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
import {IVault, IFlashLoanRecipient} from "../interfaces/external/balancer-v2/IVault.sol";
import {IPool} from "../interfaces/IPool.sol";


/**
 * @title FlashMintLeveraged
 * @author Index Coop
 *
 * Contract for issuing and redeeming a leveraged Set Token
 * Supports all tokens with one collateral Position in the form of an AToken and one debt position
 * Both the collateral as well as the debt token have to be available for flashloan from balancer and be 
 * tradeable against each other on Sushi / Quickswap
 */
contract FlashMintLeveraged is ReentrancyGuard, IFlashLoanRecipient{

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
    IVault public immutable balancerV2Vault;
    IPool public immutable LENDING_POOL;
    address private flashLoanBenefactor;

    /* ============ Events ============ */

    event FlashMint(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        address indexed _inputToken,    // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event FlashRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        address indexed _outputToken,   // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */
 
     modifier onlyBalancerV2Vault() {
         require(msg.sender == address(balancerV2Vault), "ExchangeIssuance: BalancerV2 Vault ONLY");
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
    * @param _addresses             dex adapter addreses
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _debtIssuanceModule    DebtIssuanceModule used to issue and redeem tokens
    * @param _aaveLeverageModule    AaveLeverageModule to sync before every issuance / redemption
    * @param _aaveV3Pool   Address of address provider for aaves addresses
    * @param _vault                 Balancer Vault to flashloan from
    */
    constructor(
        DEXAdapter.Addresses memory _addresses,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        IAaveLeverageModule _aaveLeverageModule,
        address _aaveV3Pool,
        address _vault
    )
        public
    {
        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;
        aaveLeverageModule = _aaveLeverageModule;
        addresses = _addresses;
        LENDING_POOL = IPool(_aaveV3Pool);
        balancerV2Vault = IVault(_vault);
    }

    /* ============ External Functions ============ */

    /**
     * Returns the collateral / debt token addresses and amounts for a leveraged index 
     *
     * @param _setToken              Address of the SetToken to be issued / redeemed
     * @param _setAmount             Amount of SetTokens to issue / redeem
     * @param _isIssuance            Boolean indicating if the SetToken is to be issued or redeemed
     *
     * @return Struct containing the collateral / debt token addresses and amounts
     */
    function getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isIssuance
    )
        external 
        view
        returns (LeveragedTokenData memory)
    {
        return _getLeveragedTokenData(_setToken, _setAmount, _isIssuance);
    }

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
     * Gets the input cost of issuing a given amount of a set token. This
     * function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter
     * contract and call sync on AaveLeverageModule. Note: If the two SwapData
     * paths contain the same tokens, there will be a slight error introduced
     * in the result.
     *
     * @param _setToken                     the set token to issue
     * @param _setAmount                    amount of set tokens
     * @param _swapDataDebtForCollateral    swap data for the debt to collateral swap
     * @param _swapDataInputToken           swap data for the input token to collateral swap
     *
     * @return                              the amount of input tokens required to perfrom the issuance
     */
    function getIssueExactSet(
        ISetToken _setToken,
        uint256 _setAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
        external
        returns (uint256)
    {
        aaveLeverageModule.sync(_setToken);
        LeveragedTokenData memory issueInfo = _getLeveragedTokenData(_setToken, _setAmount, true);        
        uint256 collateralOwed = issueInfo.collateralAmount.preciseMul(1.0009 ether);
        uint256 borrowSaleProceeds = DEXAdapter.getAmountOut(addresses, _swapDataDebtForCollateral, issueInfo.debtAmount);
        collateralOwed = collateralOwed.sub(borrowSaleProceeds);
        return DEXAdapter.getAmountIn(addresses, _swapDataInputToken, collateralOwed);
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
        LeveragedTokenData memory redeemInfo = _getLeveragedTokenData(_setToken, _setAmount, false);
        uint256 debtOwed = redeemInfo.debtAmount.preciseMul(1.0009 ether);
        uint256 debtPurchaseCost = DEXAdapter.getAmountIn(addresses, _swapDataCollateralForDebt, debtOwed);
        uint256 extraCollateral = redeemInfo.collateralAmount.sub(debtPurchaseCost);
        return DEXAdapter.getAmountOut(addresses, _swapDataOutputToken, extraCollateral);
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
        virtual
        nonReentrant
    {
        _initiateRedemption(
            _setToken,
            _setAmount,
            DEXAdapter.ETH_ADDRESS,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken
        );
    }

    /**
     * Trigger redemption of set token to pay the user with an arbitrary ERC20 
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _outputToken                Address of the ERC20 token to send to the user
     * @param _minAmountOutputToken       Minimum amount of output token to send to the user
     * @param _swapDataCollateralForDebt  Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Output token
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
        external
        virtual
        nonReentrant
    {
        _initiateRedemption(
            _setToken,
            _setAmount,
            _outputToken,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken
        );
    }

    /**
     * Trigger issuance of set token paying with any arbitrary ERC20 token
     *
     * @param _setToken                     Set token to issue
     * @param _setAmount                    Amount to issue
     * @param _inputToken                   Input token to pay with
     * @param _maxAmountInputToken          Maximum amount of input token to spend
     * @param _swapDataDebtForCollateral    Data (token addresses and fee levels) to describe the swap path from Debt to collateral token
     * @param _swapDataInputToken           Data (token addresses and fee levels) to describe the swap path from input to collateral token
     */
    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
        external
        virtual
        nonReentrant
    {
        _initiateIssuance(
            _setToken,
            _setAmount,
            _inputToken,
            _maxAmountInputToken,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
    }

    /**
     * Trigger issuance of set token paying with Eth
     *
     * @param _setToken                     Set token to issue
     * @param _setAmount                    Amount to issue
     * @param _swapDataDebtForCollateral    Data (token addresses and fee levels) to describe the swap path from Debt to collateral token
     * @param _swapDataInputToken           Data (token addresses and fee levels) to describe the swap path from eth to collateral token
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _setAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
        external
        virtual
        payable
        nonReentrant
    {
        _initiateIssuance(
            _setToken,
            _setAmount,
            DEXAdapter.ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
    }

     /**
     * This is the callback function that will be called by the Balancerv2 Pool after flashloaned tokens have been sent
     * to this contract.
     * After exiting this function the Vault enforces that we transfer back the loaned tokens + interest. If that check fails
     * the whole transaction gets reverted
     *
     * @param tokens     Addresses of all assets that were borrowed
     * @param amounts    Amounts that were borrowed
     * @param feeAmounts   Interest to be paid on top of borrowed amount
     * @param userData     Encoded bytestring of other parameters from the original contract call to be used downstream
     * 
     */
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    )
        external
        override
        onlyBalancerV2Vault
    {

        DecodedParams memory decodedParams = abi.decode(userData, (DecodedParams));
        require(flashLoanBenefactor == decodedParams.originalSender, "Flashloan not initiated by this contract");

        if(decodedParams.isIssuance){
            _performIssuance(address(tokens[0]), amounts[0], feeAmounts[0], decodedParams);
        } else {
            _performRedemption(address(tokens[0]), amounts[0], feeAmounts[0], decodedParams);
        }

         for(uint256 i = 0; i < tokens.length; i++) {
                tokens[i].safeTransfer(address(balancerV2Vault), amounts[i]+ feeAmounts[i]);
        }

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
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, 1 ether, true);

        _approveToken(IERC20(leveragedTokenData.collateralAToken));
        _approveTokenToLendingPool(IERC20(leveragedTokenData.collateralToken));

        _approveToken(IERC20(leveragedTokenData.debtToken));
        _approveTokenToLendingPool(IERC20(leveragedTokenData.debtToken));
    }

    /* ============ Internal Functions ============ */

    /**
     * Performs all the necessary steps for issuance using the collateral tokens obtained in the flashloan
     *
     * @param _collateralToken            Address of the underlying collateral token that was loaned
     * @param _collateralTokenAmountNet   Amount of collateral token that was received as flashloan
     * @param _premium                    Premium / Interest that has to be returned to the lending pool on top of the loaned amount
     * @param _decodedParams              Struct containing token addresses / amounts to perform issuance
     */
    function _performIssuance(
        address _collateralToken,
        uint256 _collateralTokenAmountNet,
        uint256 _premium,
        DecodedParams memory _decodedParams
    ) 
    internal 
    {
        // Deposit collateral token obtained from flashloan to get the respective aToken position required for issuance
        _depositCollateralToken(_collateralToken, _collateralTokenAmountNet);

        // Issue set using the aToken returned by deposit step
        _issueSet(_decodedParams.setToken, _decodedParams.setAmount, _decodedParams.originalSender);
        // Obtain necessary collateral tokens to repay flashloan 
        uint amountInputTokenSpent = _obtainCollateralTokens(
            _collateralToken,
            _collateralTokenAmountNet + _premium,
            _decodedParams
        );
        require(amountInputTokenSpent <= _decodedParams.limitAmount, "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT");
    }

    /**
     * Performs all the necessary steps for redemption using the debt tokens obtained in the flashloan
     *
     * @param _debtToken           Address of the debt token that was loaned
     * @param _debtTokenAmountNet  Amount of debt token that was received as flashloan
     * @param _premium             Premium / Interest that has to be returned to the lending pool on top of the loaned amount
     * @param _decodedParams       Struct containing token addresses / amounts to perform redemption
     */
    function _performRedemption(
        address _debtToken,
        uint256 _debtTokenAmountNet,
        uint256 _premium,
        DecodedParams memory _decodedParams
    ) 
    internal 
    {
        // Redeem set using debt tokens obtained from flashloan
        _redeemSet(
            _decodedParams.setToken,
            _decodedParams.setAmount,
            _decodedParams.originalSender
        );
        // Withdraw underlying collateral token from the aToken position returned by redeem step
        _withdrawCollateralToken(
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.leveragedTokenData.collateralAmount - ROUNDING_ERROR_MARGIN
        );
        // Obtain debt tokens required to repay flashloan by swapping the underlying collateral tokens obtained in withdraw step
        uint256 collateralTokenSpent = _swapCollateralForDebtToken(
            _debtTokenAmountNet + _premium,
            _debtToken,
            _decodedParams.leveragedTokenData.collateralAmount,
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.collateralAndDebtSwapData
        );
        // Liquidate remaining collateral tokens for the payment token specified by user
        uint256 amountOutputToken = _liquidateCollateralTokens(
            collateralTokenSpent,
            _decodedParams.setToken,
            _decodedParams.setAmount,
            _decodedParams.originalSender,
            _decodedParams.paymentToken,
            _decodedParams.limitAmount,
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.leveragedTokenData.collateralAmount  - 2*ROUNDING_ERROR_MARGIN,
            _decodedParams.paymentTokenSwapData
        );
        require(amountOutputToken >= _decodedParams.limitAmount, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");
    }


    /**
    * Returns the collateral / debt token addresses and amounts for a leveraged index 
    *
    * @param _setToken              Address of the SetToken to be issued / redeemed
    * @param _setAmount             Amount of SetTokens to issue / redeem
    * @param _isIssuance            Boolean indicating if the SetToken is to be issued or redeemed
    *
    * @return Struct containing the collateral / debt token addresses and amounts
    */
    function _getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isIssuance
    )
        internal 
        view
        returns (LeveragedTokenData memory)
    {
        address[] memory components;
        uint256[] memory equityPositions;
        uint256[] memory debtPositions;


        if(_isIssuance){
            (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentIssuanceUnits(_setToken, _setAmount);
        } else {
            (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, _setAmount);
        }

        require(components.length == 2, "ExchangeIssuance: TOO MANY COMPONENTS");
        require(equityPositions[0] == 0 || equityPositions[1] == 0, "ExchangeIssuance: TOO MANY EQUITY POSITIONS");
        require(debtPositions[0] == 0 || debtPositions[1] == 0, "ExchangeIssuance: TOO MANY DEBT POSITIONS");

        if(equityPositions[0] > 0){
            return LeveragedTokenData(
                components[0],
                IAToken(components[0]).UNDERLYING_ASSET_ADDRESS(),
                equityPositions[0] + ROUNDING_ERROR_MARGIN,
                components[1],
                debtPositions[1]
            );
        } else {
            return LeveragedTokenData(
                components[1],
                IAToken(components[1]).UNDERLYING_ASSET_ADDRESS(),
                equityPositions[1] + ROUNDING_ERROR_MARGIN,
                components[0],
                debtPositions[0]
            );
        }
    }



    /**
     * Approves max amount of given token to all exchange routers and the debt issuance module
     *
     * @param _token  Address of the token to be approved
     */
    function _approveToken(IERC20 _token) internal {
        _safeApprove(_token, address(debtIssuanceModule), MAX_UINT256);
    }

    /**
     * Initiates a flashloan call with the correct parameters for issuing set tokens in the callback
     * Borrows correct amount of collateral token and and forwards encoded memory to controll issuance in the callback.
     *
     * @param _setToken                     Address of the SetToken being initialized
     * @param _setAmount                    Amount of the SetToken being initialized
     * @param _inputToken                   Address of the input token to pay with
     * @param _maxAmountInputToken          Maximum amount of input token to pay
     * @param _swapDataDebtForCollateral    Data (token addresses and fee levels) to describe the swap path from Debt to collateral token
     * @param _swapDataInputToken           Data (token addresses and fee levels) to describe the swap path from input to collateral token
     */
    function _initiateIssuance(
        ISetToken _setToken,
        uint256 _setAmount,
        address _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
        internal
    {
        aaveLeverageModule.sync(_setToken);
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, _setAmount, true);

        address[] memory assets = new address[](1);
        assets[0] = leveragedTokenData.collateralToken;
        uint[] memory amounts =  new uint[](1);
        amounts[0] = leveragedTokenData.collateralAmount;

        bytes memory params = abi.encode(
            DecodedParams(
                _setToken,
                _setAmount,
                msg.sender,
                true,
                _inputToken,
                _maxAmountInputToken,
                leveragedTokenData,
                _swapDataDebtForCollateral,
                _swapDataInputToken
           )
        );

        _flashloan(assets, amounts, params);

    }

    /**
     * Initiates a flashloan call with the correct parameters for redeeming set tokens in the callback
     *
     * @param _setToken                   Address of the SetToken to redeem
     * @param _setAmount                  Amount of the SetToken to redeem
     * @param _outputToken                Address of token to return to the user
     * @param _minAmountOutputToken       Minimum amount of output token to receive
     * @param _swapDataCollateralForDebt  Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Output token
     */
    function _initiateRedemption(
        ISetToken _setToken,
        uint256 _setAmount,
        address  _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
        internal
    {
        aaveLeverageModule.sync(_setToken);
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, _setAmount, false);

        address[] memory assets = new address[](1);
        assets[0] = leveragedTokenData.debtToken;
        uint[] memory amounts =  new uint[](1);
        amounts[0] = leveragedTokenData.debtAmount;

        bytes memory params = abi.encode(
            DecodedParams(
                _setToken,
                _setAmount,
                msg.sender,
                false,
                _outputToken,
                _minAmountOutputToken,
                leveragedTokenData,
                _swapDataCollateralForDebt,
                _swapDataOutputToken
            )
        );

        _flashloan(assets, amounts, params);

    }

    /**
     * Gets rid of the obtained collateral tokens from redemption by either sending them to the user
     * directly or converting them to the payment token and sending those out.
     *
     * @param _collateralTokenSpent    Amount of collateral token spent to obtain the debt token required for redemption
     * @param _setToken                Address of the SetToken to be issued
     * @param _setAmount               Amount of SetTokens to issue
     * @param _originalSender          Address of the user who initiated the redemption
     * @param _outputToken             Address of token to return to the user
     * @param _collateralToken         Address of the collateral token to sell
     * @param _collateralAmount        Amount of collateral token to sell
     * @param _minAmountOutputToken    Minimum amount of output token to return to the user
     * @param _swapData                Struct containing path and fee data for swap
     *
     * @return Amount of output token returned to the user
     */
    function _liquidateCollateralTokens(
        uint256 _collateralTokenSpent,
        ISetToken _setToken,
        uint256 _setAmount,
        address _originalSender,
        address _outputToken,
        uint256 _minAmountOutputToken,
        address _collateralToken,
        uint256 _collateralAmount,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        returns (uint256)
    {
        require(_collateralAmount >= _collateralTokenSpent, "ExchangeIssuance: OVERSPENT COLLATERAL TOKEN");
        uint256 amountToReturn = _collateralAmount.sub(_collateralTokenSpent);
        uint256 outputAmount;
        if(_outputToken == DEXAdapter.ETH_ADDRESS){
            outputAmount = _liquidateCollateralTokensForETH(
                _collateralToken,
                amountToReturn,
                _originalSender,
                _minAmountOutputToken,
                _swapData
            );
        } else {
            outputAmount = _liquidateCollateralTokensForERC20(
                _collateralToken,
                amountToReturn,
                _originalSender,
                IERC20(_outputToken),
                _minAmountOutputToken,
                _swapData
            );
        }
        emit FlashMint(_originalSender, _setToken, _outputToken, _setAmount, outputAmount);
        return outputAmount;
    }

    /**
     * Returns the collateralToken directly to the user
     *
     * @param _collateralToken       Address of the the collateral token
     * @param _collateralRemaining   Amount of the collateral token remaining after buying required debt tokens
     * @param _originalSender        Address of the original sender to return the tokens to
     */
    function _returnCollateralTokensToSender(
        address _collateralToken,
        uint256 _collateralRemaining,
        address _originalSender
    )
        internal
    {
        IERC20(_collateralToken).transfer(_originalSender, _collateralRemaining);
    }

    /**
     * Sells the collateral tokens for the selected output ERC20 and returns that to the user
     *
     * @param _collateralToken       Address of the collateral token
     * @param _collateralRemaining   Amount of the collateral token remaining after buying required debt tokens
     * @param _originalSender        Address of the original sender to return the tokens to
     * @param _outputToken           Address of token to return to the user
     * @param _minAmountOutputToken  Minimum amount of output token to return to the user
     * @param _swapData              Data (token path and fee levels) describing the swap path from Collateral Token to Output token
     *
     * @return Amount of output token returned to the user
     */
    function _liquidateCollateralTokensForERC20(
        address _collateralToken,
        uint256 _collateralRemaining,
        address _originalSender,
        IERC20 _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        virtual
        returns (uint256)
    {
        if(address(_outputToken) == _collateralToken){
            _returnCollateralTokensToSender(_collateralToken, _collateralRemaining, _originalSender);
            return _collateralRemaining;
        }
        uint256 outputTokenAmount = _swapCollateralForOutputToken(
            _collateralToken,
            _collateralRemaining,
            address(_outputToken),
            _minAmountOutputToken,
            _swapData
        );
        _outputToken.transfer(_originalSender, outputTokenAmount);
        return outputTokenAmount;
    }

    /**
     * Sells the remaining collateral tokens for weth, withdraws that and returns native eth to the user
     *
     * @param _collateralToken            Address of the collateral token
     * @param _collateralRemaining        Amount of the collateral token remaining after buying required debt tokens
     * @param _originalSender             Address of the original sender to return the eth to
     * @param _minAmountOutputToken       Minimum amount of output token to return to user
     * @param _swapData                   Data (token path and fee levels) describing the swap path from Collateral Token to eth
     *
     * @return Amount of eth returned to the user
     */
    function _liquidateCollateralTokensForETH(
        address _collateralToken,
        uint256 _collateralRemaining,
        address _originalSender,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        virtual
        isValidPath(_swapData.path, _collateralToken, addresses.weth)
        returns(uint256)
    {
        uint256 ethAmount = _swapCollateralForOutputToken(
            _collateralToken,
            _collateralRemaining,
            addresses.weth,
            _minAmountOutputToken,
            _swapData
        );
        if (ethAmount > 0) {
            IWETH(addresses.weth).withdraw(ethAmount);
            (payable(_originalSender)).sendValue(ethAmount);
        }
        return ethAmount;
    }

    /**
     * Obtains the tokens necessary to return the flashloan by swapping the debt tokens obtained
     * from issuance and making up the shortfall using the users funds.
     *
     * @param _collateralToken       collateral token to obtain
     * @param _amountRequired        Amount of collateralToken required to repay the flashloan
     * @param _decodedParams         Struct containing decoded data from original call passed through via flashloan
     *
     * @return Amount of input token spent
     */
    function _obtainCollateralTokens(
        address _collateralToken,
        uint256 _amountRequired,
        DecodedParams memory _decodedParams
    )
        internal
        returns (uint256)
    {
        uint collateralTokenObtained =  _swapDebtForCollateralToken(
            _collateralToken,
            _decodedParams.leveragedTokenData.debtToken,
            _decodedParams.leveragedTokenData.debtAmount,
            _decodedParams.collateralAndDebtSwapData
        );

        uint collateralTokenShortfall = _amountRequired.sub(collateralTokenObtained) + ROUNDING_ERROR_MARGIN;
        uint amountInputToken;

        if(_decodedParams.paymentToken == DEXAdapter.ETH_ADDRESS){
            amountInputToken = _makeUpShortfallWithETH(
                _collateralToken,
                collateralTokenShortfall,
                _decodedParams.originalSender,
                _decodedParams.limitAmount,
                _decodedParams.paymentTokenSwapData
            );
        } else {
            amountInputToken = _makeUpShortfallWithERC20(
                _collateralToken,
                collateralTokenShortfall,
                _decodedParams.originalSender,
                IERC20(_decodedParams.paymentToken),
                _decodedParams.limitAmount,
                _decodedParams.paymentTokenSwapData
            );
        }
        emit FlashRedeem(
            _decodedParams.originalSender,
            _decodedParams.setToken,
            _decodedParams.paymentToken,
            amountInputToken,
            _decodedParams.setAmount
        );
        return amountInputToken;
    }

    /**
     * Issues set token using the previously obtained collateral token
     * Results in debt token being returned to the contract
     *
     * @param _setToken         Address of the SetToken to be issued
     * @param _setAmount        Amount of SetTokens to issue
     * @param _originalSender   Adress that initiated the token issuance, which will receive the set tokens
     */
    function _issueSet(ISetToken _setToken, uint256 _setAmount, address _originalSender) internal {
        debtIssuanceModule.issue(_setToken, _setAmount, _originalSender);
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
     * Transfers the shortfall between the amount of tokens required to return flashloan and what was obtained
     * from swapping the debt tokens from the users address
     *
     * @param _token                 Address of the token to transfer from user
     * @param _shortfall             Collateral token shortfall required to return the flashloan
     * @param _originalSender        Adress that initiated the token issuance, which is the adresss form which to transfer the tokens
     */
    function _transferShortfallFromSender(
        address _token,
        uint256 _shortfall,
        address _originalSender
    )
        internal
    {
        if(_shortfall>0){ 
            IERC20(_token).safeTransferFrom(_originalSender, address(this), _shortfall);
        }
    }

    /**
     * Makes up the collateral token shortfall with user specified ERC20 token
     *
     * @param _collateralToken             Address of the collateral token
     * @param _collateralTokenShortfall    Shortfall of collateral token that was not covered by selling the debt tokens
     * @param _originalSender              Address of the original sender to return the tokens to
     * @param _inputToken                  Input token to pay with
     * @param _maxAmountInputToken         Maximum amount of input token to spend
     *
     * @return Amount of input token spent
     */
    function _makeUpShortfallWithERC20(
        address _collateralToken,
        uint256 _collateralTokenShortfall,
        address _originalSender,
        IERC20 _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        virtual
        returns (uint256)
    {
        if(address(_inputToken) == _collateralToken){
            _transferShortfallFromSender(_collateralToken, _collateralTokenShortfall, _originalSender);
            return _collateralTokenShortfall;
        } else {
            _inputToken.transferFrom(_originalSender, address(this), _maxAmountInputToken);
            uint256 amountInputToken = _swapInputForCollateralToken(
                _collateralToken,
                _collateralTokenShortfall,
                address(_inputToken),
                _maxAmountInputToken,
                _swapData
            );
            if(amountInputToken < _maxAmountInputToken){
                _inputToken.transfer(_originalSender, _maxAmountInputToken.sub(amountInputToken));
            }
            return amountInputToken;
        }
    }

    /**
     * Makes up the collateral token shortfall with native eth
     *
     * @param _collateralToken             Address of the collateral token
     * @param _collateralTokenShortfall    Shortfall of collateral token that was not covered by selling the debt tokens
     * @param _originalSender              Address of the original sender to return the tokens to
     * @param _maxAmountEth                Maximum amount of eth to pay
     *
     * @return Amount of eth spent
     */
    function _makeUpShortfallWithETH(
        address _collateralToken,
        uint256 _collateralTokenShortfall,
        address _originalSender,
        uint256 _maxAmountEth,
        DEXAdapter.SwapData memory _swapData

    )
        internal
        virtual
        returns(uint256)
    {
        IWETH(addresses.weth).deposit{value: _maxAmountEth}();

        uint256 amountEth = _swapInputForCollateralToken(
            _collateralToken,
            _collateralTokenShortfall,
            addresses.weth,
            _maxAmountEth,
            _swapData
        );

        if(_maxAmountEth > amountEth){
            uint256 amountEthReturn = _maxAmountEth.sub(amountEth);
            IWETH(addresses.weth).withdraw(amountEthReturn);
            (payable(_originalSender)).sendValue(amountEthReturn);
        }
        return amountEth;
    }

    /**
     * Swaps the debt tokens obtained from issuance for the collateral
     *
     * @param _collateralToken            Address of the collateral token buy
     * @param _debtToken                  Address of the debt token to sell
     * @param _debtAmount                 Amount of debt token to sell
     * @param _swapData                   Struct containing path and fee data for swap
     *
     * @return Amount of collateral token obtained
     */
    function _swapDebtForCollateralToken(
        address _collateralToken,
        address _debtToken,
        uint256 _debtAmount,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        isValidPath(_swapData.path, _debtToken, _collateralToken)
        returns (uint256)
    {
        return addresses.swapExactTokensForTokens(
            _debtAmount,
            // minAmountOut is 0 here since we are going to make up the shortfall with the input token.
            // Sandwich protection is provided by the check at the end against _maxAmountInputToken parameter specified by the user
            0, 
            _swapData
        );
    }

    /**
     * Acquires debt tokens needed for flashloan repayment by swapping a portion of the collateral tokens obtained from redemption
     *
     * @param _debtAmount             Amount of debt token to buy
     * @param _debtToken              Address of debt token
     * @param _collateralAmount       Amount of collateral token available to spend / used as maxAmountIn parameter
     * @param _collateralToken        Address of collateral token
     * @param _swapData               Struct containing path and fee data for swap
     *
     * @return Amount of collateral token spent
     */
    function _swapCollateralForDebtToken(
        uint256 _debtAmount,
        address _debtToken,
        uint256 _collateralAmount,
        address _collateralToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        isValidPath(_swapData.path, _collateralToken, _debtToken)
        returns (uint256)
    {
        return addresses.swapTokensForExactTokens(
            _debtAmount,
            _collateralAmount,
            _swapData
        );
    }

    /**
     * Acquires the required amount of collateral tokens by swapping the input tokens
     * Does nothing if collateral and input token are indentical
     *
     * @param _collateralToken       Address of collateral token
     * @param _amountRequired        Remaining amount of collateral token required to repay flashloan, after having swapped debt tokens for collateral
     * @param _inputToken            Address of input token to swap
     * @param _maxAmountInputToken   Maximum amount of input token to spend
     * @param _swapData              Data (token addresses and fee levels) describing the swap path
     *
     * @return Amount of input token spent
     */
    function _swapInputForCollateralToken(
        address _collateralToken,
        uint256 _amountRequired,
        address _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapData
    )
        internal
        isValidPath(
            _swapData.path,
            _inputToken,
            _collateralToken
        )
        returns (uint256)
    {
        if(_collateralToken == _inputToken) return _amountRequired;
        return addresses.swapTokensForExactTokens(
            _amountRequired,
            _maxAmountInputToken,
            _swapData
        );
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
     * Deposit collateral to aave to obtain collateralAToken for issuance
     *
     * @param _collateralToken              Address of collateral token
     * @param _depositAmount                Amount to deposit
     */
    function _depositCollateralToken(
        address _collateralToken,
        uint256 _depositAmount
    ) internal {
        LENDING_POOL.deposit(_collateralToken, _depositAmount, address(this), 0);
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
     * Triggers the flashloan from the BalancerV2 Vault
     *
     * @param assets         Addresses of tokens to loan 
     * @param amounts        Amounts to loan
     * @param params         Encoded memory to forward to the executeOperation method
     */
    function _flashloan(
        address[] memory assets,
        uint256[] memory amounts,
        bytes memory params
    )
    internal
    {
        require(flashLoanBenefactor == address(0), "Flashloan already taken");
        flashLoanBenefactor = msg.sender;
        balancerV2Vault.flashLoan(this, assets, amounts, params);
        flashLoanBenefactor = address(0);
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
    receive() external payable {}
}
