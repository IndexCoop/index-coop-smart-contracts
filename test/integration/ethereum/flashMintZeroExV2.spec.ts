// import "module-alias/register";
// import { ethers, network } from "hardhat";
// import { Account, ForkedTokens } from "@utils/types";
// import { DebtIssuanceModule } from "@utils/contracts/index";
// import DeployHelper from "@utils/deploys";

// import {
//   getAccounts,
//   getForkedTokens,
// //   getWaffleExpect,
//   initializeForkedTokens,
// } from "@utils/index";
// // import { ADDRESS_ZERO } from "@utils/constants";
// import { PRODUCTION_ADDRESSES } from "./addresses";
// // import { impersonateAccount } from "./utils";

// // const expect = getWaffleExpect();

// const USE_PRODUCTION_ADDRESSES = true;

// if (process.env.INTEGRATIONTEST) {
//   describe("FlashMintZeroExV2", () => {
//     let owner: Account;
//     let deployer: DeployHelper;
//     let manager: Account;
//     let tokens: ForkedTokens;

//     let debtIssuanceModule: DebtIssuanceModule;
//     const addresses = USE_PRODUCTION_ADDRESSES ? PRODUCTION_ADDRESSES : PRODUCTION_ADDRESSES;

//     let snapshotId: number;

//     beforeEach(async () => {
//       snapshotId = await network.provider.send("evm_snapshot", []);
//       [owner, manager] = await getAccounts();

//       deployer = new DeployHelper(owner.wallet);

//       console.log(addresses);
//       debtIssuanceModule = (await ethers.getContractAt(
//         "IDebtIssuanceModule",
//         PRODUCTION_ADDRESSES.setFork.debtIssuanceModuleV2,
//       )) as DebtIssuanceModule;

//       await initializeForkedTokens(PRODUCTION_ADDRESSES);
//       tokens = getForkedTokens(PRODUCTION_ADDRESSES);
//     });

//     afterEach(async () => {
//       await network.provider.send("evm_revert", [snapshotId]);
//     });
//   });
// }
