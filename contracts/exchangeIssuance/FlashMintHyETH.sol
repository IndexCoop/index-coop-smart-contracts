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

import { Address} from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath} from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IERC4626 } from "../interfaces/IERC4626.sol";
import { IStETH } from "../interfaces/external/IStETH.sol";
import { IController } from "../interfaces/IController.sol";
import { IDebtIssuanceModule} from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH} from "../interfaces/IWETH.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { DEXAdapter } from "./DEXAdapter.sol";


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
 *
 * If the set contains both the wrapped and unwrapped version of a token (e.g. DAI and cDAI)
 * ->  two separate component data points have to be supplied in _swapData and _wrapData
 * e.g. for issue
 * Set components at index 0 = DAI; then -> ComponentSwapData[0].underlyingERC20 = DAI; (no wrapping will happen)
 * Set components at index 1 = cDAI; then -> ComponentSwapData[1].underlyingERC20 = DAI; (wrapping will happen)
 */
contract FlashMintWrapped is Ownable, ReentrancyGuard {
  using DEXAdapter for DEXAdapter.Addresses;
  using Address for address payable;
  using Address for address;
  using SafeMath for uint256;
  using SafeERC20 for IERC20;
  using SafeERC20 for ISetToken;


  /* ============ Constants ============= */

  uint256 private constant MAX_UINT256 = type(uint256).max;

  /* ============ Immutables ============ */

  IController public immutable setController;
  IStETH public immutable stETH;
  IDebtIssuanceModule public immutable issuanceModule; // interface is compatible with DebtIssuanceModuleV2

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
    require(setController.isSet(address(_setToken)), "FlashMint: INVALID_SET");
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

  constructor(
    DEXAdapter.Addresses memory _dexAddresses,
    IController _setController,
    IDebtIssuanceModule _issuanceModule,
    IStETH _stETH
  ) public {
    dexAdapter = _dexAddresses;
    setController = _setController;
    issuanceModule = _issuanceModule;
    stETH = _stETH;
  }

  /* ============ External Functions ============ */
  receive() external payable {
    // required for weth.withdraw() to work properly
    require(msg.sender == dexAdapter.weth, "FlashMint: DEPOSITS_NOT_ALLOWED");
  }

  /**
  * Withdraw slippage to selected address
  *
  * @param _tokens    Addresses of tokens to withdraw, specifiy ETH_ADDRESS to withdraw ETH
  * @param _to        Address to send the tokens to
  */
  function withdrawTokens(IERC20[] calldata _tokens, address payable _to) external onlyOwner payable {
      for(uint256 i = 0; i < _tokens.length; i++) {
          if(address(_tokens[i]) == DEXAdapter.ETH_ADDRESS){
              _to.sendValue(address(this).balance);
          }
          else{
              _tokens[i].safeTransfer(_to, _tokens[i].balanceOf(address(this)));
          }
      }
  }

  /**
   * Runs all the necessary approval functions required before issuing
   * or redeeming a SetToken. This function need to be called only once before the first time
   * this smart contract is used on any particular SetToken.
   *
   * @param _setToken          Address of the SetToken being initialized
   */
  function approveSetToken(ISetToken _setToken) external isSetToken(_setToken) {
    address[] memory _components = _setToken.getComponents();
    for (uint256 i = 0; i < _components.length; ++i) {
      DEXAdapter._safeApprove(IERC20(_components[i]), address(issuanceModule), MAX_UINT256);
    }
  }

  function approveToken(IERC20 _token, address _spender) external onlyOwner {
    _token.safeApprove(_spender, MAX_UINT256);
  }

  function issueExactSetFromETH(
    ISetToken _setToken,
    uint256 _amountSetToken
  ) external payable nonReentrant returns (uint256) {
    uint256 maxAmountInputToken = msg.value; // = deposited amount ETH -> WETH
    (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(issuanceModule).getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);

    for (uint256 i = 0; i < components.length; i++) {
      if (components[i] == dexAdapter.weth) {
        continue;
      }
      if(_isInstadapp(components[i])){
          _depositIntoInstadapp(IERC4626(components[i]), positions[i]);
      }

    }

    issuanceModule.issue(_setToken, _amountSetToken, msg.sender);
  }

  function _depositIntoInstadapp(IERC4626 _vault, uint256 _amount) internal {
      uint256 stETHAmount = _vault.previewMint(_amount);
      stETH.submit{value: stETHAmount}(address(0)); // TODO: Check if we want to pass referral address
      _vault.mint(_amount, address(this));
  }

  function _isInstadapp(address _token) internal pure returns (bool) {
      return _token == 0xA0D3707c569ff8C87FA923d3823eC5D81c98Be78;
  }
}
