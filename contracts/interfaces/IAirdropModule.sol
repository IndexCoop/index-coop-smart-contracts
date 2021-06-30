pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { ISetToken } from "./ISetToken.sol";

interface IAirdropModule {
    struct AirdropSettings {
        address[] airdrops;    // Array of tokens manager is allowing to be absorbed
        address feeRecipient;  // Address airdrop fees are sent to
        uint256 airdropFee;    // Percentage in preciseUnits of airdrop sent to feeRecipient (1e16 = 1%)
        bool anyoneAbsorb;     // Boolean indicating if any address can call absorb or just the manager
    }
}