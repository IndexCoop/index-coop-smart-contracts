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
import { ICErc20 } from "../interfaces/ICErc20.sol";
import { ICompoundLeverageModule } from "../interfaces/ICompoundLeverageModule.sol";

import { ICErc20Delegator } from "../interfaces/ICErc20Delegator.sol";
import { ICEther } from "../interfaces/ICEther.sol";

import { CErc20Storage } from "../interfaces/CErc20Storage.sol";
import { CompoundLeverageModuleStorage } from "../interfaces/CompoundLeverageModuleStorage.sol";

import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { UniSushiV2Library } from "../../external/contracts/UniSushiV2Library.sol";
import { FlashLoanReceiverBaseV2 } from "../../external/contracts/aaveV2/FlashLoanReceiverBaseV2.sol";
import { DEXAdapter } from "./DEXAdapter.sol";
import { Exponential } from "../lib/Exponential.sol";

/**
 * @title FlashMintLeveragedForCompound
 * @author Index Coop
 *
 * Contract for minting and redeeming a leveraged Set token.
 * Supports all tokens with one collateral Position in the form of a cToken and one debt position
 * The collateral underlying  must be available on an Aave flashloan.
 * The collateral and debt tokens must be available on Compound.
 * Input/Output tokens must be tradeable on supported dexes.
 */
