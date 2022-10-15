// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;


import { 
    FlashMintLeveragedForCompound,
    ISetToken,
    DEXAdapter,
    IController,
    IDebtIssuanceModule,
    ICompoundLeverageModule,
    IERC20
} from "../exchangeIssuance/FlashMintLeveragedForCompound.sol";


contract FlashMintLeveragedCompMock is FlashMintLeveragedForCompound {
    constructor(
        DEXAdapter.Addresses memory _dexAddresses,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        ICompoundLeverageModule _compoundLeverageModule,
        address _aaveAddressProvider,
        address _cEther
    ) public
    FlashMintLeveragedForCompound(_dexAddresses, _setController,_debtIssuanceModule, _compoundLeverageModule, _aaveAddressProvider, _cEther )
    {}


    function liquidateCollateralTokens(
        uint256 _collateralTokenSpent,
        ISetToken _setToken,
        uint256 _setAmount,
        address _originalSender,
        address _outputToken,
        uint256 _minAmountOutputToken,
        address _collateralToken,
        uint256 _collateralAmount,
        DEXAdapter.SwapData memory _swapData
    ) external {
        _liquidateCollateralTokens(
            _collateralTokenSpent,
            _setToken,
            _setAmount,
            _originalSender,
            _outputToken,
            _minAmountOutputToken,
            _collateralToken,
            _collateralAmount,
            _swapData
        );
    }

    function liquidateCollateralTokensForETH(
        address _collateralToken,
        uint256 _collateralRemaining,
        address _originalSender,
        uint256 _minAmountOutputToken,
        DEXAdapter.SwapData memory _swapData
    )
    external
    returns(uint256)
    {
        return _liquidateCollateralTokensForETH(
            _collateralToken,
            _collateralRemaining,
            _originalSender,
            _minAmountOutputToken,
            _swapData
        );
    }

    function transferShortfallFromSender(
        address _token,
        uint256 _shortfall,
        address _originalSender
    )
    external
    {
        _transferShortfallFromSender(
            _token,
            _shortfall,
            _originalSender
        );
    }

    function makeUpShortfallWithERC20(
        address _collateralToken,
        uint256 _collateralTokenShortfall,
        address _originalSender,
        IERC20 _inputToken,
        uint256 _maxAmountInputToken,
        DEXAdapter.SwapData memory _swapData
    )
    external
    returns (uint256)
    {
        return _makeUpShortfallWithERC20(
            _collateralToken,
            _collateralTokenShortfall,
            _originalSender,
            _inputToken,
            _maxAmountInputToken,
            _swapData
        );
    }
}