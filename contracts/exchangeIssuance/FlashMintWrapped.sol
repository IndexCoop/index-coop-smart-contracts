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
import {IWrapModuleV2} from "../interfaces/IWrapModuleV2.sol";
import {IDebtIssuanceModule} from "../interfaces/IDebtIssuanceModule.sol";
import {ISetToken} from "../interfaces/ISetToken.sol";
import {IWETH} from "../interfaces/IWETH.sol";

import {Withdrawable} from "external/contracts/aaveV2/utils/Withdrawable.sol";
import {DEXAdapter} from "./DEXAdapter.sol";

/**
 * @title FlashMintWrapped
 *
 * Flash issues SetTokens whose components are purely made up of wrapped tokens.
 * In particular, for issuance, the contract needs to:
 * 1. For all components in a SetToken, swap input token into matching unwrapped component
 * 2. For each unwrapped component, execute the wrapping function
 * 3. Call on issuanceModule to issue tokens
 *
 * Compatible with
 * IssuanceModules: DebtIssuanceModule, DebtIssuanceModuleV2
 * WrapModules: WrapModuleV2
 *
 * Supports flash minting for sets that contain both unwrapped and wrapped components
 * wrapping can be skipped for a component by setting the wrappedERC20 address = unwrappedERC20 address
 * if set contains both wrapped and unwrapped versions -> supply two separate component data points,
 * BUT the wrapped component must be listed FIRST
 * e.g.
 * ComponentSwapData[0].unwrappedERC20 = DAI; ComponentWrapData[0].wrappedERC20 = cDAI -> wrapped (LISTED BEFORE UNWRAPPED!)
 * ComponentSwapData[1].unwrappedERC20 = DAI; ComponentWrapData[1].wrappedERC20 = DAI -> no wrapping
 */
