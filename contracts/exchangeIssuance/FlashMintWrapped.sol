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

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IController} from "../interfaces/IController.sol";
import {IIntegrationRegistry} from "../interfaces/IIntegrationRegistry.sol";
import {IWrapV2Adapter} from "../interfaces/IWrapV2Adapter.sol";
import {IDebtIssuanceModule} from "../interfaces/IDebtIssuanceModule.sol";
import {ISetToken} from "../interfaces/ISetToken.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import {Withdrawable} from "external/contracts/aaveV2/utils/Withdrawable.sol";
import {DEXAdapter} from "./DEXAdapter.sol";

/**
 * @title FlashMintWrapped
 *
 * Flash issues SetTokens whose components contain wrapped tokens.
 *
 * Compatible with:
 * IssuanceModules: DebtIssuanceModule, DebtIssuanceModuleV2
 * WrapAdapters: IWrapV2Adapter
 *
 * Supports flash minting for sets that contain both unwrapped and wrapped components.
 * Does not support debt positions on Set token.
 * Wrapping / Unwrapping is skipped for a component if ComponentSwapData[component_index].underlyingERC20 address == set component address
 * If the set contains both wrapped and unwrapped version of a token (e.g. DAI and cDAI) -> supply two separate component data points
 * e.g. for issue
 * Set components at index 0 = DAI; then -> ComponentSwapData[0].underlyingERC20 = DAI; (no wrapping will happen)
 * Set components at index 1 = cDAI; then -> ComponentSwapData[1].underlyingERC20 = DAI; (wrapping will happen)
 */
