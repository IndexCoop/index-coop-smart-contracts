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
import { IUniswapV2Router02 } from "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAToken } from "../interfaces/IAToken.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { UniSushiV2Library } from "../../external/contracts/UniSushiV2Library.sol";
import { FlashLoanReceiverBaseV2 } from "../../external/contracts/aaveV2/FlashLoanReceiverBaseV2.sol";


/**
 * @title ExchangeIssuance
 * @author Index Coop
 *
 * Contract for issuing and redeeming a leveraged Set Token
 * Supports all tokens with one collateral Position in the form of an AToken and one debt position
 * Both the underlying of the collateral as well as the debt token have to be available for flashloand and be 
 * tradeable against each other on Sushi / Quickswap
 *
 */
contract ExchangeIssuanceLeveraged is ReentrancyGuard, FlashLoanReceiverBaseV2 {

    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Enums ============ */

    enum Exchange { None, Quickswap, Sushiswap}

    /* ============ Structs ============ */
    struct DecodedParams {
        ISetToken setToken;
        uint256 setAmount;
        address originalSender;
        bool isIssuance;
        Exchange exchange;
        address paymentToken;
        uint256 limitAmount;
    }

    /* ============ Constants ============= */

    uint256 constant private MAX_UINT256 = type(uint256).max;
    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    // Token to trade via 
    address immutable public INTERMEDIATE_TOKEN;
    // Wrapped native token (WMATIC on polygon)
    address immutable public WETH;
    IUniswapV2Router02 immutable public quickRouter;
    IUniswapV2Router02 immutable public sushiRouter;


    IController public immutable setController;
    IDebtIssuanceModule public immutable debtIssuanceModule;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        address indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        address indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    /* ============ Modifiers ============ */

    modifier isSetToken(ISetToken _setToken) {
         require(setController.isSet(address(_setToken)), "ExchangeIssuance: INVALID SET");
         _;
    }

    modifier onlyLendingPool() {
         require(msg.sender == address(LENDING_POOL), "ExchangeIssuance: LENDING POOL ONLY");
         _;
    }

    /* ============ Constructor ============ */

    /**
    * Sets various contract addresses and approves intermediate token to the routers
    * 
    * @param _weth                  Address of wrapped native token
    * @param _intermediateToken     Address of high liquidity token to trade via
    * @param _quickRouter           Address of quickswap router
    * @param _sushiRouter           Address of sushiswap router
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _debtIssuanceModule    DebtIssuanceModule used to issue and redeem tokens
    * @param _addressProvider       Address of DebtIssuanceModule used to issue and redeem tokens
    */
    constructor(
        address _weth,
        address _intermediateToken,
        IUniswapV2Router02 _quickRouter,
        IUniswapV2Router02 _sushiRouter,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        address _addressProvider
    )
        public
        FlashLoanReceiverBaseV2(_addressProvider)
    {
        quickRouter = _quickRouter;

        sushiRouter = _sushiRouter;

        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;

        WETH = _weth;
        IERC20(_weth).safeApprove(address(_quickRouter), PreciseUnitMath.maxUint256());
        IERC20(_weth).safeApprove(address(_sushiRouter), PreciseUnitMath.maxUint256());

        INTERMEDIATE_TOKEN = _intermediateToken;
        if(_intermediateToken != _weth) {
            IERC20(_intermediateToken).safeApprove(address(_quickRouter), PreciseUnitMath.maxUint256());
            IERC20(_intermediateToken).safeApprove(address(_sushiRouter), PreciseUnitMath.maxUint256());
        }
    }

    /* ============ External Functions ============ */


    /**
    * Returns the long / short token addresses and amounts for a leveraged index 
    *
    * @param _setToken              Address of the SetToken to be issued / redeemed
    * @param _amountSetToken        Amount of SetTokens to issue / redeem
    * @param _isIssuance            Boolean indicating if the SetToken is to be issued or redeemed
    *
    * @return longToken             Address of long token (AToken)
    * @return longAmount            Amount of long Token (required for issuance / returned for redemption)
    * @return shortToken            Address of short token
    * @return shortAmount           Amount of short Token (required for redemption / returned for issuance)
    */
    function getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _amountSetToken,
        bool _isIssuance
    )
        isSetToken(_setToken)
        external 
        view
        returns (address longToken, uint256 longAmount, address shortToken, uint256 shortAmount)
    {
        return _getLeveragedTokenData(_setToken, _amountSetToken, _isIssuance);
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
     * Trigger redemption of set token to pay the user with Eth
     *
     * @param _setToken               Set token to redeem
     * @param _amountSetToken         Amount to redeem
     * @param _minAmountOutputToken   Minimum amount of ETH to send to the user
     * @param _exchange               Exchange to use in swap from short to long token
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minAmountOutputToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        _initiateRedemption(_setToken, _amountSetToken, _exchange, ETH_ADDRESS, _minAmountOutputToken);
    }

    /**
     * Trigger redemption of set token to pay the user with an arbitrary ERC20 
     *
     * @param _setToken               Set token to redeem
     * @param _amountSetToken         Amount to redeem
     * @param _outputToken            Address of the ERC20 token to send to the user
     * @param _minAmountOutputToken   Minimum amount of output token to send to the user
     * @param _exchange               Exchange to use in swap from short to long token
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _outputToken,
        uint256 _minAmountOutputToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        _initiateRedemption(_setToken, _amountSetToken, _exchange, _outputToken, _minAmountOutputToken);
    }

    /**
     * Trigger issuance of set token paying with any arbitrary ERC20 token
     *
     * @param _setToken            Set token to issue
     * @param _amountSetToken      Amount to issue
     * @param _inputToken          Input token to pay with
     * @param _maxAmountInputToken Maximum amount of input token to spend
     * @param _exchange            Exchange to use in swap from short to long token
     */
    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _inputToken,
        uint256 _maxAmountInputToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        _initiateIssuance(_setToken, _amountSetToken, _exchange, _inputToken, _maxAmountInputToken);
    }

    /**
     * Trigger issuance of set token paying with Eth
     *
     * @param _setToken            Set token to issue
     * @param _amountSetToken      Amount to issue
     * @param _exchange            Exchange to use in swap from short to long token
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        payable
        nonReentrant
    {
        _initiateIssuance(_setToken, _amountSetToken, _exchange, ETH_ADDRESS, msg.value);
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
     * @param params     Encoded bytestring of other parameters from the original contract call to be used downstream
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address , 
        bytes calldata params
    )
    external
    override 
    onlyLendingPool
    returns (bool)
    {
        require(assets.length == 1, "Exchange Issuance Leveraged: TOO MANY ASSETS");
        require(amounts.length == 1, "Exchange Issuance Leveraged: TOO MANY AMOUNTS");
        require(premiums.length == 1, "Exchange Issuance Leveraged: TOO MANY PREMIUMS");

        DecodedParams memory decodedParams = abi.decode(params, (DecodedParams));
        if(decodedParams.isIssuance){
            // Deposit long token obtained from flashloan to get the respective aToken position required for issuance
            _depositLongToken(assets[0], amounts[0]);
            // Issue set using the aToken returned by deposit step
            _issueSet(decodedParams.setToken, decodedParams.setAmount, decodedParams.originalSender);
            // Obtain necessary long tokens to repay flashloan 
            _obtainLongTokens(
                assets[0],
                amounts[0] + premiums[0],
                decodedParams.setToken,
                decodedParams.setAmount,
                decodedParams.originalSender,
                decodedParams.exchange,
                decodedParams.paymentToken,
                decodedParams.limitAmount
            );
        } else {
            // Redeem set using short tokens obtained from flashloan
            _redeemSet(decodedParams.setToken, decodedParams.setAmount, decodedParams.originalSender);
            // Withdraw underlying long token from the aToken position returned by redeem step
            _withdrawLongToken(decodedParams.setToken, decodedParams.setAmount);
            // Obtain short tokens required to repay flashloan by swapping the underlying long tokens obtained in withdraw step
            uint256 longTokenSpent = _swapLongForShortToken(
                decodedParams.setToken,
                decodedParams.setAmount,
                amounts[0] + premiums[0],
                assets[0],
                decodedParams.exchange
            );
            // Liquidate remaining long tokens for the payment token specified by user
            _liquidateLongTokens(
                longTokenSpent,
                decodedParams.setToken,
                decodedParams.setAmount,
                decodedParams.originalSender,
                decodedParams.exchange,
                decodedParams.paymentToken,
                decodedParams.limitAmount
            );
        }

        return true;
    }

    /**
     * Runs all the necessary approval functions required for a list of ERC20 tokens.
     *
     * @param _tokens    Addresses of the tokens which need approval
     */
    function approveTokens(IERC20[] calldata _tokens) external {
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
    function approveSetToken(ISetToken _setToken) isSetToken(_setToken) external {
        (address longToken,,address shortToken,) = _getLeveragedTokenData(_setToken, 1 ether, true);
        _approveToken(IERC20(longToken));

        IERC20 underlyingLongToken = IERC20(IAToken(longToken).UNDERLYING_ASSET_ADDRESS());
        _approveTokenToLendingPool(underlyingLongToken);

        _approveToken(IERC20(shortToken));
        _approveTokenToLendingPool(IERC20(shortToken));
    }

    /* ============ Internal Functions ============ */

    function _getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _amountSetToken,
        bool _isIssuance
    )
        internal 
        view
        returns (address longToken, uint256 longAmount, address shortToken, uint256 shortAmount)
    {
            address[] memory components;
            uint256[] memory equityPositions;
            uint256[] memory debtPositions;

            if(_isIssuance){
                (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);
            } else {
                (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, _amountSetToken);
            }

            require(components.length == 2, "ExchangeIssuance: TOO MANY COMPONENTS");
            require(equityPositions[0] == 0 || equityPositions[1] == 0, "ExchangeIssuance: TOO MANY EQUITY POSITIONS");
            require(debtPositions[0] == 0 || debtPositions[1] == 0, "ExchangeIssuance: TOO MANY DEBT POSITIONS");

            if(equityPositions[0] > 0){
                longToken = components[0];
                longAmount = equityPositions[0];
                shortToken = components[1];
                shortAmount = debtPositions[1];
            } else {
                longToken = components[1];
                longAmount = equityPositions[1];
                shortToken = components[0];
                shortAmount = debtPositions[0];
            }
    }



    function _approveToken(IERC20 _token) internal {
        _safeApprove(_token, address(quickRouter), MAX_UINT256);
        _safeApprove(_token, address(sushiRouter), MAX_UINT256);
        _safeApprove(_token, address(debtIssuanceModule), MAX_UINT256);
    }

    /**
     * Initiates a flashloan call with the correct parameters for issuing set tokens in the callback
     * Borrows correct amount of long token and and forwards encoded calldata to controll issuance in the callback.
     *
     * @param _setToken                     Address of the SetToken being initialized
     * @param _amountSetToken               Amount of the SetToken being initialized
     * @param _inputToken                   Address of the input token to pay with
     * @param _maxAmountInputToken          Maximum amount of input token to pay
     */
    function _initiateIssuance(
        ISetToken _setToken,
        uint256 _amountSetToken,
        Exchange _exchange,
        address _inputToken,
        uint256 _maxAmountInputToken
    )
        isSetToken(_setToken)
        internal
        returns (uint256)
    {
        (address longToken, uint256 longAmount,,) = _getLeveragedTokenData(_setToken, _amountSetToken, true);

        address[] memory assets = new address[](1);
        assets[0] = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        uint[] memory amounts =  new uint[](1);
        amounts[0] = longAmount;

        bytes memory params = abi.encode(DecodedParams(_setToken, _amountSetToken, msg.sender, true, _exchange, _inputToken, _maxAmountInputToken));

        _flashloan(assets, amounts, params);

    }

    /**
     * Initiates a flashloan call with the correct parameters for redeeming set tokens in the callback
     *
     * @param _setToken            Address of the SetToken to redeem
     * @param _amountSetToken      Amount of the SetToken to redeem
     * @param _outputToken         Address of token to return to the user
     */
    function _initiateRedemption(
        ISetToken _setToken,
        uint256 _amountSetToken,
        Exchange _exchange,
        address  _outputToken,
        uint256 _minAmountOutputToken
    )
        isSetToken(_setToken)
        internal
        returns (uint256)
    {
        (,,address shortToken, uint256 shortAmount) = _getLeveragedTokenData(_setToken, _amountSetToken, false);

        address[] memory assets = new address[](1);
        assets[0] = shortToken;
        uint[] memory amounts =  new uint[](1);
        amounts[0] = shortAmount;

        bytes memory params = abi.encode(DecodedParams(_setToken, _amountSetToken, msg.sender, false, _exchange, _outputToken, _minAmountOutputToken));

        _flashloan(assets, amounts, params);

    }

    /**
     * Gets rid of the obtained long tokens from redemption by either sending them to the user
     * directly or converting them to the payment token and sending those out.
     *
     * @param _longTokenSpent          Amount of long token spent to obtain the short token required for redemption
     * @param _setToken                Address of the SetToken to be issued
     * @param _setAmount               Amount of SetTokens to issue
     * @param _originalSender          Address of the user who initiated the redemption
     * @param _exchange                Exchange to use for swap
     * @param _outputToken             Address of token to return to the user
     * @param _minAmountOutputToken    Minimum amount of output token to return to the user
     */
    function _liquidateLongTokens(
        uint256 _longTokenSpent,
        ISetToken _setToken,
        uint256 _setAmount,
        address _originalSender,
        Exchange _exchange,
        address _outputToken,
        uint256 _minAmountOutputToken
    )
    internal
    {
        (address longToken , uint256 longAmount,,) = _getLeveragedTokenData(_setToken, _setAmount, false);
        address longTokenUnderlying = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        require(longAmount >= _longTokenSpent, "ExchangeIssuance: OVERSPENT LONG TOKEN");
        uint256 amountToReturn = longAmount.sub(_longTokenSpent);
        uint256 outputAmount;
        if(_outputToken == ETH_ADDRESS){
            outputAmount = _liquidateLongTokensForETH(longTokenUnderlying, amountToReturn, _exchange, _originalSender, _minAmountOutputToken);
        } else {
            outputAmount = _liquidateLongTokensForERC20(longTokenUnderlying, amountToReturn, _exchange, _originalSender, IERC20(_outputToken), _minAmountOutputToken);
        }
        emit ExchangeRedeem(_originalSender, _setToken, _outputToken, _setAmount, outputAmount);
    }

    /**
     * Returns underlying of the longToken directly to the user
     *
     * @param _longTokenUnderlying   Address of the underlying of the long token
     * @param _amountToReturn        Amount of the underlying long token to return
     * @param _originalSender        Address of the original sender to return the tokens to
     * @param _minAmountOutputToken  Minimum amount of output token to return to the user
     */
    function _returnLongTokensToSender(
        address _longTokenUnderlying,
        uint256 _amountToReturn,
        address _originalSender,
        uint256 _minAmountOutputToken
    )
    internal
    {
            require(_amountToReturn >= _minAmountOutputToken, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");
            IERC20(_longTokenUnderlying).transfer(_originalSender, _amountToReturn);
    }

    /**
     * Sells the long tokens for the selected output ERC20 and returns that to the user
     *
     * @param _longTokenUnderlying   Address of the underlying of the long token
     * @param _amountToReturn        Amount of the underlying long token to return
     * @param _exchange              Enum indicating which exchange to use
     * @param _originalSender        Address of the original sender to return the tokens to
     * @param _outputToken             Address of token to return to the user
     * @param _minAmountOutputToken    Minimum amount of output token to return to the user
     */
    function _liquidateLongTokensForERC20(
        address _longTokenUnderlying,
        uint256 _amountToReturn,
        Exchange _exchange,
        address _originalSender,
        IERC20 _outputToken,
        uint256 _minAmountOutputToken
    )
    internal
    returns(uint256)
    {

            if(address(_outputToken) == _longTokenUnderlying){
                _returnLongTokensToSender(_longTokenUnderlying, _amountToReturn, _originalSender, _minAmountOutputToken);
                return _amountToReturn;
            }

            uint256 outputTokenAmount = _swapLongForOutputToken(_longTokenUnderlying, _amountToReturn, address(_outputToken), _exchange);
            require(outputTokenAmount >= _minAmountOutputToken, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");
            _outputToken.transfer(_originalSender, outputTokenAmount);
            return outputTokenAmount;
    }

    /**
     * Sells the long tokens for weth, withdraws that and returns native eth to the user
     *
     * @param _longTokenUnderlying   Address of the underlying of the long token
     * @param _amountToReturn        Amount of the underlying long token to return
     * @param _exchange              Enum indicating which exchange to use
     * @param _originalSender        Address of the original sender to return the eth to
     * @param _minAmountOutputToken  Minimum amount of output token to return to user
     */
    function _liquidateLongTokensForETH(
        address _longTokenUnderlying,
        uint256 _amountToReturn,
        Exchange _exchange,
        address _originalSender,
        uint256 _minAmountOutputToken
    )
    internal
    returns(uint256)
    {
            uint256 ethAmount = _swapLongForOutputToken(_longTokenUnderlying, _amountToReturn, WETH, _exchange);
            require(ethAmount >= _minAmountOutputToken, "ExchangeIssuance: INSUFFICIENT OUTPUT AMOUNT");
            if (ethAmount > 0) {
                IWETH(WETH).withdraw(ethAmount);
                (payable(_originalSender)).sendValue(ethAmount);
            }
            return ethAmount;
    }

    /**
     * Obtains the tokens necessary to return the flashloan by swapping the short tokens obtained
     * from issuance and making up the shortfall using the users funds.
     *
     * @param _longTokenUnderlying   Underlying token of the collateral AToken, which is the token to be returned
     * @param _amountRequired        Amount of longTokenUnderlying required to repay the flashloan
     * @param _setToken              Address of the SetToken to be issued
     * @param _setAmount             Amount of SetTokens to issue
     * @param _originalSender        Address of the user who initiated the redemption
     * @param _exchange              Exchange to use for swap
     * @param _inputToken            Input token to pay with
     * @param _maxAmountInputToken   Maximum amount of input token to spend
     */
    function _obtainLongTokens(
        address _longTokenUnderlying,
        uint256 _amountRequired,
        ISetToken _setToken,
        uint256 _setAmount,
        address _originalSender,
        Exchange _exchange,
        address _inputToken,
        uint256 _maxAmountInputToken
    ) internal {
        uint longTokenObtained = _swapShortForLongTokenUnderlying(_setToken, _setAmount, _longTokenUnderlying, _exchange);
        uint longTokenShortfall = _amountRequired.sub(longTokenObtained);
        uint amountInputToken;
        if(_inputToken == ETH_ADDRESS){
            amountInputToken = _makeUpShortfallWithETH(_longTokenUnderlying, longTokenShortfall, _exchange, _originalSender, _maxAmountInputToken);
        } else {
            amountInputToken = _makeUpShortfallWithERC20(
                _longTokenUnderlying,
                longTokenShortfall,
                _exchange,
                _originalSender,
                IERC20(_inputToken),
                _maxAmountInputToken
            );
        }
        emit ExchangeIssue(_originalSender, _setToken, _inputToken, amountInputToken, _setAmount);
    }

    function _issueSet(ISetToken _setToken, uint256 _setAmount, address _originalSender) internal {
        debtIssuanceModule.issue(_setToken, _setAmount, _originalSender);
    }

    function _redeemSet(ISetToken _setToken, uint256 _setAmount, address _originalSender) internal {
        _setToken.safeTransferFrom(_originalSender, address(this), _setAmount);
        debtIssuanceModule.redeem(_setToken, _setAmount, address(this));
    }

    /**
     * Transfers the shortfall between the amount of tokens required to return flashloan and what was obtained
     * from swapping the debt tokens from the users address
     *
     * @param _token                 Address of the token to transfer from user
     * @param _shortfall             Long token shortfall required to return the flashloan
     * @param _originalSender        Adress that initiated the token issuance, which is the adresss form which to transfer the tokens
     */
    function _transferShortfallFromSender(
        address _token,
        uint256 _shortfall,
        address _originalSender,
        uint256 _maxAmountInputToken
    )
    internal
    {
        if(_shortfall>0){ 
            require(_shortfall <= _maxAmountInputToken, "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT");
            IERC20(_token).safeTransferFrom(_originalSender, address(this), _shortfall);
        }
    }

    /**
     * Makes up the long token shortfall with user specified ERC20 token
     *
     * @param _longTokenUnderlying   Address of the underlying of the long token
     * @param _longTokenShortfall    Shortfall of long token that was not covered by selling the short tokens
     * @param _exchange              Enum indicating which exchange to use
     * @param _originalSender        Address of the original sender to return the tokens to
     * @param _inputToken            Input token to pay with
     * @param _maxAmountInputToken   Maximum amount of input token to spend
     */
    function _makeUpShortfallWithERC20(
        address _longTokenUnderlying,
        uint256 _longTokenShortfall,
        Exchange _exchange,
        address _originalSender,
        IERC20 _inputToken,
        uint256 _maxAmountInputToken
    )
    internal
    returns(uint256)
    {
        if(address(_inputToken) == _longTokenUnderlying){
            _transferShortfallFromSender(_longTokenUnderlying, _longTokenShortfall, _originalSender, _maxAmountInputToken);
            return _longTokenShortfall;
        } else {
            _inputToken.transferFrom(_originalSender, address(this), _maxAmountInputToken);
            uint256 amountInputToken = _swapInputForLongToken(
                _longTokenUnderlying,
                _longTokenShortfall,
                address(_inputToken),
                _maxAmountInputToken,
                _exchange
            );
            require(amountInputToken <= _maxAmountInputToken, "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT");
            if(amountInputToken < _maxAmountInputToken){
                _inputToken.transfer(_originalSender, _maxAmountInputToken.sub(amountInputToken));
            }
            return amountInputToken;
        }
    }

    /**
     * Makes up the long token shortfall with native eth
     *
     * @param _longTokenUnderlying   Address of the underlying of the long token
     * @param _longTokenShortfall    Shortfall of long token that was not covered by selling the short tokens
     * @param _exchange              Enum indicating which exchange to use
     * @param _originalSender        Address of the original sender to return the tokens to
     * @param _maxAmountEth          Maximum amount of eth to pay
     */
    function _makeUpShortfallWithETH(
        address _longTokenUnderlying,
        uint256 _longTokenShortfall,
        Exchange _exchange,
        address _originalSender,
        uint256 _maxAmountEth
    )
    internal
    returns(uint256)
    {
        IWETH(WETH).deposit{value: _maxAmountEth}();
        uint256 amountEth = _swapInputForLongToken(_longTokenUnderlying, _longTokenShortfall, WETH, _maxAmountEth, _exchange);
        require(_maxAmountEth >= amountEth, "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT");
        if(_maxAmountEth > amountEth){
            uint256 amountEthReturn = _maxAmountEth.sub(amountEth);
            IWETH(WETH).withdraw(amountEthReturn);
            (payable(_originalSender)).sendValue(amountEthReturn);
        }
        return amountEth;
    }

    /**
     * Swaps the debt tokens obtained from issuance for the underlying of the collateral
     *
     * @param _setToken                   Address of the SetToken to be issued
     * @param _setAmount                  Amount of SetTokens to issue
     * @param _longTokenUnderlying        Address of the underlying of the collateral token
     */
    function _swapShortForLongTokenUnderlying(
        ISetToken _setToken,
        uint256 _setAmount,
        address _longTokenUnderlying,
        Exchange _exchange
    )
    internal
    returns (uint256)
    {
        (, , address shortToken, uint shortAmount) = _getLeveragedTokenData(_setToken, _setAmount, true);
        return _swapExactTokensForTokens(_exchange, shortToken, _longTokenUnderlying, shortAmount);
    }

    /**
     * Swaps the debt tokens obtained from issuance for the underlying of the collateral
     *
     */
    function _swapLongForShortToken(
        ISetToken _setToken,
        uint256 _setAmount,
        uint256 _amountRequired,
        address _shortToken,
        Exchange _exchange
    )
    internal
    returns (uint256 longAmountSpent)
    {
        (address longToken, uint longAmount,,) = _getLeveragedTokenData(_setToken, _setAmount, false);
        address longTokenUnderlying = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        longAmountSpent = _swapTokensForExactTokens(_exchange, longTokenUnderlying, _shortToken, _amountRequired, longAmount);
    }

    function _swapInputForLongToken(
        address _longTokenUnderlying,
        uint256 _amountRequired,
        address _inputToken,
        uint256 _maxAmountInputToken,
        Exchange _exchange
    )
    internal
    returns (uint256 inputAmountSpent)
    {
        if(_longTokenUnderlying == _inputToken) return _amountRequired;
        inputAmountSpent = _swapTokensForExactTokens(_exchange, _inputToken, _longTokenUnderlying, _amountRequired, _maxAmountInputToken);
    }

    /**
     * Swaps the debt tokens obtained from issuance for the underlying of the collateral
     *
     */
    function _swapLongForOutputToken(
        address _longTokenUnderlying,
        uint256 _longTokenAmount,
        address _outputToken,
        Exchange _exchange
    )
    internal
    returns (uint256)
    {
        if(_longTokenUnderlying == _outputToken) return _longTokenAmount;
        return _swapExactTokensForTokens(_exchange, _longTokenUnderlying, _outputToken, _longTokenAmount);
    }



    /**
     * Deposit underlying of collateral to obtain actual collateral token for issuance
     *
     * @param _longTokenUnderlying    Address of underlying of the collateral token
     * @param _depositAmount          Amount to deposit
     */
    function _depositLongToken(
        address _longTokenUnderlying,
        uint256 _depositAmount
    ) internal {
        LENDING_POOL.deposit(_longTokenUnderlying, _depositAmount, address(this), 0);
    }

    /**
     * withdraw underlying of collateral 
     *
     */
    function _withdrawLongToken(
        ISetToken _setToken,
        uint256 _setAmount
    ) internal {
        (address longToken, uint256 longAmount,,) = _getLeveragedTokenData(_setToken, _setAmount, false);
        address longTokenUnderlying = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        LENDING_POOL.withdraw(longTokenUnderlying, longAmount, address(this));
    }


    /**
     * Approves max amount of token to lending pool
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
     * Triggers the flashloan from the Lending Pool
     *
     * @param assets  Addresses of tokens to loan 
     * @param amounts Amounts to loan
     * @param params  Encoded calldata to forward to the executeOperation method
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
    /**
     * Sets a max approval limit for an ERC20 token, provided the current allowance
     * is less than the required allownce.
     *
     * @param _token    Token to approve
     * @param _spender  Spender address to approve
     */
    function _safeApprove(IERC20 _token, address _spender, uint256 _requiredAllowance) internal {
        uint256 allowance = _token.allowance(address(this), _spender);
        if (allowance < _requiredAllowance) {
            _token.safeIncreaseAllowance(_spender, MAX_UINT256 - allowance);
        }
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

    /**
     * Swap exact tokens for another token on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountIn     The amount of input token to be spent
     *
     * @return              The amount of output tokens
     */
    function _swapExactTokensForTokens(
        Exchange _exchange,
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn
    )
    internal
    returns (uint256)
    {
        if (_tokenIn == _tokenOut) {
            return _amountIn;
        }

        address[] memory path = _generatePath(_tokenIn, _tokenOut);
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(_tokenIn), address(router), _amountIn);
        //TODO: Review if we have to set a non-zero minAmountOut
        return router.swapExactTokensForTokens(_amountIn, 0, path, address(this), block.timestamp)[1];
    }

    /**
     * Swap tokens for exact amount of output tokens on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountOut    The amount of output token required
     * @param _maxAmountIn  Maximum amount of input token to be spent
     *
     * @return              The amount of input tokens spent
     */
    function _swapTokensForExactTokens(
        Exchange _exchange,
        address _tokenIn,
        address _tokenOut,
        uint256 _amountOut,
        uint256 _maxAmountIn
    )
    internal
    returns (uint256)
    {
        if (_tokenIn == _tokenOut) {
            return _amountOut;
        }
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(_tokenIn), address(router), _maxAmountIn);
        address[] memory path = _generatePath(_tokenIn, _tokenOut);
        uint256 result = router.swapTokensForExactTokens(_amountOut, _maxAmountIn, path, address(this), block.timestamp)[0];
        return result;
    }

    function _generatePath(address _tokenIn, address _tokenOut) internal view returns (address[] memory) {
        address[] memory path;
        if(_tokenIn == INTERMEDIATE_TOKEN || _tokenOut == INTERMEDIATE_TOKEN){
            path = new address[](2);
            path[0] = _tokenIn;
            path[1] = _tokenOut;
        } else {
            path = new address[](3);
            path[0] = _tokenIn;
            path[1] = INTERMEDIATE_TOKEN;
            path[2] = _tokenOut;
        }
        return path;
    }

    /**
     * Returns the router address of a given exchange.
     *
     * @param _exchange     The Exchange whose router address is needed
     *
     * @return              IUniswapV2Router02 router of the given exchange
     */
     function _getRouter(Exchange _exchange) internal view returns(IUniswapV2Router02) {
         return (_exchange == Exchange.Quickswap) ? quickRouter : sushiRouter;
     }
}
