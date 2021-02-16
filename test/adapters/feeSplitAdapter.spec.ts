// import "module-alias/register";
// import { solidityKeccak256 } from "ethers/lib/utils";

// import { Address, Account, Bytes } from "@utils/types";
// import { ADDRESS_ZERO, ZERO } from "@utils/constants";
// import { ICManagerV2 } from "@utils/contracts/index";
// import { SetToken } from "@utils/contracts/setV2";
// import DeployHelper from "@utils/deploys";
// import {
//   addSnapshotBeforeRestoreAfterEach,
//   ether,
//   getAccounts,
//   getSetFixture,
//   getWaffleExpect,
//   getRandomAccount,
//   getRandomAddress
// } from "@utils/index";
// import { SetFixture } from "@utils/fixtures";

// const expect = getWaffleExpect();

// describe("ICManagerV2", () => {
//   let owner: Account;
//   let methodologist: Account;
//   let otherAccount: Account;
//   let newManager: Account;
//   let mockAdapter: Account;
//   let setV2Setup: SetFixture;

//   let deployer: DeployHelper;
//   let setToken: SetToken;

//   let icManagerV2: ICManagerV2;

//   before(async () => {
//     [
//       owner,
//       otherAccount,
//       newManager,
//       methodologist,
//       mockAdapter,
//     ] = await getAccounts();

//     deployer = new DeployHelper(owner.wallet);

//     setV2Setup = getSetFixture(owner.address);
//     await setV2Setup.initialize();

//     setToken = await setV2Setup.createSetToken(
//       [setV2Setup.dai.address],
//       [ether(1)],
//       [setV2Setup.issuanceModule.address, setV2Setup.streamingFeeModule.address]
//     );

//     // Initialize modules
//     await setV2Setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
//     const feeRecipient = owner.address;
//     const maxStreamingFeePercentage = ether(.1);
//     const streamingFeePercentage = ether(.02);
//     const streamingFeeSettings = {
//       feeRecipient,
//       maxStreamingFeePercentage,
//       streamingFeePercentage,
//       lastStreamingFeeTimestamp: ZERO,
//     };
//     await setV2Setup.streamingFeeModule.initialize(setToken.address, streamingFeeSettings);

//     // Deploy ICManagerV2
//     icManagerV2 = await deployer.manager.deployICManagerV2(
//       setToken.address,
//       owner.address,
//       methodologist.address
//     );

//     // Transfer ownership to ICManagerV2
//     await setToken.setManager(icManagerV2.address);
//   });

//   addSnapshotBeforeRestoreAfterEach();

//   describe("#constructor", async () => {
//     let subjectSetToken: Address;
//     let subjectOperator: Address;
//     let subjectMethodologist: Address;

//     beforeEach(async () => {
//       subjectSetToken = setToken.address;
//       subjectOperator = owner.address;
//       subjectMethodologist = methodologist.address;
//     });

//     async function subject(): Promise<ICManagerV2> {
//       return await deployer.manager.deployICManagerV2(
//         subjectSetToken,
//         subjectOperator,
//         subjectMethodologist
//       );
//     }

//     it("should set the correct SetToken address", async () => {
//       const retrievedICManager = await subject();

//       const actualToken = await retrievedICManager.setToken();
//       expect (actualToken).to.eq(subjectSetToken);
//     });

//     it("should set the correct Operator address", async () => {
//       const retrievedICManager = await subject();

//       const actualOperator = await retrievedICManager.operator();
//       expect (actualOperator).to.eq(subjectOperator);
//     });

//     it("should set the correct Methodologist address", async () => {
//       const retrievedICManager = await subject();

//       const actualMethodologist = await retrievedICManager.methodologist();
//       expect (actualMethodologist).to.eq(subjectMethodologist);
//     });
//   });
// });