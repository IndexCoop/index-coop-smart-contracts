// SPDX-License-bytes32entifier: UNLICENSED
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

interface IMorpho {

    struct Authorization {
        address authorizer;
        address authorized;
        bool isAuthorized;
        uint256 nonce;
        uint256 deadline;
    }

    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Signature {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event AccrueInterest(bytes32 indexed id, uint256 prevBorrowRate, uint256 interest, uint256 feeShares);
    event Borrow(
        bytes32 indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
    event CreateMarket(bytes32 indexed id, MarketParams marketParams);
    event EnableIrm(address indexed irm);
    event EnableLltv(uint256 lltv);
    event FlashLoan(address indexed caller, address indexed token, uint256 assets);
    event IncrementNonce(address indexed caller, address indexed authorizer, uint256 usedNonce);
    event Liquidate(
        bytes32 indexed id,
        address indexed caller,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedAssets,
        uint256 badDebtAssets,
        uint256 badDebtShares
    );
    event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event SetAuthorization(
        address indexed caller, address indexed authorizer, address indexed authorized, bool newIsAuthorized
    );
    event SetFee(bytes32 indexed id, uint256 newFee);
    event SetFeeRecipient(address indexed newFeeRecipient);
    event SetOwner(address indexed newOwner);
    event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets);
    event Withdraw(
        bytes32 indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
    event WithdrawCollateral(
        bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets
    );


    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function accrueInterest(MarketParams memory marketParams) external;
    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256);
    function createMarket(MarketParams memory marketParams) external;
    function enableIrm(address irm) external;
    function enableLltv(uint256 lltv) external;
    function extSloads(bytes32[] memory slots) external view returns (bytes32[] memory res);
    function feeRecipient() external view returns (address);
    function flashLoan(address token, uint256 assets, bytes memory data) external;
    function idToMarketParams(bytes32)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
    function isAuthorized(address, address) external view returns (bool);
    function isIrmEnabled(address) external view returns (bool);
    function isLltvEnabled(uint256) external view returns (bool);
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256, uint256);
    function market(bytes32)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
    function nonce(address) external view returns (uint256);
    function owner() external view returns (address);
    function position(bytes32, address)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256, uint256);
    function setAuthorization(address authorized, bool newIsAuthorized) external;
    function setAuthorizationWithSig(Authorization memory authorization, Signature memory signature) external;
    function setFee(MarketParams memory marketParams, uint256 newFee) external;
    function setFeeRecipient(address newFeeRecipient) external;
    function setOwner(address newOwner) external;
    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256, uint256);
    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;
    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256);
    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;
}