contract FlashMintWrapped is ReentrancyGuard, Withdrawable {
  using DEXAdapter for DEXAdapter.Addresses;
  using Address for address payable;
  using Address for address;
  using SafeMath for uint256;
  using SafeERC20 for IERC20;

  struct ComponentSwapData {
    // unwrapped token version, e.g. DAI
    address unwrappedERC20;
    // amount that has to be bought of the unwrapped token version (to cover required wrapped component amounts for issuance)
    // this amount has to be computed beforehand through the exchange rate of wrapped Component <> unwrappedComponent
    // i.e. getRequiredComponentIssuanceUnits() on the IssuanceModule and then convert units through exchange rate to unwrapped component units
    // e.g. 300 cDAI needed for issuance of 1 Set token. exchange rate 1cDAI = 0.05 DAI. -> buyUnwrappedAmount = 0.05 DAI * 300 = 15 DAI
    uint256 buyUnwrappedAmount;
    // swap data for DEX operation: fees, path, etc. see DEXAdapter.SwapData
    DEXAdapter.SwapData dexData;
  }

  struct ComponentWrapData {
    string integrationName; // wrap adapter integration name as listed in the IntegrationRegistry for the wrapModule
    bytes wrapData; // optional wrapData passed to the WrapModuleV2
  }

  /* ============ Enums ============ */

  /* ============ Constants ============= */

  uint256 private constant MAX_UINT256 = type(uint256).max;

  /* ============ State Variables ============ */

  IController public immutable setController;
  IDebtIssuanceModule public immutable debtIssuanceModule; // interface is compatible with DebtIssuanceModuleV2
  IWrapModuleV2 public immutable wrapModule; // used to obtain a valid wrap adapter
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

  modifier isSetToken(ISetToken _setToken) {
    require(setController.isSet(address(_setToken)), "ExchangeIssuance: INVALID SET");
    _;
  }

  modifier isValidModule(address _issuanceModule) {
    require(setController.isModule(_issuanceModule), "ExchangeIssuance: INVALID ISSUANCE MODULE");
    _;
  }

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
   * @param _wrapModule                WrapModuleV2 used to obtain a valid wrap adapter
   */
  constructor(
    DEXAdapter.Addresses memory _dexAddresses,
    IController _setController,
    IDebtIssuanceModule _debtIssuanceModule,
    IWrapModuleV2 _wrapModule
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
   *
   * @param _setToken              Address of the SetToken to be issued
   * @param _inputToken            Address of the ERC20 input token
   * @param _amountSetToken        Amount of SetTokens to issue
   * @param _maxAmountInputToken   Maximum amount of input tokens to be used
   * @param _swapData              ComponentSwapData for each required set token component in the exact same order
   * @param _wrapData              ComponentWrapData for each required set token component in the exact same order
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
   * @param _swapData              ComponentSwapData for each required set token component in the exact same order
   * @param _wrapData              ComponentWrapData for each required set token component in the exact same order
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
    IERC20 _inputToken = IERC20(dexAdapter.weth);
    uint256 _maxAmountInputToken = msg.value; // = deposited amount ETH -> WETH

    return
      _issueExactSet(
        _setToken,
        _inputToken,
        _amountSetToken,
        _maxAmountInputToken,
        _swapData,
        _wrapData,
        true
      );
  }

  // /**
  //  * Redeems an exact amount of SetTokens for an ERC20 token.
  //  * The SetToken must be approved by the sender to this contract.
  //  *
  //  * @param _setToken             Address of the SetToken being redeemed
  //  * @param _outputToken          Address of output token
  //  * @param _amountSetToken       Amount SetTokens to redeem
  //  * @param _minOutputReceive     Minimum amount of output token to receive
  //  * @param _componentQuotes      The encoded 0x transactions execute (components -> WETH).
  //  * @param _issuanceModule       Address of issuance Module to use
  //  * @param _isDebtIssuance       Flag indicating wether given issuance module is a debt issuance module
  //  *
  //  * @return outputAmount         Amount of output tokens sent to the caller
  //  */
  function redeemExactSetForToken(
    ISetToken _setToken,
    IERC20 _outputToken,
    uint256 _amountSetToken,
    uint256 _minOutputReceive,
    address _issuanceModule
  ) external nonReentrant returns (uint256) {
    return 0;
  }

  // /**
  //  * Redeems an exact amount of SetTokens for ETH.
  //  * The SetToken must be approved by the sender to this contract.
  //  *
  //  * @param _setToken             Address of the SetToken being redeemed
  //  * @param _amountSetToken       Amount SetTokens to redeem
  //  * @param _minEthReceive        Minimum amount of Eth to receive
  //  * @param _componentQuotes      The encoded 0x transactions execute
  //  * @param _issuanceModule       Address of issuance Module to use
  //  * @param _isDebtIssuance       Flag indicating wether given issuance module is a debt issuance module
  //  *
  //  * @return outputAmount         Amount of output tokens sent to the caller
  //  */
  function redeemExactSetForETH(
    ISetToken _setToken,
    uint256 _amountSetToken,
    uint256 _minEthReceive,
    address _issuanceModule
  ) external nonReentrant returns (uint256) {
    return 0;
  }

  /* ============ Internal Functions ============ */

  /**
   * Issues an exact amount of SetTokens for given amount of input. Excess amounts are returned
   *
   * @param _setToken              Address of the SetToken to be issued
   * @param _inputToken            Address of the ERC20 input token
   * @param _amountSetToken        Amount of SetTokens to issue
   * @param _maxAmountInputToken   Maximum amount of input tokens to be used
   * @param _swapData              ComponentSwapData for each required set token component in the exact same order
   * @param _wrapData              ComponentWrapData for each required set token component in the exact same order
   * @param _issueFromETH          boolean flag to identify if issuing from ETH or from ERC20 tokens
   *
   * @return totalInputSold        Amount of input spent for issuance
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
    (
      uint256 _inputTokenBalanceBefore,
      address[] memory _requiredComponents,
      uint256[] memory _requiredPositions
    ) = _validateParams(
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
      _swapData,
      _wrapData,
      _requiredComponents,
      _requiredPositions
    );

    // 4. issue set tokens
    debtIssuanceModule.issue(_setToken, _amountSetToken, msg.sender);

    // 5. ensure not too much of input token was spent (covers case where initial input token balance was > 0)
    uint256 _spentInputTokenAmount = _validateMaxAmountInputToken(
      _inputToken,
      _inputTokenBalanceBefore,
      _maxAmountInputToken
    );

    // 6. return excess inputs
    _returnExcessInput(_inputToken, _maxAmountInputToken, _spentInputTokenAmount, _issueFromETH);

    // 7. emit event and return amount spent
    emit FlashMint(
      msg.sender,
      _setToken,
      _issueFromETH ? IERC20(DEXAdapter.ETH_ADDRESS) : _inputToken,
      _spentInputTokenAmount,
      _amountSetToken
    );

    return _spentInputTokenAmount;
  }

  function _validateParams(
    ISetToken _setToken,
    IERC20 _inputToken,
    uint256 _amountSetToken,
    uint256 _maxAmountInputToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData
  )
    internal
    view
    isSetToken(_setToken)
    returns (
      uint256 _inputTokenBalanceBefore,
      address[] memory _requiredComponents,
      uint256[] memory _requiredPositions
    )
  {
    require(_amountSetToken > 0 && _maxAmountInputToken > 0, "FlashMint: INVALID_INPUTS");
    require(address(_inputToken) != address(0), "FlashMint: INVALID_INPUTS");

    (_requiredComponents, _requiredPositions, ) = debtIssuanceModule
      .getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);

    require(
      _wrapData.length == _swapData.length && _wrapData.length == _requiredComponents.length,
      "FlashMint: UNMATCHING_INPUT_ARRAYS"
    );

    // Check that the set token does not have external positions
    for (uint256 i = 0; i < _swapData.length; ++i) {
      require(
        _setToken.getExternalPositionModules(_requiredComponents[i]).length == 0,
        "FlashMint: EXTERNAL_POSITIONS_NOT_ALLOWED"
      );
    }

    // snapshot initial token balance of input token to validate amounts spent
    _inputTokenBalanceBefore = IERC20(_inputToken).balanceOf(address(this));
  }

  function _swapAndWrapComponents(
    IERC20 _inputToken,
    ComponentSwapData[] calldata _swapData,
    ComponentWrapData[] calldata _wrapData,
    address[] memory _requiredComponents,
    uint256[] memory _requiredPositions
  ) internal {
    // for each component in the swapData / wrapData / requiredComponents array:
    // 1. swap from input token to unwrapped component
    // 2. wrap from unwrapped component to wrapped component (unless unwrapped component == wrapped component)
    // 3. ensure amount in contract covers required amount for issuance
    for (uint256 i = 0; i < _swapData.length; ++i) {
      // if the required set component is the input component, no swapping or wrapping is needed
      if (address(_inputToken) == _requiredComponents[i]) {
        require(
          IERC20(_requiredComponents[i]).balanceOf(address(this)) >= _requiredPositions[i],
          "FlashMint: UNDERBOUGHT_COMPONENT"
        );
        continue;
      }

      // snapshot balance of required component before swap and wrap operations
      uint256 _componentBalanceBefore = IERC20(_requiredComponents[i]).balanceOf(address(this));

      // swap input token to unwrapped token
      uint256 _swappedUnwrappedAmount = _swapComponent(_inputToken, _swapData[i]);

      // transform unwrapped token into wrapped version (unless it's the same)
      if (_swapData[i].unwrappedERC20 != _requiredComponents[i]) {
        _wrapComponent(_requiredComponents[i], _swappedUnwrappedAmount, _swapData[i], _wrapData[i]);
      }

      // ensure obtained component amount covers required component amount for issuance
      uint256 _componentBalanceAfter = IERC20(_requiredComponents[i]).balanceOf(address(this));
      uint256 _componentAmountObtained = _componentBalanceAfter.sub(_componentBalanceBefore);
      require(
        _componentAmountObtained >= _requiredPositions[i],
        "FlashMint: UNDERBOUGHT_COMPONENT"
      );
    }
  }

  /**
   * Swaps the input token to the corresponding component in _swapData.
   *
   * @param _inputToken           Input token that will be sold
   * @param _swapData             ComponentSwapData including unwrapped token to buy, amount to buy, and actual DEXAdapter SwapData
   *
   * @return Amount of unwrapped token obtained
   */
  function _swapComponent(IERC20 _inputToken, ComponentSwapData calldata _swapData)
    internal
    isValidPath(_swapData.dexData.path, address(_inputToken), _swapData.unwrappedERC20)
    returns (uint256)
  {
    // safe approves are done right in the dexAdapter library
    return
      dexAdapter.swapExactTokensForTokens(
        _swapData.buyUnwrappedAmount,
        // minAmountOut is 0 here since we are going to make up the shortfall with the input token.
        // Sandwich protection is provided by the check at the end against _maxAmountInputToken parameter specified by the user
        0,
        _swapData.dexData
      );
  }

  function _wrapComponent(
    address _requiredComponent,
    uint256 _obtainedUnwrappedAmount,
    ComponentSwapData calldata _swapData,
    ComponentWrapData calldata _wrapData
  ) internal {
    // 1. get the wrap adapter directly from the integration registry

    // Note we could get the address of the adapter directly in the params instead of the integration name
    // but that would allow integrators to use their own potentially somehow malicious WrapAdapter
    // by directly fetching it from our IntegrationRegistry we can be sure that it behaves as expected
    IWrapV2Adapter _wrapAdapter = IWrapV2Adapter(_getAndValidateAdapter(_wrapData.integrationName));

    // 2. get wrap call info from adapter
    (address _wrapCallTarget, uint256 _wrapCallValue, bytes memory _wrapCallData) = _wrapAdapter
      .getWrapCallData(
        _swapData.unwrappedERC20,
        _requiredComponent,
        _obtainedUnwrappedAmount,
        address(this),
        _wrapData.wrapData
      );

    // 3. approve token transfer from this to _wrapCallTarget
    DEXAdapter._safeApprove(
      IERC20(_swapData.unwrappedERC20),
      _wrapCallTarget,
      _obtainedUnwrappedAmount
    );

    // 4. invoke wrap function call
    _wrapCallTarget.functionCallWithValue(_wrapCallData, _wrapCallValue);
  }

  function _validateMaxAmountInputToken(
    IERC20 _inputToken,
    uint256 _inputTokenBalanceBefore,
    uint256 _maxAmountInputToken
  ) internal view returns (uint256 _spentInputTokenAmount) {
    uint256 _inputTokenBalanceAfter = _inputToken.balanceOf(address(this));

    _spentInputTokenAmount = _inputTokenBalanceBefore.add(_maxAmountInputToken).sub(
      _inputTokenBalanceAfter
    );

    require(_spentInputTokenAmount <= _maxAmountInputToken, "FlashMint: OVERSPENT_INPUT_TOKEN");
  }

  /**
   * Returns excess input token
   *
   * @param _inputToken         Address of the input token to return
   * @param _receivedAmount     Amount received by the caller
   * @param _spentAmount        Amount spent for issuance
   *
   * @return amountTokenReturn  returned input token / ETH amount to msg.sender
   */
  function _returnExcessInput(
    IERC20 _inputToken,
    uint256 _receivedAmount,
    uint256 _spentAmount,
    bool returnETH
  ) internal {
    uint256 amountTokenReturn = _receivedAmount.sub(_spentAmount);
    if (amountTokenReturn > 0) {
      if (returnETH) {
        // unwrap from WETH -> ETH and send ETH amount back to sender
        IWETH(dexAdapter.weth).withdraw(amountTokenReturn);
        (payable(msg.sender)).sendValue(amountTokenReturn);
      } else {
        _inputToken.safeTransfer(msg.sender, amountTokenReturn);
      }
    }
  }

  /**
   * Gets the integration for the module with the passed in name. Validates that the address is not empty
   */
  function _getAndValidateAdapter(string memory _integrationName)
    internal
    view
    returns (address adapter)
  {
    IIntegrationRegistry _integrationRegistry = setController.getIntegrationRegistry();

    _integrationRegistry.getIntegrationAdapterWithHash(
      address(wrapModule),
      keccak256(bytes(_integrationName))
    );

    require(adapter != address(0), "FlashMint: WRAP_ADAPTER_INVALID");
  }
}
