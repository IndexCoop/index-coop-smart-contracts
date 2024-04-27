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
import { IPendlePrincipalToken } from "../interfaces/external/IPendlePrincipalToken.sol";
import { IPendleMarketV3 } from "../interfaces/external/IPendleMarketV3.sol";
import { IPendleStandardizedYield } from "../interfaces/external/IPendleStandardizedYield.sol";
import { IController } from "../interfaces/IController.sol";
import { IDebtIssuanceModule} from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH} from "../interfaces/IWETH.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { DEXAdapterV2 } from "./DEXAdapterV2.sol";


/**
 * @title FlashMintHyETH
 */
contract FlashMintHyETH is Ownable, ReentrancyGuard {
  using DEXAdapterV2 for DEXAdapterV2.Addresses;
  using Address for address payable;
  using Address for address;
  using SafeMath for uint256;
  using SafeERC20 for IERC20;
  using SafeERC20 for ISetToken;


  /* ============ Constants ============= */

  uint256 private constant MAX_UINT256 = type(uint256).max;
  DEXAdapterV2.SwapData private stETHForETHSwapData;
  /* ============ Immutables ============ */

  IController public immutable setController;
  IStETH public immutable stETH;
  IDebtIssuanceModule public immutable issuanceModule; // interface is compatible with DebtIssuanceModuleV2
  mapping(IPendlePrincipalToken => IPendleMarketV3) public pendleMarkets;

  /* ============ State Variables ============ */

  DEXAdapterV2.Addresses public dexAdapter;

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
          (_inputToken == dexAdapter.weth && _path[0] == DEXAdapterV2.ETH_ADDRESS),
        "FlashMint: INPUT_TOKEN_NOT_IN_PATH"
      );
      require(
        _path[_path.length - 1] == _outputToken ||
          (_outputToken == dexAdapter.weth && _path[_path.length - 1] == DEXAdapterV2.ETH_ADDRESS),
        "FlashMint: OUTPUT_TOKEN_NOT_IN_PATH"
      );
    }
    _;
  }

  /* ========== Constructor ========== */

  constructor(
    DEXAdapterV2.Addresses memory _dexAddresses,
    IController _setController,
    IDebtIssuanceModule _issuanceModule,
    IStETH _stETH,
    address _stEthETHPool
  ) public {
    dexAdapter = _dexAddresses;
    setController = _setController;
    issuanceModule = _issuanceModule;
    stETH = _stETH;

    address[] memory path = new address[](2);
    path[0] = address(_stETH);
    path[1] = DEXAdapterV2.ETH_ADDRESS;
    stETHForETHSwapData = DEXAdapterV2.SwapData({
        path: path,
        fees: new uint24[](0),
        pool: _stEthETHPool,
        exchange: DEXAdapterV2.Exchange.Curve
    });
    IERC20(address(_stETH)).approve(_stEthETHPool, MAX_UINT256);

  }

  /* ============ External Functions ============ */
  receive() external payable {
  }

  /**
  * Withdraw slippage to selected address
  *
  * @param _tokens    Addresses of tokens to withdraw, specifiy ETH_ADDRESS to withdraw ETH
  * @param _to        Address to send the tokens to
  */
  function withdrawTokens(IERC20[] calldata _tokens, address payable _to) external onlyOwner payable {
      for(uint256 i = 0; i < _tokens.length; i++) {
          if(address(_tokens[i]) == DEXAdapterV2.ETH_ADDRESS){
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
      DEXAdapterV2._safeApprove(IERC20(_components[i]), address(issuanceModule), MAX_UINT256);
    }
   _setToken.approve(address(issuanceModule), MAX_UINT256);
  }

  function approveToken(IERC20 _token, address _spender, uint256 _allowance) external onlyOwner {
    _token.safeApprove(_spender, _allowance);
  }

  function issueExactSetFromETH(
    ISetToken _setToken,
    uint256 _amountSetToken
  ) external payable nonReentrant returns (uint256) {
    (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(issuanceModule).getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);

    uint256 ethLeft = msg.value;
    for (uint256 i = 0; i < components.length; i++) {
      if(_isInstadapp(components[i])){
          ethLeft -= _depositIntoInstadapp(IERC4626(components[i]), positions[i]);
          continue;
      }
      IPendleStandardizedYield syToken = _getSyToken(IPendlePrincipalToken(components[i]));
      if(syToken != IPendleStandardizedYield(address(0))){
          ethLeft -= _depositIntoPendle(IPendlePrincipalToken(components[i]), positions[i], syToken, ethLeft);
          continue;
      }
    }
    issuanceModule.issue(_setToken, _amountSetToken, msg.sender);
    msg.sender.sendValue(ethLeft);
  }

  function redeemExactSetForETH(
    ISetToken _setToken,
    uint256 _amountSetToken,
    uint256 _minETHOut
  ) external payable nonReentrant returns (uint256) {
    uint256 maxAmountInputToken = msg.value; // = deposited amount ETH -> WETH
    uint256 ethBalanceBefore = address(this).balance;

    _setToken.safeTransferFrom(msg.sender, address(this), _amountSetToken);
    issuanceModule.redeem(_setToken, _amountSetToken, address(this));
    (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(issuanceModule).getRequiredComponentRedemptionUnits(_setToken, _amountSetToken);

    for (uint256 i = 0; i < components.length; i++) {
      if(_isInstadapp(components[i])){
          _withdrawFromInstadapp(IERC4626(components[i]), positions[i]);
      }
    }
    uint256 ethObtained = address(this).balance.sub(ethBalanceBefore);
    require(ethObtained >= _minETHOut, "FlashMint: INSUFFICIENT_OUTPUT");
    msg.sender.sendValue(ethObtained);
  }

    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _amountSetToken,
        address _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapterV2.SwapData memory _swapData
    )
        isValidPath(_swapData.path, _inputToken, dexAdapter.weth)
        external
        returns (uint256)
    {
        IERC20(_inputToken).safeTransferFrom(msg.sender, address(this), _maxAmountInputToken);
        // TODO: Implement
        return dexAdapter.swapExactTokensForTokens(
            _maxAmountInputToken,
            // minAmountOut is 0 here since we are going to make up the shortfall with the input token.
            // Sandwich protection is provided by the check at the end against _maxAmountInputToken parameter specified by the user
            0, 
            _swapData
        );
    }

function setPendleMarket(IPendlePrincipalToken _pt, IPendleMarketV3 _market) external onlyOwner {
    pendleMarkets[_pt] = _market;
}


  function _depositIntoInstadapp(IERC4626 _vault, uint256 _amount) internal returns(uint256){
      uint256 stETHAmount = _vault.previewMint(_amount);
      _depositIntoLido(stETHAmount);
      _vault.mint(_amount, address(this));
      return stETHAmount;
  }

  function _depositIntoLido(uint256 _amount) internal {
      stETH.submit{value: _amount}(address(0)); // TODO: Check if we want to pass referral address
  }

  function _withdrawFromInstadapp(IERC4626 _vault, uint256 _amount) internal {
      uint256 stETHAmount = _vault.redeem(_amount, address(this), address(this));
      _sellStETHForETH(stETHAmount);
  }

  function _sellStETHForETH(uint256 _stETHAmount) internal returns (uint256) {
    return dexAdapter.swapExactTokensForTokens(
        _stETHAmount,
        0,
        stETHForETHSwapData
    );
  }


  function _isInstadapp(address _token) internal pure returns (bool) {
      return _token == 0xA0D3707c569ff8C87FA923d3823eC5D81c98Be78;
  }

  function _getSyToken(IPendlePrincipalToken _pt) internal view returns (IPendleStandardizedYield) {
      try _pt.SY() returns (address sy) {
          return IPendleStandardizedYield(sy);
      } catch {
          return IPendleStandardizedYield(address(0));
      }
  }

  function _depositIntoPendle(IPendlePrincipalToken _pt, uint256 _ptAmount, IPendleStandardizedYield _sy, uint256 _ethAvailable) internal returns(uint256){
      uint256 syAmount = _sy.deposit(address(this), address(0), _ethAvailable, 0);
      (uint256 sySpent,) = IPendleMarketV3(pendleMarkets[_pt]).swapSyForExactPt(address(this), _ptAmount, bytes(""));
      uint256 ethReturned = _sy.redeem(address(this), syAmount - sySpent, address(0), 0, false);
      return _ethAvailable - ethReturned;
  }
}
