/*
    Copyright 2025 Index Cooperative

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
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IMorphoLeverageModule } from "../interfaces/IMorphoLeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import {IVault, IFlashLoanRecipient} from "../interfaces/external/balancer-v2/IVault.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IAToken } from "../interfaces/IAToken.sol";
import {IPool} from "../interfaces/IPool.sol";


/**
 * @title FlashMintLeveragedZeroEx
 * @author Index Coop
 *
 * Contract for issuing and redeeming a leveraged Set Token
 * Supports all standard (1 collateral / 1 debt token) leveraged tokens on either morpho or aave leveragemodule
 * Both the collateral as well as the debt token have to be available for flashloan from morpho and be
 * tradeable against each other via one of the whitelisted swap target contracts
 */
contract FlashMintLeveragedZeroExFL is ReentrancyGuard, Ownable, IFlashLoanRecipient {

    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Structs ============ */

    struct LeveragedTokenData {
        address collateralToken;
        address collateralAToken;
        uint256 collateralAmount;
        address debtToken;
        uint256 debtAmount;
    }

    struct SwapData {
        address swapTarget;
        bytes callData;
    }

    struct DecodedParams {
        ISetToken setToken;
        bool isAave;
        uint256 setAmount;
        address originalSender;
        bool isIssuance;
        address paymentToken;
        uint256 limitAmount;
        LeveragedTokenData leveragedTokenData;
        SwapData collateralAndDebtSwapData;
        SwapData paymentTokenSwapData;
    }

    struct TokenBalance {
        IERC20 token;
        uint256 balance;
    }

    /* ============ Constants ============= */

    uint256 private constant MAX_UINT256 = type(uint256).max;
    uint256 public constant ROUNDING_ERROR_MARGIN = 2;
    address public constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    IController public immutable setController;
    IDebtIssuanceModule public immutable debtIssuanceModule;
    IMorphoLeverageModule public immutable morphoLeverageModule;
    IMorphoLeverageModule public immutable aaveLeverageModule;
    IVault public immutable balancerV2Vault;
    IWETH public immutable weth;
    IPool public immutable aavePool;
    address private flashLoanBenefactor;
    // TODO: Add support for multiple routers supplied by the user
    mapping(address => bool) public swapTargetWhitelist;

    /* ============ Events ============ */

    event FlashMint(
        address indexed _recipient,     // The recipient address of the issued SetTokens
        ISetToken indexed _setToken,    // The issued SetToken
        address indexed _inputToken,    // The address of the input asset(ERC20/ETH) used to issue the SetTokens
        uint256 _amountSetIssued        // The amount of SetTokens received by the recipient
    );

    event FlashRedeem(
        address indexed _recipient,     // The recipient address which redeemed the SetTokens
        ISetToken indexed _setToken,    // The redeemed SetToken
        address indexed _outputToken,   // The address of output asset(ERC20/ETH) received by the recipient
        uint256 _amountSetRedeemed     // The amount of SetTokens redeemed for output tokens
    );

     modifier onlyBalancerV2Vault() {
         require(msg.sender == address(balancerV2Vault), "ExchangeIssuance: BalancerV2 Vault ONLY");
         _;
    }

    /* ============ Constructor ============ */

    /**
    * Sets various contract addresses 
    *
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _debtIssuanceModule    DebtIssuanceModule used to issue and redeem tokens
    * @param _morphoLeverageModule    MorphoLeverageModule to sync before every issuance / redemption
    * @param _aaveLeverageModule    AaveLeverageModule to sync before every issuance / redemption
    * @param _balancerV2Vault        Balancer vault to get flashloans from
    * @param _weth                   WETH contract to deposit and withdraw eth
    * @param _swapTarget             Address of the 0x router to use for swaps
    */
    constructor(
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        IMorphoLeverageModule _morphoLeverageModule,
        IMorphoLeverageModule _aaveLeverageModule,
        IVault _balancerV2Vault,
        IPool _aavePool,
        IWETH _weth,
        address _swapTarget
    )
        public
    {
        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;
        morphoLeverageModule = _morphoLeverageModule;
        aaveLeverageModule = _aaveLeverageModule;
        balancerV2Vault = _balancerV2Vault;
        aavePool = _aavePool;
        weth = _weth;
        swapTargetWhitelist[_swapTarget] = true;
    }

    /* ============ External Functions ============ */

    /**
     * Adds or removes a given swapTarget from the whitelist
     * OWNER ONLY
     *
     * @param _swapTarget           Settlement contract to add/remove from whitelist
     * @param _isAllowed            Boolean indicating wether given contract should be included in the whitelist
     *
     */
    function setSwapTargetWhitelist(address _swapTarget, bool _isAllowed) external onlyOwner {
        swapTargetWhitelist[_swapTarget] = _isAllowed;
    }

    /**
     * Withdraws stranded tokens from the contracts balance
     * OWNER ONLY
     *
     * @param _token                Token to be withdrawn from the contract balance
     *
     */
    function withdrawToken(IERC20 _token) external onlyOwner {
        if (address(_token) == address(0)) {
            msg.sender.sendValue(address(this).balance);
        } else {
            _token.safeTransfer(msg.sender, _token.balanceOf(address(this)));
        }
    }

    /**
     * Returns the collateral / debt token addresses and amounts for a leveraged index 
     *
     * @param _setToken              Address of the SetToken to be issued / redeemed
     * @param _setAmount             Amount of SetTokens to issue / redeem
     * @param _isIssuance            Boolean indicating if the SetToken is to be issued or redeemed
     * @param _isAave                Boolean indicating wether given leveraged token is based on aave leverage module (or morpho)
     *
     * @return Struct containing the collateral / debt token addresses and amounts
     */
    function getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isIssuance,
        bool _isAave
    )
        external 
        returns (LeveragedTokenData memory)
    {
        _syncLeverageModule(_isAave, _setToken);
        return _getLeveragedTokenData(_setToken, _setAmount, _isIssuance, _isAave);
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
     * @param _setToken                   Set token to redeem
     * @param _setAmount                  Amount to redeem
     * @param _minAmountOutputToken       Minimum amount of ETH to send to the user
     * @param _swapDataCollateralForDebt  Data (token path and fee levels) describing the swap from Collateral Token to Debt Token
     * @param _swapDataOutputToken        Data (token path and fee levels) describing the swap from Collateral Token to Eth
     * @param _isAave                     Boolean indicating wether given token is based on aave or morpho leverage module
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _setAmount,
        uint256 _minAmountOutputToken,
        SwapData memory _swapDataCollateralForDebt,
        SwapData memory _swapDataOutputToken,
        bool _isAave
    )
        external
        virtual
        nonReentrant
        returns(uint256[] memory)
    {
        _initiateRedemption(
            _setToken,
            _setAmount,
            ETH_ADDRESS,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken,
            _isAave
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
     * @param _isAave                     Boolean indicating wether given token is based on aave or morpho leverage module
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _outputToken,
        uint256 _minAmountOutputToken,
        SwapData memory _swapDataCollateralForDebt,
        SwapData memory _swapDataOutputToken,
        bool _isAave
    )
        external
        virtual
        nonReentrant
        returns(uint256[] memory)
    {
        _initiateRedemption(
            _setToken,
            _setAmount,
            _outputToken,
            _minAmountOutputToken,
            _swapDataCollateralForDebt,
            _swapDataOutputToken,
            _isAave
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
     * @param _isAave                     Boolean indicating wether given token is based on aave or morpho leverage module
     */
    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _setAmount,
        address _inputToken,
        uint256 _maxAmountInputToken,
        SwapData memory _swapDataDebtForCollateral,
        SwapData memory _swapDataInputToken,
        bool _isAave
    )
        external
        virtual
        nonReentrant
        returns(uint256[] memory)
    {
        _initiateIssuance(
            _setToken,
            _setAmount,
            _inputToken,
            _maxAmountInputToken,
            _swapDataDebtForCollateral,
            _swapDataInputToken,
            _isAave
        );
    }

    /**
     * Trigger issuance of set token paying with Eth
     *
     * @param _setToken                     Set token to issue
     * @param _setAmount                    Amount to issue
     * @param _swapDataDebtForCollateral    Data (token addresses and fee levels) to describe the swap path from Debt to collateral token
     * @param _swapDataInputToken           Data (token addresses and fee levels) to describe the swap path from eth to collateral token
     * @param _isAave                     Boolean indicating wether given token is based on aave or morpho leverage module
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _setAmount,
        SwapData memory _swapDataDebtForCollateral,
        SwapData memory _swapDataInputToken,
        bool _isAave
    )
        external
        virtual
        payable
        nonReentrant
        returns(uint256[] memory)
    {
        _initiateIssuance(
            _setToken,
            _setAmount,
            ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputToken,
            _isAave
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
            _performIssuance(decodedParams);
        } else {
            _performRedemption(decodedParams);
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
     * @param _isAave      Boolean indicating wether leverage token is based on aave leverage module
     */
    function approveSetToken(ISetToken _setToken, bool _isAave) external {
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, 1 ether, true, _isAave);


        if(_isAave){
            _approveToken(IERC20(leveragedTokenData.collateralAToken));
            _approveToken(IERC20(leveragedTokenData.debtToken));
            _approveTokenToLendingPool(IERC20(leveragedTokenData.collateralToken));
            _approveTokenToLendingPool(IERC20(leveragedTokenData.debtToken));
        } else {
            _approveToken(IERC20(leveragedTokenData.collateralToken));
            _approveToken(IERC20(leveragedTokenData.debtToken));

        }
    }

    /* ============ Internal Functions ============ */

    function _getTokenBalances(address _paymentToken, LeveragedTokenData memory leveragedTokenData)
    internal
    returns (uint256[] memory tokenBalances)
    {
        bool isPaymentTokenDistinct = _paymentToken != leveragedTokenData.collateralToken && _paymentToken != leveragedTokenData.debtToken;
        tokenBalances = isPaymentTokenDistinct ? new uint256[](3) : new uint256[](2);
        tokenBalances[0] = IERC20(leveragedTokenData.collateralToken).balanceOf(address(this));
        tokenBalances[1] = IERC20(leveragedTokenData.debtToken).balanceOf(address(this));
        if (isPaymentTokenDistinct) {
            if(_paymentToken == ETH_ADDRESS) {
                tokenBalances[2] = address(this).balance;
            } else {
                tokenBalances[2] = IERC20(_paymentToken).balanceOf(address(this));
            }
        }
    }

    function _returnExcessTokenBalances(uint256[] memory balancesBefore, address _paymentToken, LeveragedTokenData memory leveragedTokenData) 
    internal
    returns(uint256[] memory amountsReturned)
    {
        amountsReturned = new uint256[](balancesBefore.length);

        if(balancesBefore.length > 2) {
            if(_paymentToken == ETH_ADDRESS) {
                uint256 paymentTokenBalance = weth.balanceOf(address(this));
                if(paymentTokenBalance > balancesBefore[2]) {
                    amountsReturned[2] = paymentTokenBalance - balancesBefore[2];
                    weth.withdraw(amountsReturned[2]);
                    msg.sender.sendValue(amountsReturned[2]);
                }
            } else {
                uint256 paymentTokenBalance = IERC20(_paymentToken).balanceOf(address(this));
                if(paymentTokenBalance > balancesBefore[2]) {
                    amountsReturned[2] = paymentTokenBalance - balancesBefore[2];
                    IERC20(_paymentToken).safeTransfer(msg.sender, amountsReturned[2]);
                }
            }
        }

        uint256 collateralTokenBalance = IERC20(leveragedTokenData.collateralToken).balanceOf(address(this));
        if(collateralTokenBalance > balancesBefore[0]) {
            amountsReturned[0] = collateralTokenBalance - balancesBefore[0];
            if(leveragedTokenData.collateralToken == address(weth) && _paymentToken == ETH_ADDRESS) {
                weth.withdraw(amountsReturned[0]);
                msg.sender.sendValue(amountsReturned[0]);
            } else {
                IERC20(leveragedTokenData.collateralToken).safeTransfer(msg.sender, amountsReturned[0]);
            }
        }

        uint256 debtTokenBalance = IERC20(leveragedTokenData.debtToken).balanceOf(address(this));
        if(debtTokenBalance > balancesBefore[1]) {
            amountsReturned[1] = debtTokenBalance - balancesBefore[1];
            if(leveragedTokenData.debtToken == address(weth) && _paymentToken == ETH_ADDRESS) {
                weth.withdraw(amountsReturned[1]);
                msg.sender.sendValue(amountsReturned[1]);
            } else {
                IERC20(leveragedTokenData.debtToken).safeTransfer(msg.sender, amountsReturned[1]);
            }
        }

    }

    /**
     * Performs all the necessary steps for issuance using the collateral tokens obtained in the flashloan
     *
     * @param _decodedParams              Struct containing token addresses / amounts to perform issuance
     */
    function _performIssuance(
        DecodedParams memory _decodedParams
    ) 
    internal 
    {
        if(_decodedParams.isAave) {
            // Deposit collateral token obtained from flashloan to get the respective aToken position required for issuance
            _depositCollateralToken(_decodedParams.leveragedTokenData.collateralToken, _decodedParams.leveragedTokenData.collateralAmount);
        }

        debtIssuanceModule.issue(_decodedParams.setToken, _decodedParams.setAmount, _decodedParams.originalSender);
        // Obtain necessary collateral tokens to repay flashloan 
        _executeSwapData(
            _decodedParams.leveragedTokenData.debtToken,
            _decodedParams.collateralAndDebtSwapData
        );

        address inputToken;
        if(_decodedParams.paymentToken == ETH_ADDRESS) {
            weth.deposit{value: _decodedParams.limitAmount}();
            inputToken = address(weth);
        } else {
            inputToken = _decodedParams.paymentToken;
            // Security Assumption: No one can manipulate Morpho such that this original sender is not the original sender of the transaction
            // Alternatively: 
            IERC20(inputToken).safeTransferFrom(_decodedParams.originalSender, address(this), _decodedParams.limitAmount);
        }
        _executeSwapData(
            inputToken,
            _decodedParams.paymentTokenSwapData
        );

        emit FlashMint(
            _decodedParams.originalSender,
            _decodedParams.setToken,
            _decodedParams.paymentToken,
            _decodedParams.setAmount
        );
    }

    /**
     * Performs all the necessary steps for redemption using the debt tokens obtained in the flashloan
     *
     * @param _decodedParams       Struct containing token addresses / amounts to perform redemption
     */
    function _performRedemption(
        DecodedParams memory _decodedParams
    ) 
    internal 
    {
        debtIssuanceModule.redeem(_decodedParams.setToken, _decodedParams.setAmount, address(this));

        if(_decodedParams.isAave) {
            // Withdraw underlying collateral token from the aToken position returned by redeem step
            _withdrawCollateralToken(
                _decodedParams.leveragedTokenData.collateralToken,
                _decodedParams.leveragedTokenData.collateralAmount - ROUNDING_ERROR_MARGIN
            );
        }

        // Swap Collateral for Debt Tokens
        _executeSwapData(
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.collateralAndDebtSwapData
        );

        // Swap Collateral tokens for Payment token
        _executeSwapData(
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.paymentTokenSwapData
        );

        emit FlashRedeem(
            _decodedParams.originalSender,
            _decodedParams.setToken,
            _decodedParams.paymentToken,
            _decodedParams.setAmount
        );
    }


    /**
    * Returns the collateral / debt token addresses and amounts for a leveraged index 
    *
    * @param _setToken              Address of the SetToken to be issued / redeemed
    * @param _setAmount             Amount of SetTokens to issue / redeem
    * @param _isIssuance            Boolean indicating if the SetToken is to be issued or redeemed
     * @param _isAave                Boolean indicating wether given leveraged token is based on aave leverage module (or morpho)
    *
    * @return Struct containing the collateral / debt token addresses and amounts
    */
    function _getLeveragedTokenData(
        ISetToken _setToken,
        uint256 _setAmount,
        bool _isIssuance,
        bool _isAave
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
        require(debtPositions[0] == 0 || debtPositions[1] == 0, "ExchangeIssuance: TOO MANY DEBT POSITIONS");

        if(equityPositions[0] > 0){
            return LeveragedTokenData(
                _isAave ? IAToken(components[0]).UNDERLYING_ASSET_ADDRESS() : components[0],
                _isAave ? components[0] : address(0),
                equityPositions[0] + ROUNDING_ERROR_MARGIN,
                components[1],
                debtPositions[1]
            );
        } else {
            return LeveragedTokenData(
                _isAave ? IAToken(components[1]).UNDERLYING_ASSET_ADDRESS() : components[1],
                _isAave ? components[1] : address(0),
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
     * Approves max amount of token to lending pool
     *
     * @param _token              Address of the token to approve
     */
    function _approveTokenToLendingPool(
        IERC20 _token
    )
    internal
    {
        uint256 allowance = _token.allowance(address(this), address(aavePool));
        if (allowance > 0) {
            _token.approve(address(aavePool), 0);
        }
        _token.approve(address(aavePool), MAX_UINT256);
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
     * @param _isAave                     Boolean indicating wether given token is based on aave or morpho leverage module
     */
    function _initiateIssuance(
        ISetToken _setToken,
        uint256 _setAmount,
        address _inputToken,
        uint256 _maxAmountInputToken,
        SwapData memory _swapDataDebtForCollateral,
        SwapData memory _swapDataInputToken,
        bool _isAave
    )
        internal
        returns(uint256[] memory)
    {
        _syncLeverageModule(_isAave, _setToken);
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, _setAmount, true, _isAave);
        uint256[] memory tokenBalances = _getTokenBalances(_inputToken, leveragedTokenData);

        bytes memory params = abi.encode(
            DecodedParams(
                _setToken,
                _isAave,
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

        _flashloan(leveragedTokenData.collateralToken, leveragedTokenData.collateralAmount, params);

        return _returnExcessTokenBalances(tokenBalances, _inputToken, leveragedTokenData);
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
     * @param _isAave                     Boolean indicating wether given leverage token is based on aave leverage module
     */
    function _initiateRedemption(
        ISetToken _setToken,
        uint256 _setAmount,
        address  _outputToken,
        uint256 _minAmountOutputToken,
        SwapData memory _swapDataCollateralForDebt,
        SwapData memory _swapDataOutputToken,
        bool _isAave
    )
        internal
        returns(uint256[] memory returnedAmounts)
    {
        _syncLeverageModule(_isAave, _setToken);

        _setToken.safeTransferFrom(msg.sender, address(this), _setAmount);
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, _setAmount, false, _isAave);
        uint256[] memory tokenBalances = _getTokenBalances(_outputToken, leveragedTokenData);

        bytes memory params = abi.encode(
            DecodedParams(
                _setToken,
                _isAave,
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

        _flashloan(leveragedTokenData.debtToken, leveragedTokenData.debtAmount, params);

        returnedAmounts = _returnExcessTokenBalances(tokenBalances, _outputToken, leveragedTokenData);

        require(
            (_outputToken == leveragedTokenData.collateralToken && returnedAmounts[0] >= _minAmountOutputToken) 
            ||
            (_outputToken == leveragedTokenData.debtToken && returnedAmounts[1] >= _minAmountOutputToken) 
            ||
            (returnedAmounts[2] >= _minAmountOutputToken),
            "INSUFFICIENT OUTPUT AMOUNT"
        );
    }

    function _syncLeverageModule(
        bool _isAave,
        ISetToken _setToken
    )
    internal {
        if(_isAave) {
            aaveLeverageModule.sync(_setToken);
        } else {
            morphoLeverageModule.sync(_setToken);
        }
    }



    /**
     * Swaps the debt tokens obtained from issuance for the collateral
     *
     * @param _inputToken                 Input token to be approved for this swap
     * @param _swapData                   Struct containing path and fee data for swap
     *
     */
    function _executeSwapData(
        address _inputToken,
        SwapData memory _swapData
    )
        internal
    {
        if(_swapData.swapTarget != address(0)){
            IERC20(_inputToken).approve(_swapData.swapTarget, IERC20(_inputToken).balanceOf(address(this)));
            _fillQuote(_swapData);
        }
    }

    /**
     * Execute a 0x Swap quote
     *
     * @param _quote          Swap quote as returned by 0x API
     *
     */
    function _fillQuote(
        SwapData memory _quote
    )
        internal
    {

        require(swapTargetWhitelist[_quote.swapTarget], "swapTarget not whitelisted");
        (bool success, bytes memory returndata) = _quote.swapTarget.call(_quote.callData);

        // Forwarding errors including new custom errors
        // Taken from: https://ethereum.stackexchange.com/a/111187/73805
        if (!success) {
            if (returndata.length == 0) revert();
            assembly {
                revert(add(32, returndata), mload(returndata))
            }
        }

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
     * Triggers the flashloan from the BalancerV2 Vault
     *
     * @param token          Address of the token to loan
     * @param amount         Amount to loan
     * @param params         Encoded memory to forward to the executeOperation method
     */
    function _flashloan(
        address token,
        uint256 amount,
        bytes memory params
    )
    internal
    {
        require(flashLoanBenefactor == address(0), "Flashloan already taken");
        flashLoanBenefactor = msg.sender;
        address[] memory assets = new address[](1);
        assets[0] = token;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        balancerV2Vault.flashLoan(this, assets, amounts, params);
        flashLoanBenefactor = address(0);
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
        aavePool.deposit(_collateralToken, _depositAmount, address(this), 0);
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
        aavePool.withdraw(_collateralToken, _collateralAmount, address(this));
    }


    receive() external payable {}
}
