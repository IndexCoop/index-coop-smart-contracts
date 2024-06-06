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
        uint256 exchangeRateFactor;
    }
    /* ============ Constants ============= */

    uint256 private constant MAX_UINT256 = type(uint256).max;
    uint256 public constant ROUNDING_ERROR = 10;
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
     * Issue exact amout of SetToken from ETH
     *
     * @param _setToken     Address of the SetToken to issue
     * @param _amountSetToken   Amount of SetToken to issue
     */
    function issueExactSetFromETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        DEXAdapterV2.SwapData[] memory _swapDataEthToComponent
    ) external payable nonReentrant returns (uint256) {
        uint256 ethSpent = _issueExactSetFromEth(_setToken, _amountSetToken, _swapDataEthToComponent);
        msg.sender.sendValue(msg.value.sub(ethSpent));
        return ethSpent;
    }

    /**
     * Issue exact amout of SetToken from ERC20 token
     *
     * @param _setToken     Address of the SetToken to issue
     * @param _amountSetToken   Amount of SetToken to issue
     * @param _inputToken    Address of the input token
     * @param _maxInputTokenAmount  Maximum amount of input token to spend
     * @param _swapDataInputTokenToEth Swap data from input token to ETH
     * @param _swapDataEthToInputToken Swap data from ETH to input token (used to swap back the leftover eth)
     */
    function issueExactSetFromERC20(
        ISetToken _setToken,
        uint256 _amountSetToken,
        IERC20 _inputToken,
        uint256 _maxInputTokenAmount,
        DEXAdapterV2.SwapData memory _swapDataInputTokenToEth,
        DEXAdapterV2.SwapData memory _swapDataEthToInputToken,
        DEXAdapterV2.SwapData[] memory _swapDataEthToComponent
    ) external payable nonReentrant returns (uint256) {
        _inputToken.safeTransferFrom(msg.sender, address(this), _maxInputTokenAmount);

        uint256 ethAmount = _swapFromTokenToEth(_inputToken, _maxInputTokenAmount, _swapDataInputTokenToEth);
        ethAmount = ethAmount.sub(_issueExactSetFromEth(_setToken, _amountSetToken, _swapDataEthToComponent));

        uint256 inputTokenLeft = _swapFromEthToToken(_inputToken, ethAmount, _swapDataEthToInputToken);

        _inputToken.safeTransfer(msg.sender, inputTokenLeft);
        return _maxInputTokenAmount.sub(inputTokenLeft);
    }

    /**
     * Redeem exact amount of SetToken for ETH
     *
     * @param _setToken         Address of the SetToken to redeem
     * @param _amountSetToken   Amount of SetToken to redeem
     * @param _minETHOut        Minimum amount of ETH to receive (tx will revert if actual amount is less)
     * @param _swapDataComponentToEth Swap data from component to ETH (for non standard components)
     */
    function redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minETHOut,
        DEXAdapterV2.SwapData[] memory _swapDataComponentToEth
    ) external payable nonReentrant returns (uint256) {
        uint256 ethObtained = _redeemExactSetForETH(_setToken, _amountSetToken, _minETHOut, _swapDataComponentToEth);
        require(ethObtained >= _minETHOut, "FlashMint: INSUFFICIENT_OUTPUT");
        msg.sender.sendValue(ethObtained);
        return ethObtained;
    }

    /**
     * Redeem exact amount of SetToken for ERC20
     *
     * @param _setToken         Address of the SetToken to redeem
     * @param _amountSetToken   Amount of SetToken to redeem
     * @param _outputToken      Address of the output token
     * @param _minOutputTokenAmount  Minimum amount of output token to receive (tx will revert if actual amount is less)
     * @param _swapDataEthToOutputToken Swap data from ETH to output token
     * @param _swapDataComponentToEth Swap data from component to ETH (for non standard components)
     */
    function redeemExactSetForERC20(
        ISetToken _setToken,
        uint256 _amountSetToken,
        IERC20 _outputToken,
        uint256 _minOutputTokenAmount,
        DEXAdapterV2.SwapData memory _swapDataEthToOutputToken,
        DEXAdapterV2.SwapData[] memory _swapDataComponentToEth
    ) external payable nonReentrant returns (uint256) {
        uint256 ethObtained = _redeemExactSetForETH(_setToken, _amountSetToken, 0, _swapDataComponentToEth);
        uint256 outputTokenAmount = _swapFromEthToToken(_outputToken, ethObtained, _swapDataEthToOutputToken);
        require(outputTokenAmount >= _minOutputTokenAmount, "FlashMint: INSUFFICIENT_OUTPUT");
        _outputToken.safeTransfer(msg.sender, outputTokenAmount);
        return outputTokenAmount;
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
     * @param _exchangeRateFactor  Factor to multiply the exchange rate when supplying to Pendle Market
     */
    function setPendleMarket(
        IPendlePrincipalToken _pt,
        IPendleStandardizedYield _sy,
        address _underlying,
        IPendleMarketV3 _market,
        uint256 _exchangeRateFactor
    ) external onlyOwner {
        pendleMarkets[_pt] = _market;
        pendleMarketData[_market] = PendleMarketData({
            pt: _pt,
            sy: _sy,
            underlying: _underlying,
            exchangeRateFactor: _exchangeRateFactor
        });
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

            // Withdraw necessary ETH, if deposit size is enough to move the oracle, then the exchange rate will not be 
            // valid for computing the amount of ETH to withdraw, so increase by exchangeRateFactor
            uint256 ethAmount = syAmount.mul(marketData.sy.exchangeRate()).div(1 ether);
            uint256 syAmountPreview = marketData.sy.previewDeposit(address(0), ethAmount);
            if (syAmountPreview < syAmount) {
                ethAmount = ethAmount * marketData.exchangeRateFactor / 1 ether;
            }

            marketData.sy.deposit{ value: ethAmount }(msg.sender, address(0), ethAmount, 0);
        } else {
            revert("Invalid callback");
        }
    }


    /* ============ Internal ============ */

    /**
     * @dev Issue exact amount of SetToken from ETH
     *
     */
    function _issueExactSetFromEth(
        ISetToken _setToken,
        uint256 _amountSetToken,
        DEXAdapterV2.SwapData[] memory _swapDataEthToComponent
    ) internal returns (uint256) {
        (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(
            issuanceModule
        ).getRequiredComponentIssuanceUnits(_setToken, _amountSetToken);
        uint256 ethBalanceBefore = address(this).balance;
        for (uint256 i = 0; i < components.length; i++) {
            _depositIntoComponent(components[i], positions[i], _swapDataEthToComponent[i]);
        }
        issuanceModule.issue(_setToken, _amountSetToken, msg.sender);
        return ethBalanceBefore.sub(address(this).balance);
    }

    /**
     * @dev Redeem exact amount of SetToken for ETH
     *
     */
    function _redeemExactSetForETH(
        ISetToken _setToken,
        uint256 _amountSetToken,
        uint256 _minETHOut,
        DEXAdapterV2.SwapData[] memory _swapDataComponentToEth
    ) internal returns (uint256) {
        uint256 ethBalanceBefore = address(this).balance;

        _setToken.safeTransferFrom(msg.sender, address(this), _amountSetToken);
        issuanceModule.redeem(_setToken, _amountSetToken, address(this));
        (address[] memory components, uint256[] memory positions, ) = IDebtIssuanceModule(
            issuanceModule
        ).getRequiredComponentRedemptionUnits(_setToken, _amountSetToken);

        for (uint256 i = 0; i < components.length; i++) {
            _withdrawFromComponent(components[i], positions[i], _swapDataComponentToEth[i]);
        }

        return address(this).balance.sub(ethBalanceBefore);
    }

    /**
     * @dev Deposit ETH into given component
     *
     */
    function _depositIntoComponent(
        address _component,
        uint256 _amount,
        DEXAdapterV2.SwapData memory _swapData
    ) internal {
        if(_swapData.exchange != DEXAdapterV2.Exchange.None) {
            require(_swapData.path.length > 1, "zero length swap path");
            require(_swapData.path[0] == DEXAdapterV2.ETH_ADDRESS || _swapData.path[0] == dexAdapter.weth, "Invalid input token");
            require(_swapData.path[_swapData.path.length - 1] == _component, "Invalid output token");
            if(_swapData.path[0] == dexAdapter.weth) {
                uint256 balanceBefore = IWETH(dexAdapter.weth).balanceOf(address(this));
                IWETH(dexAdapter.weth).deposit{value: address(this).balance}();
                dexAdapter.swapTokensForExactTokens(_amount, IWETH(dexAdapter.weth).balanceOf(address(this)), _swapData);
                IWETH(dexAdapter.weth).withdraw(IWETH(dexAdapter.weth).balanceOf(address(this)).sub(balanceBefore));
            }
            else {
                dexAdapter.swapTokensForExactTokens(_amount, address(this).balance, _swapData);
            }
            return;
        }
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
        if (_component == dexAdapter.weth) {
            IWETH(dexAdapter.weth).deposit{ value: _amount }();
            return;
        }
        revert("Missing Swapdata for non-standard component");
    }

    /**
     * @dev Withdraw ETH from given component
     *
     */
    function _withdrawFromComponent(
        address _component,
        uint256 _amount,
        DEXAdapterV2.SwapData memory _swapData
    ) internal {
        if(_swapData.exchange != DEXAdapterV2.Exchange.None) {
            require(_swapData.path.length > 1, "zero length swap path");
            require(_swapData.path[0] == _component, "Invalid input token");
            require(_swapData.path[_swapData.path.length - 1] == DEXAdapterV2.ETH_ADDRESS || _swapData.path[_swapData.path.length - 1] == dexAdapter.weth, "Invalid output token");
            uint256 ethReceived = dexAdapter.swapExactTokensForTokens(_amount, 0, _swapData);
            if(_swapData.path[_swapData.path.length - 1] == dexAdapter.weth) {
                IWETH(dexAdapter.weth).withdraw(ethReceived);
            }
            return;
        }
        if (_isInstadapp(_component)) {
            _withdrawFromInstadapp(IERC4626(_component), _amount);
            return;
        }
        IPendleMarketV3 market = pendleMarkets[IPendlePrincipalToken(_component)];
        if (market != IPendleMarketV3(address(0))) {
            _withdrawFromPendle(IPendlePrincipalToken(_component), _amount, market);
            return;
        }
        if (IERC20(_component) == acrossToken) {
            _withdrawFromAcross(_amount);
            return;
        }
        if (_component == dexAdapter.weth) {
            IWETH(dexAdapter.weth).withdraw(_amount);
            return;
        }
        revert("Missing Swapdata for non-standard component");
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
        stETH.submit{ value: _amount }(address(0));
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

    /**
     * @dev Convert ETH to specified token, either swapping or simply depositing if outputToken is WETH
     */
    function _swapFromEthToToken(
        IERC20 _outputToken,
        uint256 _ethAmount,
        DEXAdapterV2.SwapData memory _swapDataEthToOutputToken
    ) internal returns(uint256 outputTokenAmount) {
        if(address(_outputToken) == address(dexAdapter.weth)) {
           outputTokenAmount = _ethAmount;
           IWETH(dexAdapter.weth).deposit{value: _ethAmount}();
        } else {
           if(_swapDataEthToOutputToken.path[0] == dexAdapter.weth) {
               IWETH(dexAdapter.weth).deposit{value: _ethAmount}();
           } 
           outputTokenAmount = dexAdapter.swapExactTokensForTokens(
               _ethAmount,
               0,
               _swapDataEthToOutputToken
           );
        }
    }

    /**
     * @dev Convert specified token to ETH, either swapping or simply withdrawing if inputToken is WETH
     */
    function _swapFromTokenToEth(
        IERC20 _inputToken,
        uint256 _maxInputTokenAmount,
        DEXAdapterV2.SwapData memory _swapDataInputTokenToEth
    ) internal returns (uint256 ethAmount) {
        if(address(_inputToken) == dexAdapter.weth) {
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
    }


}
