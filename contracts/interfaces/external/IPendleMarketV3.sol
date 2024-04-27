// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

interface IPendleMarketV3 {
    struct MarketState {
        int256 totalPt;
        int256 totalSy;
        int256 totalLp;
        address treasury;
        int256 scalarRoot;
        uint256 expiry;
        uint256 lnFeeRateRoot;
        uint256 reserveFeePercent;
        uint256 lastLnImpliedRate;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function _storage()
        external
        view
        returns (
            int128 totalPt,
            int128 totalSy,
            uint96 lastLnImpliedRate,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext
        );
    function activeBalance(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function burn(address receiverSy, address receiverPt, uint256 netLpToBurn)
        external
        returns (uint256 netSyOut, uint256 netPtOut);
    function decimals() external view returns (uint8);
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
    function expiry() external view returns (uint256);
    function factory() external view returns (address);
    function getNonOverrideLnFeeRateRoot() external view returns (uint80);
    function getRewardTokens() external view returns (address[] memory);
    function increaseObservationsCardinalityNext(uint16 cardinalityNext) external;
    function isExpired() external view returns (bool);
    function lastRewardBlock() external view returns (uint256);
    function mint(address receiver, uint256 netSyDesired, uint256 netPtDesired)
        external
        returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed);
    function name() external view returns (string memory);
    function nonces(address owner) external view returns (uint256);
    function observations(uint256)
        external
        view
        returns (uint32 blockTimestamp, uint216 lnImpliedRateCumulative, bool initialized);
    function observe(uint32[] memory secondsAgos) external view returns (uint216[] memory lnImpliedRateCumulative);
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function readState(address router) external view returns (MarketState memory market);
    function readTokens() external view returns (address _SY, address _PT, address _YT);
    function redeemRewards(address user) external returns (uint256[] memory);
    function rewardState(address) external view returns (uint128 index, uint128 lastBalance);
    function skim() external;
    function swapExactPtForSy(address receiver, uint256 exactPtIn, bytes memory data)
        external
        returns (uint256 netSyOut, uint256 netSyFee);
    function swapSyForExactPt(address receiver, uint256 exactPtOut, bytes memory data)
        external
        returns (uint256 netSyIn, uint256 netSyFee);
    function symbol() external view returns (string memory);
    function totalActiveSupply() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function userReward(address, address) external view returns (uint128 index, uint128 accrued);
}
