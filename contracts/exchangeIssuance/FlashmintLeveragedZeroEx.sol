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
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IMorphoLeverageModule } from "../interfaces/IMorphoLeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { IController } from "../interfaces/IController.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { IMorpho } from "../interfaces/IMorpho.sol";


/**
 * @title FlashMintLeveragedZeroEx
 * @author Index Coop
 *
 * Contract for issuing and redeeming a leveraged Set Token
 * Supports all tokens with one morpho collateral Position and one debt position
 * Both the collateral as well as the debt token have to be available for flashloan from morpho and be 
 * tradeable against each other on 0x
 */
contract FlashMintLeveragedZeroEx is ReentrancyGuard {

    using Address for address payable;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ISetToken;

    /* ============ Structs ============ */

    struct LeveragedTokenData {
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
        bytes collateralAndDebtSwapData;
        bytes paymentTokenSwapData;    
    }

    /* ============ Constants ============= */

    uint256 constant private MAX_UINT256 = type(uint256).max;
    uint256 public constant ROUNDING_ERROR_MARGIN = 2;
    address  public constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ State Variables ============ */

    IController public immutable setController;
    IDebtIssuanceModule public immutable debtIssuanceModule;
    IMorphoLeverageModule public immutable morphoLeverageModule;
    IMorpho public immutable morpho;
    IWETH public immutable weth;
    address private flashLoanBenefactor;
    // TODO: Add support for multiple routers supplied by the user
    address public swapTarget;

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

    /* ============ Constructor ============ */

    /**
    * Sets various contract addresses 
    *
    * @param _setController         SetToken controller used to verify a given token is a set
    * @param _debtIssuanceModule    DebtIssuanceModule used to issue and redeem tokens
    * @param _morphoLeverageModule    MorphoLeverageModule to sync before every issuance / redemption
    * @param _morpho                 Morpho contract to call for flashloan
    * @param _weth                   WETH contract to deposit and withdraw eth
    * @param _swapTarget             Address of the 0x router to use for swaps
    */
    constructor(
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        IMorphoLeverageModule _morphoLeverageModule,
        IMorpho _morpho,
        IWETH _weth,
        address _swapTarget
    )
        public
    {
        setController = _setController;
        debtIssuanceModule = _debtIssuanceModule;
        morphoLeverageModule = _morphoLeverageModule;
        morpho = _morpho;
        weth = _weth;
        swapTarget = _swapTarget;
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
        returns (LeveragedTokenData memory)
    {
        morphoLeverageModule.sync(_setToken);
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
        bytes memory _swapDataCollateralForDebt,
        bytes memory _swapDataOutputToken
    )
        external
        virtual
        nonReentrant
    {
        _initiateRedemption(
            _setToken,
            _setAmount,
            ETH_ADDRESS,
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
        bytes memory _swapDataCollateralForDebt,
        bytes memory _swapDataOutputToken
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
        bytes memory _swapDataDebtForCollateral,
        bytes memory _swapDataInputToken
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
        bytes memory _swapDataDebtForCollateral,
        bytes memory _swapDataInputToken
    )
        external
        virtual
        payable
        nonReentrant
    {
        _initiateIssuance(
            _setToken,
            _setAmount,
            ETH_ADDRESS,
            msg.value,
            _swapDataDebtForCollateral,
            _swapDataInputToken
        );
    }

    /**
      * Callback function called by Morpho after flashloan has been requested
     *
     * @param assets    Amount of tokens loaned / to be repayed
     * @param data      Encoded data containing the original sender and leveraged token data
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        require(msg.sender == address(morpho));
        DecodedParams memory decodedParams = abi.decode(data, (DecodedParams));
        require(flashLoanBenefactor == decodedParams.originalSender, "Flashloan not initiated by this contract");

        if(decodedParams.isIssuance){
            _performIssuance(decodedParams);
            IERC20(decodedParams.leveragedTokenData.collateralToken).approve(address(morpho), assets);
        } else {
            _performRedemption(decodedParams);
            IERC20(decodedParams.leveragedTokenData.debtToken).approve(address(morpho), assets);
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

        _approveToken(IERC20(leveragedTokenData.collateralToken));

        _approveToken(IERC20(leveragedTokenData.debtToken));
    }

    /* ============ Internal Functions ============ */

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
            IERC20(inputToken).transferFrom(_decodedParams.originalSender, address(this), _decodedParams.limitAmount);
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
        // Swap Collateral for Debt Tokens
        _executeSwapData(
            _decodedParams.leveragedTokenData.collateralToken,
            _decodedParams.collateralAndDebtSwapData
        );
        // Swap Debt tokens for Payment token
        _executeSwapData(
            _decodedParams.leveragedTokenData.debtToken,
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
        require(debtPositions[0] == 0 || debtPositions[1] == 0, "ExchangeIssuance: TOO MANY DEBT POSITIONS");

        if(equityPositions[0] > 0){
            return LeveragedTokenData(
                components[0],
                equityPositions[0] + ROUNDING_ERROR_MARGIN,
                components[1],
                debtPositions[1]
            );
        } else {
            return LeveragedTokenData(
                components[1],
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
        bytes memory _swapDataDebtForCollateral,
        bytes memory _swapDataInputToken
    )
        internal
    {
        morphoLeverageModule.sync(_setToken);
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, _setAmount, true);

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

        _flashloan(leveragedTokenData.collateralToken, leveragedTokenData.collateralAmount, params);

        // Transfer to the user full contract balance of input, collateral and debt tokens
        // TODO: Check if we need to have additional protection against people using this to drain leftover tokens
        if(_inputToken == ETH_ADDRESS) {
            uint256 wethAmount = weth.balanceOf(address(this));
            weth.withdraw(wethAmount);
            msg.sender.sendValue(wethAmount);
        } else {
            IERC20(_inputToken).transfer(msg.sender, IERC20(_inputToken).balanceOf(address(this)));
        }
        IERC20(leveragedTokenData.collateralToken).transfer(msg.sender, IERC20(leveragedTokenData.collateralToken).balanceOf(address(this)));
        IERC20(leveragedTokenData.debtToken).transfer(msg.sender, IERC20(leveragedTokenData.debtToken).balanceOf(address(this)));

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
        bytes memory _swapDataCollateralForDebt,
        bytes memory _swapDataOutputToken
    )
        internal
    {
        _setToken.safeTransferFrom(msg.sender, address(this), _setAmount);
        morphoLeverageModule.sync(_setToken);
        LeveragedTokenData memory leveragedTokenData = _getLeveragedTokenData(_setToken, _setAmount, false);

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

        _flashloan(leveragedTokenData.debtToken, leveragedTokenData.debtAmount, params);

        // TODO: Check if we need to have additional protection against people using this to drain leftover tokens
        if(_outputToken == ETH_ADDRESS) {
            uint256 wethAmount = weth.balanceOf(address(this));
            weth.withdraw(wethAmount);
            msg.sender.sendValue(wethAmount);
        } else {
            IERC20(_outputToken).transfer(msg.sender, IERC20(_outputToken).balanceOf(address(this)));
        }
        IERC20(leveragedTokenData.collateralToken).transfer(msg.sender, IERC20(leveragedTokenData.collateralToken).balanceOf(address(this)));
        IERC20(leveragedTokenData.debtToken).transfer(msg.sender, IERC20(leveragedTokenData.debtToken).balanceOf(address(this)));
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
        bytes memory _swapData
    )
        internal
    {
        if(_isValidSwapData(_swapData)){
            IERC20(_inputToken).approve(swapTarget, IERC20(_inputToken).balanceOf(address(this)));
            _fillQuote(_swapData);
        }
    }

    function _isValidSwapData(bytes memory _swapData) public pure returns (bool) {
        if(_swapData.length < 4) {
            return false;
        }
        bytes4 result;
        assembly {
            result := mload(add(_swapData, 32)) // Load first 32 bytes, but we only take the first 4
        }
        if(result == bytes4(0)){
            return false;
        }

        return true;
    }

    /**
     * Execute a 0x Swap quote
     *
     * @param _quote          Swap quote as returned by 0x API
     *
     */
    function _fillQuote(
        bytes memory _quote
    )
        internal
    {

        (bool success, bytes memory returndata) = swapTarget.call(_quote);

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
        morpho.flashLoan(token, amount, params);
        flashLoanBenefactor = address(0);
    }

    receive() external payable {}
}
