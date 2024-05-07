/*
    Copyright 2024 Index Cooperative

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

import { IERC4626 } from "../interfaces/IERC4626.sol";
import { IStETH } from "../interfaces/external/IStETH.sol";
import { IAcrossHubPoolV2 } from "../interfaces/external/IAcrossHubPoolV2.sol";
import { IPendlePrincipalToken } from "../interfaces/external/IPendlePrincipalToken.sol";
import { IPendleMarketV3 } from "../interfaces/external/IPendleMarketV3.sol";
import { IPendleStandardizedYield } from "../interfaces/external/IPendleStandardizedYield.sol";
import { IController } from "../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IWETH } from "../interfaces/IWETH.sol";
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

    struct PendleMarketData {
        IPendlePrincipalToken pt;
        IPendleStandardizedYield sy;
        address underlying;
    }
    /* ============ Constants ============= */

    uint256 private constant MAX_UINT256 = type(uint256).max;
    uint256 public constant ROUNDING_ERROR = 10;
    // TODO: Check if this will ever change
    IERC20 public constant acrossToken = IERC20(0x28F77208728B0A45cAb24c4868334581Fe86F95B);
    IAcrossHubPoolV2 public constant acrossPool =
        IAcrossHubPoolV2(0xc186fA914353c44b2E33eBE05f21846F1048bEda);
    /* ============ Immutables ============ */

    IController public immutable setController;
    IStETH public immutable stETH;
    IDebtIssuanceModule public immutable issuanceModule; // interface is compatible with DebtIssuanceModuleV2
    mapping(IPendlePrincipalToken => IPendleMarketV3) public pendleMarkets;
    mapping(IPendleMarketV3 => PendleMarketData) public pendleMarketData;
    mapping(address => mapping(address => DEXAdapterV2.SwapData)) public swapData;

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
                    (_outputToken == dexAdapter.weth &&
                        _path[_path.length - 1] == DEXAdapterV2.ETH_ADDRESS),
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

        IERC20(address(_stETH)).approve(_stEthETHPool, MAX_UINT256);
    }

    /* ============ External Functions (Publicly Accesible) ============ */

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
            IERC20(_components[i]).approve(address(issuanceModule), MAX_UINT256);
        }
        _setToken.approve(address(issuanceModule), MAX_UINT256);
    }


    /**
     * Issue exact amout of SetToken for ETH
     *
     * @param _setToken     Address of the SetToken to issue
     * @param _amountSetToken   Amount of SetToken to issue
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken
    ) external payable nonReentrant returns (uint256) {
        uint256 ethSpent = _issueExactSetFromEth(_setToken, _amountSetToken);
        msg.sender.sendValue(msg.value.sub(ethSpent));
        return ethSpent;
    }

    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _amountSetToken,
        IERC20 _inputToken,
        uint256 _maxInputTokenAmount,
        DEXAdapterV2.SwapData memory _swapDataInputTokenToEth,
        DEXAdapterV2.SwapData memory _swapDataEthToInputToken
    ) external payable nonReentrant returns (uint256) {
        _inputToken.safeTransferFrom(msg.sender, address(this), _maxInputTokenAmount);

        uint256 ethAmount;
        if(address(_inputToken) == address(IWETH(dexAdapter.weth))) {
           ethAmount = _maxInputTokenAmount;
           IWETH(dexAdapter.weth).withdraw(ethAmount);
        } else {
           ethAmount = dexAdapter.swapExactTokensForTokens(
               _maxInputTokenAmount,
               0,
               _swapDataInputTokenToEth
           );
           if(_swapDataInputTokenToEth.path[_swapDataInputTokenToEth.path.length - 1] == dexAdapter.weth) {
               IWETH(dexAdapter.weth).withdraw(ethAmount);
           } 
        }

        ethAmount = ethAmount.sub(_issueExactSetFromEth(_setToken, _amountSetToken));

        uint256 inputTokenLeft;
        if(address(_inputToken) == address(dexAdapter.weth)) {
           inputTokenLeft = ethAmount;
           IWETH(dexAdapter.weth).deposit{value: ethAmount}();
        } else {
           if(_swapDataEthToInputToken.path[0] == dexAdapter.weth) {
               IWETH(dexAdapter.weth).deposit{value: ethAmount}();
           } 
           inputTokenLeft = dexAdapter.swapExactTokensForTokens(
               ethAmount,
               0,
               _swapDataEthToInputToken
           );
        }

        _inputToken.safeTransfer(msg.sender, inputTokenLeft);
        return _maxInputTokenAmount.sub(inputTokenLeft);
    }


    /**
     * Redeem exact amount of SetToken for ETH
     *
     * @param _setToken         Address of the SetToken to redeem
     * @param _amountSetToken   Amount of SetToken to redeem
     * @param _minETHOut        Minimum amount of ETH to receive (tx will revert if actual amount is less)
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minETHOut
    ) external payable nonReentrant returns (uint256) {
        uint256 maxAmountInputToken = msg.value; // = deposited amount ETH -> WETH
        uint256 ethBalanceBefore = address(this).balance;

        _setToken.safeTransferFrom(msg.sender, address(this), _amountSetToken);
        issuanceModule.redeem(_setToken, _amountSetToken, address(this));
        (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(
            issuanceModule
        ).getRequiredComponentRedemptionUnits(_setToken, _amountSetToken);

        for (uint256 i = 0; i < components.length; i++) {
            if (_isInstadapp(components[i])) {
                _withdrawFromInstadapp(IERC4626(components[i]), positions[i]);
                continue;
            }
            IPendleMarketV3 market = pendleMarkets[IPendlePrincipalToken(components[i])];
            if (market != IPendleMarketV3(address(0))) {
                _withdrawFromPendle(IPendlePrincipalToken(components[i]), positions[i], market);
                continue;
            }
            if (IERC20(components[i]) == acrossToken) {
                _withdrawFromAcross(positions[i]);
                continue;
            }
        }

        uint256 ethObtained = address(this).balance.sub(ethBalanceBefore);
        require(ethObtained >= _minETHOut, "FlashMint: INSUFFICIENT_OUTPUT");
        msg.sender.sendValue(ethObtained);
        return ethObtained;
    }

    receive() external payable {}

    /* ============ External Functions (Access controlled) ============ */

    /**
     * Approve spender to spend specific token on behalf of this contract
     *
     * @param _token        Address of the token to approve
     * @param _spender      Address of the spender
     * @param _allowance    Amount to approve
     */
    function approveToken(IERC20 _token, address _spender, uint256 _allowance) external onlyOwner {
        _token.approve(_spender, _allowance);
    }

    /**
     * Withdraw slippage to selected address
     *
     * @param _tokens    Addresses of tokens to withdraw, specifiy ETH_ADDRESS to withdraw ETH
     * @param _to        Address to send the tokens to
     */
    function withdrawTokens(
        IERC20[] calldata _tokens,
        address payable _to
    ) external payable onlyOwner {
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (address(_tokens[i]) == DEXAdapterV2.ETH_ADDRESS) {
                _to.sendValue(address(this).balance);
            } else {
                _tokens[i].safeTransfer(_to, _tokens[i].balanceOf(address(this)));
            }
        }
    }


    /**
     * Set swap data for specific token pair
     *
     * @param _inputToken     Address of the input token 
     * @param _outputToken    Address of the output token
     * @param _swapData       Swap data for the token pair describing DEX / route
     */
    function setSwapData(
        address _inputToken,
        address _outputToken,
        DEXAdapterV2.SwapData memory _swapData
    ) external onlyOwner {
        swapData[_inputToken][_outputToken] = _swapData;
    }

    /**
     * Set Pendle Market to use for specific pt including relevant metadata
     *
     * @param _pt             Address of the Pendle Principal Token
     * @param _sy             Address of the corresponding Standardized Yield Token
     * @param _underlying     Address of the underlying token to redeem to
     * @param _market         Address of the Pendle Market to use for swapping between pt and sy
     */
    function setPendleMarket(
        IPendlePrincipalToken _pt,
        IPendleStandardizedYield _sy,
        address _underlying,
        IPendleMarketV3 _market
    ) external onlyOwner {
        pendleMarkets[_pt] = _market;
        pendleMarketData[_market] = PendleMarketData({ pt: _pt, sy: _sy, underlying: _underlying });
    }

    /**
     * Callback method that is called by Pendle Market during the swap to request input token
     *
     * @param _ptToAccount  Swap balance of pt token (negative -> swapping pt to sy)
     * @param _syToAccount  Swap balance of sy token (negative -> swapping sy to pt)
     * @param _data         Arbitrary data passed by Pendle Market (not used)
     */
    function swapCallback(int256 _ptToAccount, int256 _syToAccount, bytes calldata _data) external {
        PendleMarketData storage marketData = pendleMarketData[IPendleMarketV3(msg.sender)];
        require(address(marketData.sy) != address(0), "ISC");
        if (_ptToAccount < 0) {
            uint256 ptAmount = uint256(-_ptToAccount);
            marketData.pt.transfer(msg.sender, ptAmount);
        } else if (_syToAccount < 0) {
            uint256 syAmount = uint256(-_syToAccount);
            uint256 ethAmount = syAmount.mul(marketData.sy.exchangeRate()).div(1e18);
            marketData.sy.deposit{ value: ethAmount }(msg.sender, address(0), ethAmount, 0);
        } else {
            revert("Invalid callback");
        }
    }


    /* ============ Internal ============ */

    function _issueExactSetFromEth(
        ISetToken _setToken,
        uint256 _amountSetToken
    ) internal returns (uint256) {
        (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(
            issuanceModule
        ).getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);
        uint256 ethBalanceBefore = address(this).balance;
        for (uint256 i = 0; i < components.length; i++) {
            _depositIntoComponent(components[i], positions[i]);
        }
        issuanceModule.issue(_setToken, _amountSetToken, msg.sender);
        return ethBalanceBefore.sub(address(this).balance);
    }

    function _depositIntoComponent(
        address _component,
        uint256 _amount
    ) internal {
        if (_isInstadapp(_component)) {
            _depositIntoInstadapp(IERC4626(_component), _amount);
            return;
        }
        IPendleStandardizedYield syToken = _getSyToken(IPendlePrincipalToken(_component));
        if (syToken != IPendleStandardizedYield(address(0))) {
            _depositIntoPendle(IPendlePrincipalToken(_component), _amount, syToken);
            return;
        }
        if (IERC20(_component) == acrossToken) {
            _depositIntoAcross(_amount);
            return;
        }
    }

    /**
     * @dev Deposit eth into steth and then into instadapp vault
     *
     */
    function _depositIntoInstadapp(IERC4626 _vault, uint256 _amount) internal {
        uint256 stETHAmount = _vault.previewMint(_amount);
        _depositIntoLido(stETHAmount);
        _vault.mint(_amount, address(this));
    }

    /**
     * @dev Deposit eth into steth
     *
     */
    function _depositIntoLido(uint256 _amount) internal {
        stETH.submit{ value: _amount }(address(0)); // TODO: Check if we want to pass referral address
    }

    /**
     * @dev Withdraw steth from instadapp vault and  then swap to eth
     * @dev Requries the respective swap data (stETH -> ETH) to be set
     *
     */
    function _withdrawFromInstadapp(IERC4626 _vault, uint256 _amount) internal {
        uint256 stETHAmount = _vault.redeem(_amount, address(this), address(this));
        _swapExactTokensForTokens(stETHAmount, address(stETH), address(0));
    }

    /**
     * @dev Check if given component is the Instadapp vault
     *
     */
    function _isInstadapp(address _token) internal pure returns (bool) {
        return _token == 0xA0D3707c569ff8C87FA923d3823eC5D81c98Be78;
    }

    /**
     * @dev Get Sy token for given pt token
     * @dev Also functions as check if given component is a Pendle Principal Token
     *
     */
    function _getSyToken(
        IPendlePrincipalToken _pt
    ) internal view returns (IPendleStandardizedYield) {
        return pendleMarketData[pendleMarkets[_pt]].sy;
    }

    /**
     * @dev Initiate deposit into pendle by swapping pt for sy
     * @dev Deposit from eth to sy is done in swapCallback
     */
    function _depositIntoPendle(
        IPendlePrincipalToken _pt,
        uint256 _ptAmount,
        IPendleStandardizedYield _sy
    ) internal {
        // Adding random bytes here since PendleMarket will not call back if data is empty
        IPendleMarketV3(pendleMarkets[_pt]).swapSyForExactPt(address(this), _ptAmount, bytes("a"));
    }

    /**
     * @dev Obtain across lp tokens by adding eth liquidity into the across pool
     */
    function _depositIntoAcross(uint256 _acrossLpAmount) internal {
        uint256 ethAmount = acrossPool
            .exchangeRateCurrent(dexAdapter.weth)
            .mul(_acrossLpAmount)
            .div(1e18)
            .add(ROUNDING_ERROR);
        acrossPool.addLiquidity{ value: ethAmount }(dexAdapter.weth, ethAmount);
    }

    /**
     * @dev Withdraw eth by removing liquidity from across pool
     */
    function _withdrawFromAcross(uint256 _acrossLpAmount) internal {
        acrossPool.removeLiquidity(dexAdapter.weth, _acrossLpAmount, true);
    }

    /**
     * @dev Withdraw from Pendle by swapping pt for sy, redeeming sy for underlying and swapping underlying to eth
     */
    function _withdrawFromPendle(
        IPendlePrincipalToken _pt,
        uint256 _ptAmount,
        IPendleMarketV3 _pendleMarket
    ) internal {
        // Adding random bytes here since PendleMarket will not call back if data is empty
        (uint256 syAmount, ) = _pendleMarket.swapExactPtForSy(address(this), _ptAmount, bytes("a"));
        PendleMarketData storage data = pendleMarketData[_pendleMarket];
        uint256 amountUnderlying = data.sy.redeem(
            address(this),
            syAmount,
            data.underlying,
            0,
            false
        );
        _swapExactTokensForTokens(amountUnderlying, data.underlying, address(0));
        IWETH(dexAdapter.weth).withdraw(IERC20(dexAdapter.weth).balanceOf(address(this)));
    }

    /**
     * @dev Swap exact amount of input token for output token using configured swap data
     */
    function _swapExactTokensForTokens(
        uint256 _amountIn,
        address _inputToken,
        address _outputToken
    ) internal returns (uint256) {
        dexAdapter.swapExactTokensForTokens(_amountIn, 0, swapData[_inputToken][_outputToken]);
    }
}
