// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;


import { 
    ExchangeIssuanceLeveragedForCompound,
    ISetToken,
    DEXAdapter,
    IController,
    IDebtIssuanceModule,
    ICompoundLeverageModule
} from "../exchangeIssuance/ExchangeIssuanceLeveragedForCompound.sol";


contract ExchangeIssuanceLeveragedCompMock is ExchangeIssuanceLeveragedForCompound {
    constructor(
        address _weth,
        address _quickRouter,
        address _sushiRouter,
        address _uniV3Router,
        address _uniV3Quoter,
        IController _setController,
        IDebtIssuanceModule _debtIssuanceModule,
        ICompoundLeverageModule _compoundLeverageModule,
        address _aaveAddressProvider,
        address _curveAddressProvider,
        address _curveCalculator
    ) public
    ExchangeIssuanceLeveragedForCompound(
        _weth,
        _quickRouter,
        _sushiRouter,
        _uniV3Router,
        _uniV3Quoter,
        _setController,
        _debtIssuanceModule,
        _compoundLeverageModule,
        _aaveAddressProvider,
        _curveAddressProvider,
        _curveCalculator
    ) {

    }


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
}