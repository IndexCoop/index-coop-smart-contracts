/*
    Copyright 2021 Index Cooperative
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
import { IUniswapV2Factory } from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
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
 * tradeable against each other on Sushi / Uniswap
 *
 */
contract ExchangeIssuanceLeveraged is ReentrancyGuard, FlashLoanReceiverBaseV2 {

    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Enums ============ */

    enum Exchange { None, Uniswap, Sushiswap}
    // Call parameter to control which token is used by the user to pay issuance / receive redemption amount
    enum PaymentToken { None, LongToken, ERC20, Eth}

    /* ============ Constants ============= */

    uint256 constant private MAX_UINT96 = type(uint96).max;
    uint256 constant private MAX_UINT256 = type(uint256).max;
    address constant public ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    address public WETH;
    IUniswapV2Router02 public uniRouter;
    IUniswapV2Router02 public sushiRouter;

    address public immutable uniFactory;
    address public immutable sushiFactory;

    IController public immutable setController;
    IDebtIssuanceModule public immutable debtIssuanceModule;

    /* ============ Events ============ */

    event ExchangeIssue(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        IERC20 indexed _inputToken,     // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountInputToken,      // The amount of input tokens used for issuance
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event ExchangeRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        IERC20 indexed _outputToken,    // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed,     // The amount of SetTokens redeemed for output tokens
        uint256 _amountOutputToken      // The amount of output tokens received by the recipient
    );

    event Refund(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        uint256 _refundAmount           // The amount of ETH redunded to the recipient
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

    constructor(
        address _weth,
        address _uniFactory,
        IUniswapV2Router02 _uniRouter,
        address _sushiFactory,
        IUniswapV2Router02 _sushiRouter,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        address _addressProvider
    )
        public
        FlashLoanReceiverBaseV2(_addressProvider)
    {
        uniFactory = _uniFactory;
        uniRouter = _uniRouter;

        sushiFactory = _sushiFactory;
        sushiRouter = _sushiRouter;

        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;

        WETH = _weth;
        IERC20(WETH).safeApprove(address(uniRouter), PreciseUnitMath.maxUint256());
        IERC20(WETH).safeApprove(address(sushiRouter), PreciseUnitMath.maxUint256());
    }

    /* ============ Public Functions ============ */

    /**
    * Returns the long / short token addresses and amounts for a leveraged index 
    *
    * @param _setToken              Address of the SetToken to be issued
    * @param _amountSetToken        Amount of SetTokens to issue
    *
    * @return longToken             Address of long token (AToken)
    * @return longAmount            Amount of long Token required for issuance
    * @return shortToken            Address of short token
    * @return shortAmount           Amount of short Token returned for issuance
    */
    function getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _amountSetToken,
        bool isIssuance
    )
        isSetToken(_setToken)
        public 
        view
        returns (address longToken, uint256 longAmount, address shortToken, uint256 shortAmount)
    {
            address[] memory components;
            uint256[] memory equityPositions;
            uint256[] memory debtPositions;

            if(isIssuance){
                (components, equityPositions, debtPositions) = debtIssuanceModule.getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);
            }
            else {
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
            }
            else {
                longToken = components[1];
                longAmount = equityPositions[1];
                shortToken = components[0];
                shortAmount = debtPositions[0];
            }
    }

    /**
     * Runs all the necessary approval functions required for a given ERC20 token.
     * This function can be called when a new token is added to a SetToken during a
     * rebalance.
     *
     * @param _token    Address of the token which needs approval
     */
    function approveToken(IERC20 _token) public {
        _safeApprove(_token, address(uniRouter), MAX_UINT96);
        _safeApprove(_token, address(sushiRouter), MAX_UINT96);
        _safeApprove(_token, address(debtIssuanceModule), MAX_UINT96);
    }

    /* ============ External Functions ============ */

    /**
     * Trigger redemption of set token paying with the underlying of the collateral token directly
     *
     * @param _setToken            Set token to redeem
     * @param _amountSetToken      Amount to redeem
     * @param _maxAmountInputToken Maximum amount of input token to spend
     * @param _exchange            Exchange to use in swap from short to long token
     */
    function redeemExactSetForLongToken(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        bytes memory paymentParams = abi.encode(_maxAmountInputToken);
        initiateRedemption(_setToken, _amountSetToken, _exchange, PaymentToken.LongToken, paymentParams);
    }

    /**
     * Trigger issuance of set token paying with the underlying of the collateral token directly
     *
     * @param _setToken            Set token to issue
     * @param _amountSetToken      Amount to issue
     * @param _maxAmountInputToken Maximum amount of input token to spend
     * @param _exchange            Exchange to use in swap from short to long token
     */
    function issueExactSetForLongToken(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        bytes memory paymentParams = abi.encode(_maxAmountInputToken);
        initiateIssuance(_setToken, _amountSetToken, _exchange, PaymentToken.LongToken, paymentParams);
    }

    /**
     * Trigger issuance of set token paying with the underlying of the collateral token directly
     *
     * @param _setToken            Set token to issue
     * @param _amountSetToken      Amount to issue
     * @param _maxAmountInputToken Maximum amount of input token to spend
     * @param _exchange            Exchange to use in swap from short to long token
     */
    function issueExactSetForEth(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _maxAmountInputToken,
        Exchange _exchange
    )
        isSetToken(_setToken)
        external
        nonReentrant
    {
        bytes memory paymentParams = abi.encode(_maxAmountInputToken);
        initiateIssuance(_setToken, _amountSetToken, _exchange, PaymentToken.Eth, paymentParams);
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
        address , // 
        bytes calldata params
    ) external override  onlyLendingPool returns (bool) {
        require(assets.length == 1, "Exchange Issuance Leveraged: TOO MANY ASSETS");
        require(amounts.length == 1, "Exchange Issuance Leveraged: TOO MANY AMOUNTS");
        require(premiums.length == 1, "Exchange Issuance Leveraged: TOO MANY PREMIUMS");

        (,,,bool isIssuance,,,) = _decodeParams(params);
        if(isIssuance){
            _depositLongToken(assets[0], amounts[0]);
            _issueSet(params);
            _obtainLongTokens(assets[0], amounts[0] + premiums[0], params);
        }
        else {
            _redeemSet(params);
            _withdrawLongToken(params);
            uint256 longTokenSpent = _obtainShortTokens(assets[0], amounts[0] + premiums[0], params);
            _payUser(longTokenSpent, params);
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
            approveToken(_tokens[i]);
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
        (address longToken,,address shortToken,) = getLeveragedTokenData(_setToken, 1 ether, true);
        approveToken(IERC20(longToken));

        IERC20 underlyingLongToken = IERC20(IAToken(longToken).UNDERLYING_ASSET_ADDRESS());
        _approveTokenToLendingPool(underlyingLongToken);

        approveToken(IERC20(shortToken));
        _approveTokenToLendingPool(IERC20(shortToken));
    }



    /* ============ Internal Functions ============ */



    /**
     * Initiates a flashloan call with the correct parameters for issuing set tokens in the callback
     * Borrows correct amount of long token and and forwards encoded calldata to controll issuance in the callback.
     *
     * @param _setToken            Address of the SetToken being initialized
     * @param _amountSetToken      Amount of the SetToken being initialized
     * @param _paymentParams        Enum controlling what token the use to pay for issuance
     */
    function initiateIssuance(
        ISetToken _setToken,
        uint256 _amountSetToken,
        Exchange _exchange,
        PaymentToken _paymentToken,
        bytes memory _paymentParams
    )
        isSetToken(_setToken)
        internal
        returns (uint256)
    {
        (address longToken, uint256 longAmount,,) = getLeveragedTokenData(_setToken, _amountSetToken, true);

        address[] memory assets = new address[](1);
        assets[0] = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        uint[] memory amounts =  new uint[](1);
        amounts[0] = longAmount;

        bytes memory params = abi.encode(_setToken, _amountSetToken, msg.sender, true, _exchange, _paymentToken, _paymentParams);

        _flashloan(assets, amounts, params);

    }

    /**
     * Initiates a flashloan call with the correct parameters for redeeming set tokens in the callback
     *
     * @param _setToken            Address of the SetToken to redeem
     * @param _amountSetToken      Amount of the SetToken to redeem
     * @param _paymentToken       Enum controlling what token the user will receive
     */
    function initiateRedemption(
        ISetToken _setToken,
        uint256 _amountSetToken,
        Exchange _exchange,
        PaymentToken _paymentToken,
        bytes memory _paymentParams
    )
        isSetToken(_setToken)
        internal
        returns (uint256)
    {
        (,,address shortToken, uint256 shortAmount) = getLeveragedTokenData(_setToken, _amountSetToken, false);

        address[] memory assets = new address[](1);
        assets[0] = shortToken;
        uint[] memory amounts =  new uint[](1);
        amounts[0] = shortAmount;

        bytes memory params = abi.encode(_setToken, _amountSetToken, msg.sender, false, _exchange, _paymentToken, _paymentParams);

        _flashloan(assets, amounts, params);

    }

    /**
     * Obtains the tokens necessary to return the flashloan by swapping the long tokens obtained
     * from issuance and making up the longfall using the users funds.
     *
     * @param _shortToken    token of the collateral AToken, which is the token to be returned
     * @param _amountRequired        Amount of shortToken required to repay the flashloan
     * @param _params                Encoded data used to get setToken, setAmount, originalSender and paymentToken
     */
    function _obtainShortTokens(address _shortToken, uint256 _amountRequired, bytes memory _params) internal returns(uint256){
        (address setToken, uint256 setAmount,,, Exchange exchange,,) = _decodeParams(_params);
        return _swapLongForShortToken(setToken, setAmount, _amountRequired, _shortToken, exchange);
    }

    function _payUser(uint256 _longTokenSpent, bytes memory _params) internal {
        (address setToken, uint256 setAmount, address originalSender,,, PaymentToken paymentToken,) = _decodeParams(_params);
        (address longToken , uint256 longAmount,,) = getLeveragedTokenData(ISetToken(setToken), setAmount, true);
        address longTokenUnderlying = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        require(longAmount >= _longTokenSpent, "Spent more long tokens than received");
        uint256 amountToReturn = longAmount.sub(_longTokenSpent);
        if(paymentToken == PaymentToken.LongToken){
            IERC20(longTokenUnderlying).transfer(originalSender, amountToReturn);
        }
        else {
            revert("Payment token not implemented yet");
        }
    }

    /**
     * Obtains the tokens necessary to return the flashloan by swapping the short tokens obtained
     * from issuance and making up the shortfall using the users funds.
     *
     * @param _longTokenUnderlying   Underlying token of the collateral AToken, which is the token to be returned
     * @param _amountRequired        Amount of longTokenUnderlying required to repay the flashloan
     * @param _params                Encoded data used to get setToken, setAmount, originalSender and paymentToken
     */
    function _obtainLongTokens(address _longTokenUnderlying, uint256 _amountRequired, bytes memory _params) internal {
        (address setToken, uint256 setAmount, address originalSender,, Exchange exchange, PaymentToken paymentToken, bytes memory paymentParams) = _decodeParams(_params);
        uint longTokenObtained = _swapShortForLongTokenUnderlying(setToken, setAmount, _longTokenUnderlying, exchange);
        if(paymentToken == PaymentToken.LongToken){
           uint amountInputToken =  _transferShortfallFromSender(_longTokenUnderlying, _amountRequired, longTokenObtained, originalSender, paymentParams);
           emit ExchangeIssue(originalSender, ISetToken(setToken), IERC20(_longTokenUnderlying), amountInputToken, setAmount);
        }
        else {
            // TODO: Add Implementation of other payment options
            revert("Not Implemented");
        }
    }

    function _issueSet(bytes memory _params) internal {
        (address setToken, uint256 setAmount, address originalSender,,,,) = _decodeParams(_params);
        debtIssuanceModule.issue(ISetToken(setToken), setAmount, originalSender);
    }

    function _redeemSet(bytes memory _params) internal {
        (address setToken, uint256 setAmount, address originalSender ,,,,) = _decodeParams(_params);
        IERC20(setToken).safeTransferFrom(originalSender, address(this), setAmount);
        debtIssuanceModule.redeem(ISetToken(setToken), setAmount, address(this));
    }

    function _decodeParams(bytes memory params) internal pure returns(address setToken, uint256 setAmount, address originalSender, bool isIssuance, Exchange exchange, PaymentToken paymentToken, bytes memory paymentParams){
            (setToken, setAmount, originalSender, isIssuance, exchange, paymentToken, paymentParams) = abi.decode(params, (address, uint256, address, bool, Exchange, PaymentToken, bytes));
    }

    function _decodePaymentParamsLongToken(bytes memory _paymentParams) internal pure returns(uint256 maxAmountInputToken){
            maxAmountInputToken = abi.decode(_paymentParams, (uint256));
    }


    /**
     * Transfers the shortfall between the amount of tokens required to return flashloan and what was obtained
     * from swapping the debt tokens from the users address
     *
     * @param _token                 Address of the token to transfer from user
     * @param _amountRequired        Amount required to repay flashloan
     * @param _amountObtained        Amount obtained from swapping the short token
     * @param _originalSender        Adress that initiated the token issuance, which is the adresss form which to transfer the tokens
     */
    function _transferShortfallFromSender(address _token, uint256 _amountRequired, uint256 _amountObtained, address _originalSender, bytes memory paymentParams) internal returns(uint256 shortfall) {
        if(_amountObtained < _amountRequired){ 
            shortfall = _amountRequired.sub(_amountObtained);
            uint256 maxAmountInputToken =_decodePaymentParamsLongToken(paymentParams);
            require(shortfall <= maxAmountInputToken, "ExchangeIssuance: INSUFFICIENT INPUT AMOUNT");
            IERC20(_token).safeTransferFrom(_originalSender, address(this), shortfall);
        }
    }



    /**
     * Swaps the debt tokens obtained from issuance for the underlying of the collateral
     *
     * @param _setToken                   Address of the SetToken to be issued
     * @param _setAmount                  Amount of SetTokens to issue
     * @param _longTokenUnderlying        Address of the underlying of the collateral token
     */
    function _swapShortForLongTokenUnderlying(address _setToken, uint256 _setAmount, address _longTokenUnderlying, Exchange _exchange) internal returns (uint256) {
        (, , address shortToken, uint shortAmount) = getLeveragedTokenData(ISetToken(_setToken), _setAmount, true);
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(shortToken), address(router), shortAmount);
        return _swapExactTokensForTokens(_exchange, shortToken, _longTokenUnderlying, shortAmount);
    }

    /**
     * Swaps the debt tokens obtained from issuance for the underlying of the collateral
     *
     */
    function _swapLongForShortToken(address _setToken, uint256 _setAmount, uint256 _amountRequired, address _shortToken, Exchange _exchange) internal returns (uint256 longAmountSpent) {
        (address longToken, uint longAmount,,) = getLeveragedTokenData(ISetToken(_setToken), _setAmount, false);
        IUniswapV2Router02 router = _getRouter(_exchange);
        _safeApprove(IERC20(longToken), address(router), longAmount);
        address longTokenUnderlying = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        longAmountSpent = _swapTokensForExactTokens(_exchange, longTokenUnderlying, _shortToken, _amountRequired);
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
        bytes memory _params
    ) internal {
        (address setToken, uint256 setAmount,,,,,) = _decodeParams(_params);
        (address longToken, uint256 longAmount,,) = getLeveragedTokenData(ISetToken(setToken), setAmount, false);
        address longTokenUnderlying = IAToken(longToken).UNDERLYING_ASSET_ADDRESS();
        LENDING_POOL.withdraw(longTokenUnderlying, longAmount, address(this));
    }


    /**
     * Approves max amount of token to lending pool
     */
    function _approveTokenToLendingPool(
        IERC20 _token
    ) internal {
        uint256 allowance = _token.allowance(address(this), address(LENDING_POOL));
        // TODO: Review
        if (allowance > 0) {
            _token.approve( address(LENDING_POOL), 0);
        }
        _token.approve( address(LENDING_POOL), MAX_UINT256);
    }

    /**
     * Triggers the flashloan from the Lending Pool
     *
     * @param assets  Addresses of tokens to loan 
     * @param amounts Amounts to loan
     * @param params  Encoded calldata to forward to the executeOperation method
     */
    function _flashloan(address[] memory assets, uint256[] memory amounts, bytes memory params)
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
            _token.safeIncreaseAllowance(_spender, MAX_UINT96 - allowance);
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
    function _swapExactTokensForTokens(Exchange _exchange, address _tokenIn, address _tokenOut, uint256 _amountIn) internal returns (uint256) {
        if (_tokenIn == _tokenOut) {
            return _amountIn;
        }
        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;
        return _getRouter(_exchange).swapExactTokensForTokens(_amountIn, 0, path, address(this), block.timestamp)[1];
    }

    /**
     * Swap tokens for exact amount of output tokens on a given DEX.
     *
     * @param _exchange     The exchange on which to peform the swap
     * @param _tokenIn      The address of the input token
     * @param _tokenOut     The address of the output token
     * @param _amountOut    The amount of output token required
     *
     * @return              The amount of input tokens spent
     */
    function _swapTokensForExactTokens(Exchange _exchange, address _tokenIn, address _tokenOut, uint256 _amountOut) internal returns (uint256) {
        if (_tokenIn == _tokenOut) {
            return _amountOut;
        }
        address[] memory path = new address[](2);
        path[0] = _tokenIn;
        path[1] = _tokenOut;
        return _getRouter(_exchange).swapTokensForExactTokens(_amountOut, PreciseUnitMath.maxUint256(), path, address(this), block.timestamp)[0];
    }

    /**
     * Compares the amount of token required for an exact amount of another token across both exchanges,
     * and returns the min amount.
     *
     * @param _amountOut    The amount of output token
     * @param _tokenA       The address of tokenA
     * @param _tokenB       The address of tokenB
     *
     * @return              The min amount of tokenA required across both exchanges
     * @return              The Exchange on which minimum amount of tokenA is required
     * @return              The pair address of the uniswap/sushiswap pool containing _tokenA and _tokenB
     */
    function _getMinTokenForExactToken(uint256 _amountOut, address _tokenA, address _tokenB) internal view returns (uint256, Exchange, address) {
        if (_tokenA == _tokenB) {
            return (_amountOut, Exchange.None, ETH_ADDRESS);
        }

        uint256 maxIn = PreciseUnitMath.maxUint256() ;
        uint256 uniTokenIn = maxIn;
        uint256 sushiTokenIn = maxIn;

        address uniswapPair = _getPair(uniFactory, _tokenA, _tokenB);
        if (uniswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(uniswapPair, _tokenA, _tokenB);
            // Prevent subtraction overflow by making sure pool reserves are greater than swap amount
            if (reserveOut > _amountOut) {
                uniTokenIn = UniSushiV2Library.getAmountIn(_amountOut, reserveIn, reserveOut);
            }
        }

        address sushiswapPair = _getPair(sushiFactory, _tokenA, _tokenB);
        if (sushiswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(sushiswapPair, _tokenA, _tokenB);
            // Prevent subtraction overflow by making sure pool reserves are greater than swap amount
            if (reserveOut > _amountOut) {
                sushiTokenIn = UniSushiV2Library.getAmountIn(_amountOut, reserveIn, reserveOut);
            }
        }

        // Fails if both the values are maxIn
        require(!(uniTokenIn == maxIn && sushiTokenIn == maxIn), "ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        return (uniTokenIn <= sushiTokenIn) ? (uniTokenIn, Exchange.Uniswap, uniswapPair) : (sushiTokenIn, Exchange.Sushiswap, sushiswapPair);
    }

    /**
     * Compares the amount of token received for an exact amount of another token across both exchanges,
     * and returns the max amount.
     *
     * @param _amountIn     The amount of input token
     * @param _tokenA       The address of tokenA
     * @param _tokenB       The address of tokenB
     *
     * @return              The max amount of tokens that can be received across both exchanges
     * @return              The Exchange on which maximum amount of token can be received
     * @return              The pair address of the uniswap/sushiswap pool containing _tokenA and _tokenB
     */
    function _getMaxTokenForExactToken(uint256 _amountIn, address _tokenA, address _tokenB) internal view returns (uint256, Exchange, address) {
        if (_tokenA == _tokenB) {
            return (_amountIn, Exchange.None, ETH_ADDRESS);
        }

        uint256 uniTokenOut = 0;
        uint256 sushiTokenOut = 0;

        address uniswapPair = _getPair(uniFactory, _tokenA, _tokenB);
        if(uniswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(uniswapPair, _tokenA, _tokenB);
            uniTokenOut = UniSushiV2Library.getAmountOut(_amountIn, reserveIn, reserveOut);
        }

        address sushiswapPair = _getPair(sushiFactory, _tokenA, _tokenB);
        if(sushiswapPair != address(0)) {
            (uint256 reserveIn, uint256 reserveOut) = UniSushiV2Library.getReserves(sushiswapPair, _tokenA, _tokenB);
            sushiTokenOut = UniSushiV2Library.getAmountOut(_amountIn, reserveIn, reserveOut);
        }

        // Fails if both the values are 0
        require(!(uniTokenOut == 0 && sushiTokenOut == 0), "ExchangeIssuance: ILLIQUID_SET_COMPONENT");
        return (uniTokenOut >= sushiTokenOut) ? (uniTokenOut, Exchange.Uniswap, uniswapPair) : (sushiTokenOut, Exchange.Sushiswap, sushiswapPair);
    }

    /**
     * Returns the pair address for on a given DEX.
     *
     * @param _factory   The factory to address
     * @param _tokenA    The address of tokenA
     * @param _tokenB    The address of tokenB
     *
     * @return           The pair address (Note: address(0) is returned by default if the pair is not available on that DEX)
     */
    function _getPair(address _factory, address _tokenA, address _tokenB) internal view returns (address) {
        return IUniswapV2Factory(_factory).getPair(_tokenA, _tokenB);
    }

    /**
     * Returns the router address of a given exchange.
     *
     * @param _exchange     The Exchange whose router address is needed
     *
     * @return              IUniswapV2Router02 router of the given exchange
     */
     function _getRouter(Exchange _exchange) internal view returns(IUniswapV2Router02) {
         return (_exchange == Exchange.Uniswap) ? uniRouter : sushiRouter;
     }
}