contract FlashMintLeveragedForCompound is Exponential, ReentrancyGuard, FlashLoanReceiverBaseV2 {

    using DEXAdapter for DEXAdapter.Addresses;
    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Structs ============ */

    struct LeveragedTokenData {
        address collateralCToken;
        uint256 cTokenAmount;
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

    /* ============ Immutables ============ */
    
    address public immutable cEtherAddress;
    IController public immutable setController;
    IDebtIssuanceModule public immutable debtIssuanceModule;
    ICompoundLeverageModule public immutable compoundLeverageModule;

    /* ============ State Variables ============ */

    DEXAdapter.Addresses public addresses;

    /* ============ Events ============ */

    event FlashMint(
        address indexed _recipient,     // The recipient address of the minted Set token
        ISetToken indexed _setToken,    // The minted Set token
        address indexed _inputToken,    // The address of the input asset(ERC20/ETH) used to mint the Set tokens
        uint256 _amountInputToken,      // The amount of input tokens used for minting
        uint256 _amountSetIssued        // The amount of Set tokens received by the recipient
    );

    event FlashRedeem(
        address indexed _recipient,     // The recipient address which redeemed the Set token
        ISetToken indexed _setToken,    // The redeemed Set token
        address indexed _outputToken,   // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of Set token redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier onlyLendingPool() {
        require(msg.sender == address(LENDING_POOL), "FlashMint: LENDING POOL ONLY");
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
                "FlashMint: INPUT_TOKEN_NOT_IN_PATH"
            );
            require(
                _path[_path.length-1] == _outputToken ||
                (_outputToken == addresses.weth && _path[_path.length-1] == DEXAdapter.ETH_ADDRESS),
                "FlashMint: OUTPUT_TOKEN_NOT_IN_PATH"
            );
        }
        _;
    }


    /* ============ Constructor ============ */

    /**
    * Sets various contract addresses
    *
    * @param _dexAddresses              Address of quickRouter, sushiRouter, uniV3Router, uniV3Router, curveAddressProvider, curveCalculator and weth. 
    * @param _setController             Set token controller used to verify a given token is a set
    * @param _debtIssuanceModule        DebtIssuanceModule used to issue and redeem tokens
    * @param _compoundLeverageModule    CompoundLeverageModule to sync before every mint / redemption
    * @param _aaveAddressProvider       Address of address provider for aaves addresses
    * @param _cEther                    Address of Compound's cEther token
    */
    constructor(
        DEXAdapter.Addresses memory _dexAddresses,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        ICompoundLeverageModule _compoundLeverageModule,
        address _aaveAddressProvider,
        address _cEther
    )
    public
    FlashLoanReceiverBaseV2(_aaveAddressProvider)
    {
        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;
        compoundLeverageModule = _compoundLeverageModule;
        addresses = _dexAddresses;
        cEtherAddress = _cEther;
    }

    /* ============ External Functions ============ */

    /**
     * Returns the collateral / debt token addresses and amounts for a leveraged index.
     *
     * @param _setToken     Address of the Set token to be minted / redeemed
     * @param _setAmount    Amount to mint / redeem
     * @param _isMint       Boolean indicating if the Set token is to be issued/minted or redeemed
     *
     * @return Struct containing the collateral / debt token addresses and amounts
     */
    function getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isMint
    )
    external
    view
    returns (LeveragedTokenData memory)
    {
        return _getLeveragedTokenData(_setToken, _setAmount, _isMint);
    }

    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a Set token during a rebalance.
     *
     * @param _token    Address of the token which needs approval
     */
    function approveToken(IERC20 _token) external {
        _approveToken(_token);
    }

    /**
     * Gets the input cost of issuing/minting a given amount of a Set token. This
     * function is not marked view, but should be static called off-chain.
     * This constraint is due to the need to interact with the Uniswap V3 quoter
     * contract and call sync on CompoundLeverageModule. 
     * @dev If the two SwapData paths contain the same tokens, there will be a slight error introduced in the result.
     *
     * @param _setToken                     Set token to mint
     * @param _setAmount                    Amount to mint
     * @param _swapDataDebtForCollateral    SwapData (token addresses and fee levels) to describe the swap path from debt to collateral token
     * @param _swapDataInputToken           SwapData (token addresses and fee levels) to describe the swap path from input to collateral token
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
        compoundLeverageModule.sync(_setToken, false);
        LeveragedTokenData memory issueInfo = _updateCompoundRateAndGetLeveragedTokenData(_setToken, _setAmount, true);
        uint256 collateralOwed = issueInfo.collateralAmount.preciseMul(1.0009 ether);
        uint256 borrowSaleProceeds = DEXAdapter.getAmountOut(addresses, _swapDataDebtForCollateral, issueInfo.debtAmount);
        collateralOwed = collateralOwed.sub(borrowSaleProceeds);
        return DEXAdapter.getAmountIn(addresses, _swapDataInputToken, collateralOwed);
    }

    /**
     * Gets the proceeds of a redemption of a given amount of a set token. This
     * function is not marked view, but should be static called from frontends.
     * This constraint is due to the need to interact with the Uniswap V3 quoter
     * contract and call sync on CompoundLeverageModule. 
     * @dev If the two SwapData paths contain the same tokens, there will be a slight error introduced in the result.
     *
     * @param _setToken                     Set token to redeem
     * @param _setAmount                    Amount to redeem
     * @param _swapDataCollateralForDebt    SwapData (token path and fee levels) describing the swap from collateral to debt token
     * @param _swapDataOutputToken          SwapData (token path and fee levels) describing the swap from collateral to output token
     *
     * @return                              amount of output token that would be obtained from the redemption
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
        compoundLeverageModule.sync(_setToken, true);
        LeveragedTokenData memory redeemInfo = _updateCompoundRateAndGetLeveragedTokenData(_setToken, _setAmount, false);
        uint256 debtOwed = redeemInfo.debtAmount.preciseMul(1.0009 ether);
        uint256 debtPurchaseCost = DEXAdapter.getAmountIn(addresses, _swapDataCollateralForDebt, debtOwed);
        uint256 extraCollateral = redeemInfo.collateralAmount.sub(debtPurchaseCost);
        return DEXAdapter.getAmountOut(addresses, _swapDataOutputToken, extraCollateral);
    }

    /**
     * Trigger redemption of Set token to pay the user with Eth
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _minAmountOutputToken       Minimum amount of ETH to send to the user
     * @param _swapDataCollateralForDebt  SwapData (token path and fee levels) describing the swap from collateral token to debt token
     * @param _swapDataOutputToken        SwapData (token path and fee levels) describing the swap from collateral token to output token
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
        _flashRedeem(
            _setToken,
            _setAmount,
            DEXAdapter.ETH_ADDRESS,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken
        );
    }

    /**
     * Trigger redemption of Set token to pay the user with an arbitrary ERC20
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _outputToken                Address of the ERC20 token to send to the user
     * @param _minAmountOutputToken       Minimum amount of output token to send to the user
     * @param _swapDataCollateralForDebt  SwapData (token path and fee levels) describing the swap from collateral token to debt token
     * @param _swapDataOutputToken        SwapData (token path and fee levels) describing the swap from collateral token to output token
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
    nonReentrant
    {
        _flashRedeem(
            _setToken,
            _setAmount,
            _outputToken,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken
        );
    }

    /**
     * Trigger minting of Set token paying with any arbitrary ERC20 token.
     *
     * @param _setToken                     Set token to mint
     * @param _setAmount                    Amount to mint
     * @param _inputToken                   Input token to pay with
     * @param _maxAmountInputToken          Maximum amount of input token to spend
     * @param _swapDataDebtForCollateral    SwapData (token addresses and fee levels) to describe the swap path from debt to collateral token
     * @param _swapDataInputToken           SwapData (token addresses and fee levels) to describe the swap path from input to collateral token
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
    nonReentrant
    {
        _flashMint(
            _setToken,
            _setAmount,
            _inputToken,
            _maxAmountInputToken,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
    }

    /**
     * Trigger minting of set token paying with ETH.
     *
     * @param _setToken                     Set token to mint
     * @param _setAmount                    Amount to mint
     * @param _swapDataDebtForCollateral    SwapData (token addresses and fee levels) to describe the swap path from debt to collateral token
     * @param _swapDataInputToken           SwapData (token addresses and fee levels) to describe the swap path from eth to collateral token
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _setAmount,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
    external
    payable
    nonReentrant
    {
        _flashMint(
            _setToken,
            _setAmount,
            DEXAdapter.ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
    }

    /**
     * This is the callback function that will be called by the AaveLending Pool after flashloaned tokens have been sent
     * to this contract.
     * After exiting this function the Lending Pool will attempt to transfer back the loaned tokens + interest. If it fails to do so
     * the whole transaction gets reverted
     *
     * @param assets     Addresses of all assets that were borrowed
     * @param amounts    Amounts that were borrowed
     * @param premiums   Interest to be paid on top of borrowed amount
     * @param initiator  Address that initiated the flashloan
     * @param params     Encoded bytestring of other parameters from the original contract call to be used downstream
     *
     * @return           Boolean indicating success of the operation (fixed to true otherwise the whole transaction would be reverted by lending pool)
     */
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
        require(initiator == address(this), "FlashMint: INVALID FLASHLOAN INITIATOR");
        // assets.length must be 1.
        require(assets.length == 1, "FlashMint: TOO MANY ASSETS");
        require(amounts.length == 1, "FlashMint: TOO MANY AMOUNTS");
        require(premiums.length == 1, "FlashMint: TOO MANY PREMIUMS");
        
        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));

        if(decodedParams.isIssuance){
            _performMint(assets[0], amounts[0], premiums[0], decodedParams);
        } else {
            _performRedemption(assets[0], amounts[0], premiums[0], decodedParams);
        }

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
     * Runs all the necessary approval functions required before minting or redeeming a Set token. 
     * This function need to be called only once before the first time this smart contract is used
     * on any particular Set token.
     *
     * @param _setToken    Address of the SetToken being initialized
     */
    function approveSetToken(ISetToken _setToken) external {
        LeveragedTokenData memory leveragedTokenData = _updateCompoundRateAndGetLeveragedTokenData(_setToken, 1 ether, true);


        _approveToken(IERC20(leveragedTokenData.collateralCToken));
        _approveTokenToLendingPool(IERC20(leveragedTokenData.collateralToken));

        _approveToken(IERC20(leveragedTokenData.debtToken));
        _approveTokenToLendingPool(IERC20(leveragedTokenData.debtToken));
    }

    /* ============ Internal Functions ============ */

    /**
     * Performs all the necessary steps for minting using the collateral tokens obtained in the flashloan.
     *
     * @param _collateralToken            Address of the underlying collateral token that was loaned
     * @param _collateralTokenAmountNet   Amount of collateral token that was received as flashloan
     * @param _premium                    Premium / Interest that has to be returned to the lending pool on top of the loaned amount
     * @param _decodedParams              Struct containing token addresses / amounts to perform mint
     */
    function _performMint(
        address _collateralToken,
        uint256 _collateralTokenAmountNet,
        uint256 _premium,
        DecodedParams memory _decodedParams
    )
    internal
    {
        // Deposit collateral token obtained from flashloan to get the respective cToken position required for issuance
        _depositToCompound(_decodedParams.leveragedTokenData.collateralCToken, _collateralToken, _collateralTokenAmountNet);
        // Issue set using the cToken returned by deposit step
        _mintSet(_decodedParams.setToken, _decodedParams.setAmount, _decodedParams.originalSender);
        // Obtain necessary collateral tokens to repay flashloan
        uint amountInputTokenSpent = _obtainCollateralTokens(
            _collateralToken,
            _collateralTokenAmountNet + _premium,
            _decodedParams
        );
        require(amountInputTokenSpent <= _decodedParams.limitAmount, "FlashMint: INSUFFICIENT INPUT AMOUNT");
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

        _withdrawFromCompound(
            _decodedParams.leveragedTokenData.collateralCToken,
            _decodedParams.leveragedTokenData.cTokenAmount,
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.leveragedTokenData.collateralAmount
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
        require(amountOutputToken >= _decodedParams.limitAmount, "FlashMint: INSUFFICIENT OUTPUT AMOUNT");
    }


    /**
    * Returns the collateral / debt token addresses and amounts for a leveraged index
    *
    * @param _setToken      Address of the SetToken to be issued / redeemed
    * @param _setAmount     Amount of SetTokens to issue / redeem
    * @param _isMint        Boolean indicating if the SetToken is to be issued or redeemed
    *
    * @return Struct containing the collateral / debt token addresses and amounts
    */
    function _getBasicLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isMint
    )
    internal
    view
    returns (LeveragedTokenData memory)
    {
        address[] memory components;
        uint256[] memory equityPositions;
        uint256[] memory debtPositions;
        LeveragedTokenData memory _leveragedTokenData;

        if(_isMint){
            (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentIssuanceUnits(_setToken, _setAmount);
        } else {
            (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, _setAmount);
        }
        
        require(debtPositions[0] == 0 || debtPositions[1] == 0, "FlashMint: TOO MANY DEBT POSITIONS");

        if(equityPositions[0] > 0){
            _leveragedTokenData.collateralCToken = components[0];
            _leveragedTokenData.cTokenAmount = equityPositions[0];
            _leveragedTokenData.debtToken = components[1];
            _leveragedTokenData.debtAmount = debtPositions[1];
        } else {
            _leveragedTokenData.collateralCToken = components[1];
            _leveragedTokenData.cTokenAmount = equityPositions[1];
            _leveragedTokenData.debtToken = components[0];
            _leveragedTokenData.debtAmount = debtPositions[0];
        }
        if (_leveragedTokenData.collateralCToken == cEtherAddress) {
            _leveragedTokenData.collateralToken = addresses.weth;
        } else {
            _leveragedTokenData.collateralToken = CErc20Storage(_leveragedTokenData.collateralCToken).underlying();
        }
        return _leveragedTokenData; 
    }


    /**
    * Returns the collateral / debt token addresses and amounts for a leveraged index
    *
    * @param _setToken     Address of the Set token to be minted / redeemed
    * @param _setAmount    Amount to mint / redeem
    * @param _isMint       Boolean indicating if the Set token is to be issued/minted or redeemed
    *
    * @return Struct containing the collateral / debt token addresses and amounts
    */
    function _getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isMint
    )
    internal
    view
    returns (LeveragedTokenData memory)
    {
        LeveragedTokenData memory _leveragedTokenData = _getBasicLeveragedTokenData(_setToken, _setAmount, _isMint);
        Exp memory exchangeRate = Exp({mantissa: ICEther(payable(_leveragedTokenData.collateralCToken)).exchangeRateStored()});
        (, uint256 collateralAmount) = mulScalarTruncate(exchangeRate, _leveragedTokenData.cTokenAmount);
        _leveragedTokenData.collateralAmount = collateralAmount + ROUNDING_ERROR_MARGIN;
        return _leveragedTokenData; 
    }

    /**
    * Returns the collateral / debt token addresses and amounts for a leveraged index
    *
    * @param _setToken     Address of the Set token to be minted / redeemed
    * @param _setAmount    Amount to mint / redeem
    * @param _isMint       Boolean indicating if the Set token is to be issued/minted or redeemed
    *
    * @return Struct containing the collateral / debt token addresses and amounts
    */
    function _updateCompoundRateAndGetLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isMint
    )
    internal
    returns (LeveragedTokenData memory)
    {
        LeveragedTokenData memory _leveragedTokenData = _getBasicLeveragedTokenData(_setToken, _setAmount, _isMint);
        Exp memory exchangeRate = Exp({mantissa: ICEther(payable(_leveragedTokenData.collateralCToken)).exchangeRateCurrent()});
        (, uint256 collateralAmount) = mulScalarTruncate(exchangeRate, _leveragedTokenData.cTokenAmount);
        _leveragedTokenData.collateralAmount = collateralAmount + ROUNDING_ERROR_MARGIN;
        return _leveragedTokenData; 
    }


    /**
     * Approves max amount of given token to all exchange routers and the debt issuance module
     *
     * @param _token  Address of the token to be approved
     */
    function _approveToken(IERC20 _token) internal {
        _token.approve(address(debtIssuanceModule), MAX_UINT256);
    }

    /**
     * Initiates a flashloan call with the correct parameters for minting Set tokens in the callback
     * Borrows correct amount of collateral token and and forwards encoded memory to control mint in the callback.
     *
     * @param _setToken                     Set token to mint
     * @param _setAmount                    Amount to mint
     * @param _inputToken                   Input token to pay with
     * @param _maxAmountInputToken          Maximum amount of input token to spend
     * @param _swapDataDebtForCollateral    SwapData (token addresses and fee levels) to describe the swap path from debt to collateral token
     * @param _swapDataInputToken           SwapData (token addresses and fee levels) to describe the swap path from input to collateral token
     */
    function _flashMint(
        ISetToken _setToken,
        uint256 _setAmount,
        address _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapDataDebtForCollateral,
        DEXAdapter.SwapData memory _swapDataInputToken
    )
    internal
    {
        // need to check (true or false to issue)
        compoundLeverageModule.sync(_setToken, true);

        LeveragedTokenData memory leveragedTokenData = _updateCompoundRateAndGetLeveragedTokenData(_setToken, _setAmount, true);

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
     * Initiates a flashloan call with the correct parameters for redeeming Set tokens in the callback
     *
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _outputToken                Address of the output token to send to the user
     * @param _minAmountOutputToken       Minimum amount of output token to send to the user
     * @param _swapDataCollateralForDebt  SwapData (token path and fee levels) describing the swap from collateral token to debt token
     * @param _swapDataOutputToken        SwapData (token path and fee levels) describing the swap from collateral token to output token
     */
    function _flashRedeem(
        ISetToken _setToken,
        uint256 _setAmount,
        address  _outputToken,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapDataCollateralForDebt,
        DEXAdapter.SwapData memory _swapDataOutputToken
    )
    internal
    {   
        compoundLeverageModule.sync(_setToken, true);
        LeveragedTokenData memory leveragedTokenData = _updateCompoundRateAndGetLeveragedTokenData(_setToken, _setAmount, false);
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
     * Transfers output tokens to the user from redemption, if conversion is necessary,
     * exchanges collateral token for output token and then transfers them out.
     *
     * @param _collateralTokenSpent    Amount of collateral token spent to obtain the debt token required for redemption
     * @param _setToken                Set token to redeem
     * @param _setAmount               Amount to redeem
     * @param _originalSender          Account that initiated the redemption
     * @param _outputToken             Token to send to the user
     * @param _collateralToken         Collateral token to exchange for the output token
     * @param _collateralAmount        Amount to exchange
     * @param _minAmountOutputToken    Minimum amount of output token to send to the user
     * @param _swapData                SwapData (token path and fee levels) describing the swap from collateral token to output token
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
        require(_collateralAmount >= _collateralTokenSpent, "FlashMint: OVERSPENT COLLATERAL TOKEN");
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
        emit FlashRedeem(_originalSender, _setToken, _outputToken, _setAmount, outputAmount);
        return outputAmount;
    }

    /**
     * Returns the collateral token directly to the user.
     *
     * @param _collateralToken       Collateral token
     * @param _collateralRemaining   Amount of the collateral token remaining after buying required debt tokens
     * @param _originalSender        Original sender that is to receive the collateral token
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
     * Exchanges the collateral tokens for the output tokens and transfers them to the user.
     *
     * @param _collateralToken       Collateral token
     * @param _collateralRemaining   Amount of the collateral tokens remaining after buying required debt tokens
     * @param _originalSender        Original sender that is to receive the output tokens
     * @param _outputToken           ERC20 token to return to the user
     * @param _minAmountOutputToken  Minimum amount of output token to send to the user
     * @param _swapData              SwapData (token path and fee levels) describing the swap from collateral token to output token
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
     * Exchanges the remaining collateral tokens for weth, unwraps that weth and returns native eth to the user.
     *
     * @param _collateralToken            Collateral token
     * @param _collateralRemaining        Amount of the collateral tokens remaining after buying required debt tokens
     * @param _originalSender             Original sender that is to receive the native eth
     * @param _minAmountOutputToken       Minimum amount of native eth to send to the user
     * @param _swapData                   SwapData (token path and fee levels) describing the swap from collateral token to eth
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
     * Obtains the collateral tokens necessary to return the flashloan by swapping the debt tokens obtained
     * from mint and making up the shortfall using the users funds.
     *
     * @param _collateralToken       Collateral token
     * @param _amountRequired        Amount required to repay the flashloan
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
        emit FlashMint(
            _decodedParams.originalSender,
            _decodedParams.setToken,
            _decodedParams.paymentToken,
            amountInputToken,
            _decodedParams.setAmount
        );
        return amountInputToken;
    }

    /**
     * Mints Set tokens using the previously obtained collateral token.
     * Results in debt tokens being returned to the contract.
     *
     * @param _setToken         Set token to mint
     * @param _setAmount        Amount to mint
     * @param _originalSender   Account that initiated the mint, which will receive the set tokens
     */
    function _mintSet(ISetToken _setToken, uint256 _setAmount, address _originalSender) internal {
       
        debtIssuanceModule.issue(_setToken, _setAmount, _originalSender);
    }

    /**
     * Redeems Set tokens using the previously obtained debt token.
     * Results in collateral tokens being returned to the contract.
     *
     * @param _setToken         Set token to redeem
     * @param _setAmount        Amount to redeem
     * @param _originalSender   Adress that initiated the redemption which is the source of the set tokens to be redeemed
     */
    function _redeemSet(ISetToken _setToken, uint256 _setAmount, address _originalSender) internal {
        _setToken.safeTransferFrom(_originalSender, address(this), _setAmount);
        debtIssuanceModule.redeem(_setToken, _setAmount, address(this));
    }

    /**
     * Transfers the shortfall between the amount of tokens required to return flashloan and what was obtained
     * from swapping the debt tokens from the users address.
     *
     * @param _token                 Set token to exchange shortfall
     * @param _shortfall             Amount of tokens that the tx is short
     * @param _originalSender        Account of originator, transfer the Set tokens from that account
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
     * Makes up the collateral token shortfall with user specified ERC20 token.
     *
     * @param _collateralToken             Collateral token
     * @param _collateralTokenShortfall    Amount of tokens that the tx is short after selling debt tokens
     * @param _originalSender              Originator account to return the tokens to
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
     * Makes up the collateral token shortfall with native eth.
     *
     * @param _collateralToken             Collateral token
     * @param _collateralTokenShortfall    Amount of tokens that the tx is short after selling debt tokens
     * @param _originalSender              Originator account to return the tokens to
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
     * Swaps the debt tokens obtained from minting for the collateral tokens.
     *
     * @param _collateralToken            Collateral token to buy
     * @param _debtToken                  Debt token to sell
     * @param _debtAmount                 Amount of debt token to sell
     * @param _swapData                   SwapData (token path and fee levels) describing the swap from debt token to collateral token
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
     * Acquires debt tokens needed for flashloan repayment by swapping a portion of the collateral tokens obtained from redemption.
     *
     * @param _debtAmount             Amount of debt token to buy
     * @param _debtToken              Debt token
     * @param _collateralAmount       Amount of collateral token available (eg. maxAmountIn)
     * @param _collateralToken        Collateral token
     * @param _swapData               SwapData (token path and fee levels) describing the swap from collateral token to debt token
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
     * Acquires the required amount of collateral tokens by exchanging the input tokens.
     * Does nothing if collateral and input token are indentical.
     *
     * @param _collateralToken       Collateral token
     * @param _amountRequired        Amount required to repay the flashloan
     * @param _inputToken            Input token
     * @param _maxAmountInputToken   Maximum amount of input token to spend
     * @param _swapData              SwapData (token path and fee levels) describing the swap from input token to debt token
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
     * @param _collateralToken        Collateral token
     * @param _collateralTokenAmount  Amount to swap
     * @param _outputToken            ERC20 token to swap into
     * @param _minAmountOutputToken   Minimum amount of output token to receive
     * @param _swapData               SwapData (token path and fee levels) describing the swap from collateral token to output token
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
     * Deposit collateral to compound to obtain collateralCToken for mint.
     *
     * @param _cTokenAddress                cToken
     * @param _collateralToken              Collateral token
     * @param _depositAmount                Amount to deposit
     */
    function _depositToCompound(
        address _cTokenAddress,
        address _collateralToken,
        uint256 _depositAmount
    ) internal {
        if (_collateralToken != addresses.weth) {
            IERC20(_collateralToken).approve(_cTokenAddress, _depositAmount);
            ICErc20Delegator(_cTokenAddress).mint(_depositAmount);
        } else {
            IWETH(addresses.weth).withdraw(_depositAmount);
            ICEther(payable(_cTokenAddress)).mint{value: _depositAmount}();
        }
    }

    /**
     * Redeem Compound cToken for underlying collateral.  
     *
     * @param _cTokenAddress         cToken
     * @param _cTokenAmount          Amount to redeem
     * @param _collateralToken       Collateral token to withdraw
     * @param _collateralAmount      If collateral is ETH (eg. cETH), conver this amount to WETH.
     */
    function _withdrawFromCompound(
        address _cTokenAddress,
        uint256 _cTokenAmount,
        address _collateralToken,
        uint256 _collateralAmount
    ) internal returns (uint256){
        uint256 result;
        if (_collateralToken != addresses.weth) {
            result = ICErc20Delegator(_cTokenAddress).redeem(_cTokenAmount);
        } else {
            result = ICEther(payable(_cTokenAddress)).redeem(_cTokenAmount);
            IWETH(addresses.weth).deposit{value: (_collateralAmount - ROUNDING_ERROR_MARGIN)}();
        }
        return result;
    }


    /**
     * Approves max amount of token to Lending Pool.
     *
     * @param _token              Address of the token to approve
     */
    function _approveTokenToLendingPool(
        IERC20 _token
    )
    internal
    {
        _token.approve(address(LENDING_POOL), MAX_UINT256);
    }

    /**
     * Triggers the flashloan from the Lending Pool
     *
     * @param assets         Tokens to borrow 
     * @param amounts        Amounts of tokens to borrow
     * @param params         Encoded memory to forward to the executeOperation method
     */
    function _flashloan(
        address[] memory assets,
        uint256[] memory amounts,
        bytes memory params
    )
    internal
    {
        address receiverAddress = address(this);
        address onBehalfOf = address(this);
        uint16 referralCode = 0;
        uint256[] memory modes = new uint256[](assets.length);

        // 0 = no debt (flash), 1 = stable, 2 = variable
        for (uint256 i = 0; i < assets.length; i++) {
            modes[i] = 0;
        }

        LENDING_POOL.flashLoan(
            receiverAddress,
            assets,
            amounts,
            modes,
            onBehalfOf,
            params,
            referralCode
        );
    }

}