contract FlashMintWrapped is ReentrancyGuard, Withdrawable {
  using DEXAdapter for DEXAdapter.Addresses;
  using Address for address payable;
  using Address for address;
  using SafeMath for uint256;
  using SafeERC20 for IERC20;
  using SafeERC20 for ISetToken;

  /* ============ Structs ============ */

  struct ComponentSwapData {
    // unwrapped token version, e.g. DAI
    address underlyingERC20;
    // swap data for DEX operation: fees, path, etc. see DEXAdapter.SwapData
    DEXAdapter.SwapData dexData;
    // ONLY relevant for issue, not used for redeem:
    // amount that has to be bought of the unwrapped token version (to cover required wrapped component amounts for issuance)
    // this amount has to be computed beforehand through the exchange rate of wrapped Component <> unwrappedComponent
    // i.e. getRequiredComponentIssuanceUnits() on the IssuanceModule and then convert units through exchange rate to unwrapped component units
    // e.g. 300 cDAI needed for issuance of 1 Set token. exchange rate 1cDAI = 0.05 DAI. -> buyUnderlyingAmount = 0.05 DAI * 300 = 15 DAI
    uint256 buyUnderlyingAmount;
  }

  struct ComponentWrapData {
    string integrationName; // wrap adapter integration name as listed in the IntegrationRegistry for the wrapModule
    bytes wrapData; // optional wrapData passed to the wrapAdapter
  }

  /* ============ Constants ============= */

  uint256 private constant MAX_UINT256 = type(uint256).max;

  /* ============ Immutables ============ */

  IController public immutable setController;
  IDebtIssuanceModule public immutable debtIssuanceModule; // interface is compatible with DebtIssuanceModuleV2
  address public immutable wrapModule; // used to obtain a valid wrap adapter

  /* ============ State Variables ============ */

  DEXAdapter.Addresses public dexAdapter;

  /* ============ Events ============ */

  event FlashMint(
    address indexed _recipient, // The recipient address of the minted Set token
    ISetToken indexed _setToken, // The minted Set token
    IERC20 indexed _inputToken, // The address of the input asset(ERC20/ETH) used to mint the Set tokens
    uint256 _amountInputToken, // The amount of input tokens used for minting
    uint256 _amountSetIssued // The amount of Set tokens received by the recipient
  );

  event FlashRedeem(
    address indexed _recipient, // The recipient address which redeemed the Set token
    ISetToken indexed _setToken, // The redeemed Set token
    IERC20 indexed _outputToken, // The address of output asset(ERC20/ETH) received by the recipient
    uint256 _amountSetRedeemed, // The amount of Set token redeemed for output tokens
    uint256 _amountOutputToken // The amount of output tokens received by the recipient
  );

  /* ============ Modifiers ============ */

  /**
   * checks that _setToken is a valid listed set token on the setController
   *
   * @param _setToken       set token to check
   */
  modifier isSetToken(ISetToken _setToken) {
    require(setController.isSet(address(_setToken)), "ExchangeIssuance: INVALID_SET");
    _;
  }

  /**
   * checks that _inputToken is the first adress in _path and _outputToken is the last address in _path
   *
   * @param _path                      Array of addresses for a DEX swap path
   * @param _inputToken                input token of DEX swap
   * @param _outputToken               output token of DEX swap
   */
  modifier isValidPath(
    address[] memory _path,
    address _inputToken,
    address _outputToken
  ) {
    if (_inputToken != _outputToken) {
      require(
        _path[0] == _inputToken ||
          (_inputToken == dexAdapter.weth && _path[0] == DEXAdapter.ETH_ADDRESS),
        "FlashMint: INPUT_TOKEN_NOT_IN_PATH"
      );
      require(
        _path[_path.length - 1] == _outputToken ||
          (_outputToken == dexAdapter.weth && _path[_path.length - 1] == DEXAdapter.ETH_ADDRESS),
        "FlashMint: OUTPUT_TOKEN_NOT_IN_PATH"
      );
    }
    _;
  }

  /* ========== Constructor ========== */

  /**
   * Constructor initializes various addresses
   *
   * @param _dexAddresses              Address of quickRouter, sushiRouter, uniV3Router, uniV3Router, curveAddressProvider, curveCalculator and weth.
   * @param _setController             Set token controller used to verify a given token is a set
   * @param _debtIssuanceModule        DebtIssuanceModule used to issue and redeem tokens
   * @param _wrapModule                WrapModule used to obtain a valid wrap adapter
   */
  constructor(
    DEXAdapter.Addresses memory _dexAddresses,
    IController _setController,
    IDebtIssuanceModule _debtIssuanceModule,
    address _wrapModule
  ) public {
    setController = _setController;
    debtIssuanceModule = _debtIssuanceModule;
    dexAdapter = _dexAddresses;
    wrapModule = _wrapModule;
  }

  /* ============ External Functions ============ */
  receive() external payable {
    // required for weth.withdraw() to work properly
    require(msg.sender == dexAdapter.weth, "FlashMint: DEPOSITS_NOT_ALLOWED");
  }

  /**
   * Runs all the necessary approval functions required before issuing
   * or redeeming a SetToken. This function need to be called only once before the first time
   * this smart contract is used on any particular SetToken.
   *
   * @param _setToken          Address of the SetToken being initialized
   */
  function approveSetToken(ISetToken _setToken) external {
    address[] memory _components = _setToken.getComponents();
    for (uint256 i = 0; i < _components.length; ++i) {
      DEXAdapter._safeApprove(IERC20(_components[i]), address(debtIssuanceModule), MAX_UINT256);
    }
  }

  /**
   * Issues an exact amount of SetTokens for given amount of input ERC20 tokens.
   * The excess amount of input tokens is returned.
   * The sender must have approved the _maxAmountInputToken for input token to this contract.
   *
   * @param _setToken              Address of the SetToken to be issued
   * @param _inputToken            Address of the ERC20 input token
   * @param _amountSetToken        Amount of SetTokens to issue
   * @param _maxAmountInputToken   Maximum amount of input tokens to be used
   * @param _swapData              ComponentSwapData (inputToken -> component) for each set component in the same order
   * @param _wrapData              ComponentWrapData (unwrapped -> wrapped Set component) for each set component in the same order
   *
   * @return totalInputTokenSold   Amount of input tokens spent for issuance
   */
  function issueExactSetFromERC20(
    ISetToken _setToken,
    IERC20 _inputToken,
    uint256 _amountSetToken,
    uint256 _maxAmountInputToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData
  ) external nonReentrant returns (uint256) {
    return
      _issueExactSet(
        _setToken,
        _inputToken,
        _amountSetToken,
        _maxAmountInputToken,
        _swapData,
        _wrapData,
        false
      );
  }

  /**
   * Issues an exact amount of SetTokens for given amount of ETH. Max amount of ETH used is the transferred amount in msg.value.
   * The excess amount of input ETH is returned.
   *
   * @param _setToken              Address of the SetToken to be issued
   * @param _amountSetToken        Amount of SetTokens to issue
   * @param _swapData              ComponentSwapData (WETH -> component) for each set component in the same order
   * @param _wrapData              ComponentWrapData (unwrapped -> wrapped Set component) for each set component in the same order
   *
   * @return totalETHSold          Amount of ETH spent for issuance
   */
  function issueExactSetFromETH(
    ISetToken _setToken,
    uint256 _amountSetToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData
  ) external payable nonReentrant returns (uint256) {
    // input token for all operations is WETH (any sent in ETH will be wrapped)
    IERC20 inputToken = IERC20(dexAdapter.weth);
    uint256 maxAmountInputToken = msg.value; // = deposited amount ETH -> WETH

    return
      _issueExactSet(
        _setToken,
        inputToken,
        _amountSetToken,
        maxAmountInputToken,
        _swapData,
        _wrapData,
        true
      );
  }

  /**
   * Redeems an exact amount of SetTokens for an ERC20 token.
   * The sender must have approved the _amountSetToken of _setToken to this contract.
   *
   * @param _setToken              Address of the SetToken to be redeemed
   * @param _outputToken           Address of the ERC20 output token
   * @param _amountSetToken        Amount of SetTokens to redeem
   * @param _minOutputReceive      Minimum amount of output tokens to be received
   * @param _swapData              ComponentSwapData (underlyingERC20 -> output token) for each _redeemComponents in the same order
   * @param _unwrapData            ComponentWrapData (wrapped Set component -> underlyingERC20) for each _redeemComponents in the same order
   *
   * @return outputAmount          Amount of output tokens sent to the caller
   */
  function redeemExactSetForToken(
    ISetToken _setToken,
    IERC20 _outputToken,
    uint256 _amountSetToken,
    uint256 _minOutputReceive,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _unwrapData
  ) external nonReentrant returns (uint256) {
    return
      _redeemExactSet(
        _setToken,
        _outputToken,
        _amountSetToken,
        _minOutputReceive,
        _swapData,
        _unwrapData,
        false
      );
  }

  /**
   * Redeems an exact amount of SetTokens for ETH.
   * The sender must have approved the _amountSetToken of _setToken to this contract.
   *
   * @param _setToken              Address of the SetToken to be redemeed
   * @param _amountSetToken        Amount of SetTokens to redeem
   * @param _minOutputReceive      Minimum amount of output tokens to be received
   * @param _swapData              ComponentSwapData (underlyingERC20 -> output token) for each _redeemComponents in the same order
   * @param _unwrapData            ComponentWrapData (wrapped Set component -> underlyingERC20) for each _redeemComponents in the same order
   *
   * @return outputAmount          Amount of ETH sent to the caller
   */
  function redeemExactSetForETH(
    ISetToken _setToken,
    uint256 _amountSetToken,
    uint256 _minOutputReceive,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _unwrapData
  ) external nonReentrant returns (uint256) {
    // output token for all operations is WETH (it will be unwrapped in the end and sent as ETH)
    IERC20 outputToken = IERC20(dexAdapter.weth);

    return
      _redeemExactSet(
        _setToken,
        outputToken,
        _amountSetToken,
        _minOutputReceive,
        _swapData,
        _unwrapData,
        true
      );
  }

  /* ============ Internal Functions ============ */

  /**
   * Issues an exact amount of SetTokens for given amount of input. Excess amounts are returned
   *
   * @param _setToken                   Address of the SetToken to be issued
   * @param _inputToken                 Address of the ERC20 input token
   * @param _amountSetToken             Amount of SetTokens to issue
   * @param _maxAmountInputToken        Maximum amount of input tokens to be used
   * @param _swapData                   ComponentSwapData (input token -> underlyingERC20) for each _requiredComponents in the same order
   * @param _wrapData                   ComponentWrapData (underlyingERC20 -> wrapped Set component) for each _requiredComponents in the same order
   * @param _issueFromETH               boolean flag to identify if issuing from ETH or from ERC20 tokens
   *
   * @return totalInputSold             Amount of input token spent for issuance
   */
  function _issueExactSet(
    ISetToken _setToken,
    IERC20 _inputToken,
    uint256 _amountSetToken,
    uint256 _maxAmountInputToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData,
    bool _issueFromETH
  ) internal returns (uint256) {
    // 1. validate input params, get required components with amounts and snapshot input token balance before
    uint256 inputTokenBalanceBefore = IERC20(_inputToken).balanceOf(address(this));
    // Prevent stack too deep
    {
      (
        address[] memory requiredComponents,
        uint256[] memory requiredAmounts
      ) = _validateIssueParams(
          _setToken,
          _inputToken,
          _amountSetToken,
          _maxAmountInputToken,
          _swapData,
          _wrapData
        );

      // 2. transfer input to this contract
      if (_issueFromETH) {
        // wrap sent in ETH to WETH for all operations
        IWETH(dexAdapter.weth).deposit{value: msg.value}();
      } else {
        _inputToken.safeTransferFrom(msg.sender, address(this), _maxAmountInputToken);
      }

      // 3. swap input token to all components, then wrap them if needed
      _swapAndWrapComponents(
        _inputToken,
        _maxAmountInputToken,
        _swapData,
        _wrapData,
        requiredComponents,
        requiredAmounts
      );
    }

    // 4. issue set tokens
    debtIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);

    // 5. ensure not too much of input token was spent (covers case where initial input token balance was > 0)
    uint256 spentInputTokenAmount = _validateMaxAmountInputToken(
      _inputToken,
      inputTokenBalanceBefore,
      _maxAmountInputToken
    );

    // 6. return excess inputs
    _returnExcessInput(_inputToken, _maxAmountInputToken, spentInputTokenAmount, _issueFromETH);

    // 7. emit event and return amount spent
    emit FlashMint(
      msg.sender,
      _setToken,
      _issueFromETH ? IERC20(DEXAdapter.ETH_ADDRESS) : _inputToken,
      spentInputTokenAmount,
      _amountSetToken
    );

    return spentInputTokenAmount;
  }

  /**
   * Redeems an exact amount of SetTokens.
   *
   * @param _setToken              Address of the SetToken to be issued
   * @param _outputToken           Address of the ERC20 output token
   * @param _amountSetToken        Amount of SetTokens to redeem
   * @param _minOutputReceive      Minimum amount of output tokens to be received
   * @param _swapData              ComponentSwapData (underlyingERC20 -> output token) for each _redeemComponents in the same order
   * @param _unwrapData            ComponentWrapData (wrapped Set component -> underlyingERC20) for each _redeemComponents in the same order
   * @param _redeemToETH           boolean flag to identify if redeeming to ETH or to ERC20 tokens
   *
   * @return outputAmount          Amount of output received
   */
  function _redeemExactSet(
    ISetToken _setToken,
    IERC20 _outputToken,
    uint256 _amountSetToken,
    uint256 _minOutputReceive,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _unwrapData,
    bool _redeemToETH
  ) internal returns (uint256) {
    // 1. validate input params and get required components
    (address[] memory redeemComponents, uint256[] memory redeemAmounts) = _validateRedeemParams(
      _setToken,
      _outputToken,
      _amountSetToken,
      _swapData,
      _unwrapData
    );

    // 2. transfer set tokens to be redeemed to this
    _setToken.safeTransferFrom(msg.sender, address(this), _amountSetToken);

    // 3. redeem set tokens
    debtIssuanceModule.redeem(_setToken, _amountSetToken, address(this));

    // 4. unwrap all components if needed and swap them to output token
    uint256 totalOutputTokenObtained = _unwrapAndSwapComponents(
      _outputToken,
      _swapData,
      _unwrapData,
      redeemComponents,
      redeemAmounts
    );

    // 5. ensure expected minimum output amount has been obtained
    require(totalOutputTokenObtained >= _minOutputReceive, "FlashMint: INSUFFICIENT_OUTPUT_AMOUNT");

    // 6. transfer obtained output tokens to msg.sender
    _sendObtainedOutputToSender(_outputToken, totalOutputTokenObtained, _redeemToETH);

    // 7. emit event and return amount obtained
    emit FlashRedeem(
      msg.sender,
      _setToken,
      _redeemToETH ? IERC20(DEXAdapter.ETH_ADDRESS) : _outputToken,
      _amountSetToken,
      totalOutputTokenObtained
    );

    return totalOutputTokenObtained;
  }

  /**
   * Validates input params for _issueExactSet operations
   *
   * @param _setToken                   Address of the SetToken to be redeemed
   * @param _inputToken                 Input token that will be sold
   * @param _amountSetToken             Amount of SetTokens to issue
   * @param _maxAmountToken             Maximum amount of input token to spend
   * @param _swapData                   ComponentSwapData (input token -> underlyingERC20) for each _requiredComponents in the same order
   * @param _wrapData                   ComponentWrapData (underlyingERC20 -> wrapped Set component) for each _requiredComponents in the same order
   *
   * @return requiredComponents         Array of required issuance components gotten from DebtIssuanceModule.getRequiredComponentIssuanceUnits()
   * @return requiredAmounts            Array of required issuance component amounts gotten from DebtIssuanceModule.getRequiredComponentIssuanceUnits()
   */
  function _validateIssueParams(
    ISetToken _setToken,
    IERC20 _inputToken,
    uint256 _amountSetToken,
    uint256 _maxAmountToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData
  )
    internal
    view
    isSetToken(_setToken)
    returns (address[] memory requiredComponents, uint256[] memory requiredAmounts)
  {
    require(
      _amountSetToken > 0 && _maxAmountToken > 0 && address(_inputToken) != address(0),
      "FlashMint: INVALID_INPUTS"
    );

    (requiredComponents, requiredAmounts, ) = debtIssuanceModule.getRequiredComponentIssuanceUnits(
      _setToken,
      _amountSetToken
    );

    require(
      _wrapData.length == _swapData.length && _wrapData.length == requiredComponents.length,
      "FlashMint: MISMATCH_INPUT_ARRAYS"
    );
  }

  /**
   * Validates input params for _redeemExactSet operations
   *
   * @param _setToken                   Address of the SetToken to be redeemed
   * @param _outputToken                Output token that will be redeemed to
   * @param _amountSetToken             Amount of SetTokens to redeem
   * @param _swapData                   ComponentSwapData (underlyingERC20 -> output token) for each _redeemComponents in the same order
   * @param _unwrapData                 ComponentWrapData (wrapped Set component -> underlyingERC20) for each _redeemComponents in the same order
   *
   * @return redeemComponents          Array of redemption components gotten from DebtIssuanceModule.getRequiredComponentRedemptionUnits()
   * @return redeemAmounts             Array of redemption component amounts gotten from DebtIssuanceModule.getRequiredComponentRedemptionUnits()
   */
  function _validateRedeemParams(
    ISetToken _setToken,
    IERC20 _outputToken,
    uint256 _amountSetToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _unwrapData
  )
    internal
    view
    isSetToken(_setToken)
    returns (address[] memory redeemComponents, uint256[] memory redeemAmounts)
  {
    require(
      _amountSetToken > 0 && address(_outputToken) != address(0),
      "FlashMint: INVALID_INPUTS"
    );

    (redeemComponents, redeemAmounts, ) = debtIssuanceModule.getRequiredComponentRedemptionUnits(
      _setToken,
      _amountSetToken
    );

    require(
      _unwrapData.length == _swapData.length && _unwrapData.length == redeemComponents.length,
      "FlashMint: MISMATCH_INPUT_ARRAYS"
    );
  }

  /**
   * Swaps and then wraps each _requiredComponents sequentially based on _swapData and _wrapData
   *
   * @param _inputToken                 Input token that will be sold
   * @param _maxAmountInputToken        Maximum amount of input token that can be spent
   * @param _swapData                   ComponentSwapData (input token -> underlyingERC20) for each _requiredComponents in the same order
   * @param _wrapData                   ComponentWrapData (underlyingERC20 -> wrapped Set component) for each _requiredComponents in the same order
   * @param _requiredComponents         Issuance components gotten from DebtIssuanceModule.getRequiredComponentIssuanceUnits()
   * @param _requiredAmounts            Issuance units gotten from DebtIssuanceModule.getRequiredComponentIssuanceUnits()
   */
  function _swapAndWrapComponents(
    IERC20 _inputToken,
    uint256 _maxAmountInputToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData,
    address[] memory _requiredComponents,
    uint256[] memory _requiredAmounts
  ) internal {
    // if the required set components contain the input token, we have to make sure that the required amount
    // for issuance is actually still left over at the end of swapping and wrapping
    uint256 requiredLeftOverInputTokenAmount = 0;

    // for each component in the swapData / wrapData / requiredComponents array:
    // 1. swap from input token to unwrapped component (exact to buyUnderlyingAmount)
    // 2. wrap from unwrapped component to wrapped component (unless unwrapped component == wrapped component)
    // 3. ensure amount in contract covers required amount for issuance
    for (uint256 i = 0; i < _requiredComponents.length; ++i) {
      // if the required set component is the input token, no swapping or wrapping is needed
      if (address(_inputToken) == _requiredComponents[i]) {
        requiredLeftOverInputTokenAmount = _requiredAmounts[i];
        continue;
      }

      // snapshot balance of required component before swap and wrap operations
      uint256 componentBalanceBefore = IERC20(_requiredComponents[i]).balanceOf(address(this));

      // swap input token to unwrapped token
      _swapToExact(
        _inputToken, // input
        IERC20(_swapData[i].underlyingERC20), // output
        _swapData[i].buyUnderlyingAmount, // buy amount: must come from flash mint caller, we do not know the exchange rate wrapped <> unwrapped
        _maxAmountInputToken, // maximum spend amount: _maxAmountInputToken as transferred by the flash mint caller
        _swapData[i].dexData // dex path fees data etc.
      );

      // transform unwrapped token into wrapped version (unless it's the same)
      if (_swapData[i].underlyingERC20 != _requiredComponents[i]) {
        _wrapComponent(
          _requiredComponents[i],
          _swapData[i].buyUnderlyingAmount,
          _swapData[i].underlyingERC20,
          _wrapData[i]
        );
      }

      // ensure obtained component amount covers required component amount for issuance
      // this is not already covered through _swapToExact because it does not take wrapping into consideration
      uint256 componentBalanceAfter = IERC20(_requiredComponents[i]).balanceOf(address(this));
      uint256 _omponentAmountObtained = componentBalanceAfter.sub(componentBalanceBefore);
      require(_omponentAmountObtained >= _requiredAmounts[i], "FlashMint: UNDERBOUGHT_COMPONENT");
    }

    // ensure left over input token amount covers issuance for component if input token is one of the Set components
    require(
      IERC20(_inputToken).balanceOf(address(this)) >= requiredLeftOverInputTokenAmount,
      "FlashMint: NOT_ENOUGH_INPUT"
    );
  }

  /**
   * Unwraps and then swaps each _redeemComponents sequentially based on _swapData and _unwrapData
   *
   * @param _outputToken                Output token that will be bought
   * @param _swapData                   ComponentSwapData (underlyingERC20 -> output token) for each _redeemComponents in the same order
   * @param _unwrapData                 ComponentWrapData (wrapped Set component -> underlyingERC20) for each _redeemComponents in the same order
   * @param _redeemComponents           redemption components gotten from DebtIssuanceModule.getRequiredComponentRedemptionUnits()
   * @param _redeemAmounts              redemption units gotten from DebtIssuanceModule.getRequiredComponentRedemptionUnits()
   *
   * @return totalOutputTokenObtained   total output token amount obtained
   */
  function _unwrapAndSwapComponents(
    IERC20 _outputToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _unwrapData,
    address[] memory _redeemComponents,
    uint256[] memory _redeemAmounts
  ) internal returns (uint256 totalOutputTokenObtained) {
    // for each component in the swapData / wrapData / redeemComponents array:
    // 1. unwrap from wrapped set component to unwrapped underlyingERC20 in swapData
    // 2. swap from underlyingERC20 token to output token (exact from obtained underlyingERC20 amount)

    for (uint256 i = 0; i < _redeemComponents.length; ++i) {
      // default redeemed amount is maximum possible amount that was redeemed for this component
      // this is recomputed if the redeemed amount is unwrapped to the actual unwrapped amount
      uint256 redeemedAmount = _redeemAmounts[i];

      // if the set component is the output token, no swapping or wrapping is needed
      if (address(_outputToken) == _redeemComponents[i]) {
        // add maximum possible amount that was redeemed for this component to totalOutputTokenObtained (=_redeemAmounts[i])
        totalOutputTokenObtained = totalOutputTokenObtained.add(redeemedAmount);
        continue;
      }

      // transform wrapped token into unwrapped version (unless it's the same)
      if (_swapData[i].underlyingERC20 != _redeemComponents[i]) {
        // snapshot unwrapped balance before to compute the actual redeemed amount of unwrapped token (due to unknown exchange rate)
        uint256 unwrappedBalanceBefore = IERC20(_swapData[i].underlyingERC20).balanceOf(
          address(this)
        );

        _unwrapComponent(
          _redeemComponents[i],
          _redeemAmounts[i],
          _swapData[i].underlyingERC20,
          _unwrapData[i]
        );

        // recompute actual redeemed amount to the underlyingERC20 token amount obtained through unwrapping
        uint256 unwrappedBalanceAfter = IERC20(_swapData[i].underlyingERC20).balanceOf(
          address(this)
        );
        redeemedAmount = unwrappedBalanceAfter.sub(unwrappedBalanceBefore);
      }

      // swap redeemed and unwrapped component to output token
      uint256 boughtOutputTokenAmount = _swapFromExact(
        IERC20(_swapData[i].underlyingERC20), // input
        _outputToken, // output
        redeemedAmount, // sell amount of input token
        _swapData[i].dexData // dex path fees data etc.
      );

      totalOutputTokenObtained = totalOutputTokenObtained.add(boughtOutputTokenAmount);
    }
  }

  /**
   * Swaps _inputToken to exact _amount to _outputToken through _swapDexData
   *
   * @param _inputToken           Input token that will be sold
   * @param _outputToken          Output token that will be bought
   * @param _amount               Amount that will be bought
   * @param _maxAmountIn          Maximum aount of input token that can be spent
   * @param _swapDexData          DEXAdapter.SwapData with path, fees, etc. for inputToken -> outputToken swap
   *
   * @return Amount of spent _inputToken
   */
  function _swapToExact(
    IERC20 _inputToken,
    IERC20 _outputToken,
    uint256 _amount,
    uint256 _maxAmountIn,
    DEXAdapter.SwapData calldata _swapDexData
  )
    internal
    isValidPath(_swapDexData.path, address(_inputToken), address(_outputToken))
    returns (uint256)
  {
    // safe approves are done right in the dexAdapter library
    return dexAdapter.swapTokensForExactTokens(_amount, _maxAmountIn, _swapDexData);
  }

  /**
   * Swaps exact _amount of _inputToken to _outputToken through _swapDexData
   *
   * @param _inputToken           Input token that will be sold
   * @param _outputToken          Output token that will be bought
   * @param _amount               Amount that will be sold
   * @param _swapDexData          DEXAdapter.SwapData with path, fees, etc. for inputToken -> outputToken swap
   *
   * @return amount of received _outputToken
   */
  function _swapFromExact(
    IERC20 _inputToken,
    IERC20 _outputToken,
    uint256 _amount,
    DEXAdapter.SwapData calldata _swapDexData
  )
    internal
    isValidPath(_swapDexData.path, address(_inputToken), address(_outputToken))
    returns (uint256)
  {
    // safe approves are done right in the dexAdapter library
    return
      dexAdapter.swapExactTokensForTokens(
        _amount,
        // _minAmountOut is 0 here since we don't know what to check against because for wrapped components
        // we only have the required amounts for the wrapped component, but not for the underlying we swap to here
        // This is covered indirectly in later checks though
        // e.g. directly through the issue call (not enough _outputToken -> wrappedComponent -> issue will fail)
        0,
        _swapDexData
      );
  }

  /**
   * Wraps _wrapAmount of _underlyingToken to _wrappedComponent component
   *
   * @param _wrappedComponent           Address of wrapped component (e.g. cDAI)
   * @param _wrapAmount                 amount of _underlyingToken to wrap
   * @param _underlyingToken            underlying (unwrapped) token to wrap from (e.g. DAI)
   * @param _wrapData                   ComponentWrapData that contains the integration (adapter) name and optional bytes data
   */
  function _wrapComponent(
    address _wrappedComponent,
    uint256 _wrapAmount,
    address _underlyingToken,
    ComponentWrapData calldata _wrapData
  ) internal {
    // 1. get the wrap adapter directly from the integration registry

    // Note we could get the address of the adapter directly in the params instead of the integration name
    // but that would allow integrators to use their own potentially somehow malicious WrapAdapter
    // by directly fetching it from our IntegrationRegistry we can be sure that it behaves as expected
    IWrapV2Adapter wrapAdapter = IWrapV2Adapter(_getAndValidateAdapter(_wrapData.integrationName));

    // 2. get wrap call info from adapter
    (address wrapCallTarget, uint256 wrapCallValue, bytes memory wrapCallData) = wrapAdapter
      .getWrapCallData(
        _underlyingToken,
        _wrappedComponent,
        _wrapAmount,
        address(this),
        _wrapData.wrapData
      );

    // 3. approve unwrapped token transfer from this to _wrapCallTarget
    DEXAdapter._safeApprove(IERC20(_underlyingToken), wrapCallTarget, _wrapAmount);

    // 4. invoke wrap function call
    wrapCallTarget.functionCallWithValue(wrapCallData, wrapCallValue);
  }

  /**
   * Unwraps _unwrapAmount of _wrappedComponent to _underlyingToken
   *
   * @param _wrappedComponent           Address of wrapped component (e.g. cDAI)
   * @param _unwrapAmount               amount of _wrappedComponent to unwrap
   * @param _underlyingToken            underlying (unwrapped) token _wrappedComponent will unwrap to (e.g. DAI)
   * @param _wrapData                   ComponentWrapData that contains the integration (adapter) name and optional bytes data
   */
  function _unwrapComponent(
    address _wrappedComponent,
    uint256 _unwrapAmount,
    address _underlyingToken,
    ComponentWrapData calldata _wrapData
  ) internal {
    // 1. get the wrap adapter directly from the integration registry

    // Note we could get the address of the adapter directly in the params instead of the integration name
    // but that would allow integrators to use their own potentially somehow malicious WrapAdapter
    // by directly fetching it from our IntegrationRegistry we can be sure that it behaves as expected
    IWrapV2Adapter wrapAdapter = IWrapV2Adapter(_getAndValidateAdapter(_wrapData.integrationName));

    // 2. get wrap call info from adapter
    (address wrapCallTarget, uint256 wrapCallValue, bytes memory wrapCallData) = wrapAdapter
      .getUnwrapCallData(
        _underlyingToken,
        _wrappedComponent,
        _unwrapAmount,
        address(this),
        _wrapData.wrapData
      );

    // 3. approve wrapped token transfer from this to _wrapCallTarget
    DEXAdapter._safeApprove(IERC20(_wrappedComponent), wrapCallTarget, _unwrapAmount);

    // 4. invoke wrap function call
    wrapCallTarget.functionCallWithValue(wrapCallData, wrapCallValue);
  }

  /**
   * Validates that not more than the requested max amount of the input token has been spent
   *
   * @param _inputToken                 Address of the input token to return
   * @param _inputTokenBalanceBefore    input token balance before at the beginning of the operation
   * @param _maxAmountInputToken        maximum amount that could be spent

   * @return spentInputTokenAmount      actual spent amount of the input token
   */
  function _validateMaxAmountInputToken(
    IERC20 _inputToken,
    uint256 _inputTokenBalanceBefore,
    uint256 _maxAmountInputToken
  ) internal view returns (uint256 spentInputTokenAmount) {
    uint256 inputTokenBalanceAfter = _inputToken.balanceOf(address(this));

    // _maxAmountInputToken amount has been transferred to this contract after _inputTokenBalanceBefore snapshot
    spentInputTokenAmount = _inputTokenBalanceBefore.add(_maxAmountInputToken).sub(
      inputTokenBalanceAfter
    );

    require(spentInputTokenAmount <= _maxAmountInputToken, "FlashMint: OVERSPENT_INPUT_TOKEN");
  }

  /**
   * Returns excess input token
   *
   * @param _inputToken         Address of the input token to return
   * @param _receivedAmount     Amount received by the caller
   * @param _spentAmount        Amount spent for issuance
   * @param _returnETH          Boolean flag to identify if ETH should be returned or the input token
   */
  function _returnExcessInput(
    IERC20 _inputToken,
    uint256 _receivedAmount,
    uint256 _spentAmount,
    bool _returnETH
  ) internal {
    uint256 amountTokenReturn = _receivedAmount.sub(_spentAmount);
    if (amountTokenReturn > 0) {
      if (_returnETH) {
        // unwrap from WETH -> ETH and send ETH amount back to sender
        IWETH(dexAdapter.weth).withdraw(amountTokenReturn);
        (payable(msg.sender)).sendValue(amountTokenReturn);
      } else {
        _inputToken.safeTransfer(msg.sender, amountTokenReturn);
      }
    }
  }

  /**
   * Sends the obtained amount of output token / ETH to msg.sender
   *
   * @param _outputToken         Address of the output token to return
   * @param _amount              Amount to transfer
   * @param _redeemToETH         Boolean flag to identify if ETH or the output token should be sent
   */
  function _sendObtainedOutputToSender(
    IERC20 _outputToken,
    uint256 _amount,
    bool _redeemToETH
  ) internal {
    if (_redeemToETH) {
      // unwrap from WETH -> ETH and send ETH amount back to sender
      IWETH(dexAdapter.weth).withdraw(_amount);
      (payable(msg.sender)).sendValue(_amount);
    } else {
      _outputToken.safeTransfer(msg.sender, _amount);
    }
  }

  /**
   * Gets the integration for the passed in name listed on the wrapModule. Validates that the address is not empty
   *
   * @param _integrationName      Name of wrap adapter integration (mapping on integration registry)
   *
   * @return adapter              address of the wrap adapter
   */
  function _getAndValidateAdapter(string memory _integrationName)
    internal
    view
    returns (address adapter)
  {
    IIntegrationRegistry integrationRegistry = setController.getIntegrationRegistry();

    integrationRegistry.getIntegrationAdapterWithHash(
      wrapModule,
      keccak256(bytes(_integrationName))
    );

    require(adapter != address(0), "FlashMint: WRAP_ADAPTER_INVALID");
  }
}
