import "module-alias/register";

import { Address, Account } from "@utils/types";
import { setBlockNumber } from "@utils/test/testingUtils";
import { MAX_UINT_256, ZERO } from "@utils/constants";
import {
  AuctionRebalanceModuleV1,
  AuctionRebalanceModuleV1__factory,
  ConstantPriceAdapter,
  ConstantPriceAdapter__factory,
  SetToken,
  SetToken__factory,
  BaseManagerV2,
  BaseManagerV2__factory,
  AuctionRebalanceExtension,
  AuctionRebalanceExtension__factory,
} from "../../../typechain";
import { impersonateAccount } from "./utils";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
} from "@utils/index";
import { BigNumber, ContractTransaction, Signer } from "ethers";

const expect = getWaffleExpect();

if (process.env.INTEGRATIONTEST) {
  describe.only("AuctionRebalanceExtensionV1 - Integration Test ic21", () => {
    let owner: Account;
    let operator: Signer;

    let ic21: SetToken;
    let baseManager: BaseManagerV2;

    let auctionModule: AuctionRebalanceModuleV1;
    let auctionRebalanceExtension: AuctionRebalanceExtension;

    let priceAdapter: ConstantPriceAdapter;

    setBlockNumber(18924016);

    before(async () => {
      [owner] = await getAccounts();

      // Constant Price Adapter
      // https://etherscan.io/address/0x13c33656570092555Bf27Bdf53Ce24482B85D992#code
      priceAdapter = ConstantPriceAdapter__factory.connect(
        "0x13c33656570092555Bf27Bdf53Ce24482B85D992",
        owner.wallet,
      );

      // Auction Rebalance Module V1
      // https://etherscan.io/address/0x59D55D53a715b3B4581c52098BCb4075C2941DBa#code
      auctionModule = AuctionRebalanceModuleV1__factory.connect(
        "0x59D55D53a715b3B4581c52098BCb4075C2941DBa",
        owner.wallet,
      );

        // ic21 Contract
      ic21 = SetToken__factory.connect(
        "0x1B5E16C5b20Fb5EE87C61fE9Afe735Cca3B21A65",
        owner.wallet
      );

      // ic21 Manager Contract
      baseManager = BaseManagerV2__factory.connect(
        "0x402d19089b797D60c366Bc38a8Cff0712D2F4947",
        owner.wallet
      );
      operator = await impersonateAccount("0x6904110f17feD2162a11B5FA66B188d801443Ea4");
      baseManager = baseManager.connect(operator);

      // Auction Rebalance Extension
      auctionRebalanceExtension = AuctionRebalanceExtension__factory.connect(
        "0x94cAEa398acC5931B1d32c548959A160Ac37Ff4a",
        operator,
      );
    });

    addSnapshotBeforeRestoreAfterEach();

    describe("#startRebalance", async () => {
        let subjectQuoteAsset: Address;
        let subjectOldComponents: Address[];
        let subjectNewComponents: Address[];
        let subjectNewComponentsAuctionParams: any[];
        let subjectOldComponentsAuctionParams: any[];
        let subjectShouldLockSetToken: boolean;
        let subjectRebalanceDuration: BigNumber;
        let subjectPositionMultiplier: BigNumber;
        let subjectCaller: Signer;

        before(async () => {
          // Quote asset is WETH, which has 18 decimals
          // Auction components may have different decimals, which must be adjusted for in price
          subjectQuoteAsset = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH

          // Must match SetToken.getComponents()
          // https://etherscan.io/token/0x1B5E16C5b20Fb5EE87C61fE9Afe735Cca3B21A65#readContract#F6
          subjectOldComponents = [
            "0x3f67093dfFD4F0aF4f2918703C92B60ACB7AD78b", // 21BTC
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
            "0x1bE9d03BfC211D83CFf3ABDb94A75F9Db46e1334", // 21BNB
            "0x0d3bd40758dF4F79aaD316707FcB809CD4815Ffe", // 21XRP
            "0x9c05d54645306d4C4EAd6f75846000E1554c0360", // 21ADA
            "0xb80a1d87654BEf7aD8eB6BBDa3d2309E31D4e598", // 21SOL
            "0x9F2825333aa7bC2C98c061924871B6C016e385F3", // 21LTC
            "0xF4ACCD20bFED4dFFe06d4C85A7f9924b1d5dA819", // 21DOT
            "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", // MATIC
            "0xFf4927e04c6a01868284F5C3fB9cba7F7ca4aeC0", // 21BCH
          ];

          // Components to add to the SetToken during the rebalance
          subjectNewComponents = [];
          // subjectNewComponents = [
          //   "0x514910771AF9Ca656af840dff83E8264,EcF986CA", // LINK
          // ];

          // Must match order of subjectNewComponents
          subjectNewComponentsAuctionParams = [];
          // subjectNewComponentsAuctionParams = [
          //   { // LINK, 18 decimals
          //       targetUnit: "100000000000000000",
          //       priceAdapterName: "ConstantPriceAdapter",
          //       priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.007468)),
          //     },
          // ];

          // Must match order of subjectOldComponents
          subjectOldComponentsAuctionParams = [
            { // 21BTC, 8 decimals
              targetUnit: "128270",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(17.972862).mul(ether(1).div(1e8))),
            },
            { // WETH, 18 decimals, this price curve won't be used because it's the quote asset
              targetUnit: "12760000000000000",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(1)),
            },
            { // 21BNB, 8 decimals
              targetUnit: "4078225",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.11187201).mul(ether(1).div(1e8))),
            },
            { // 21XRP, 6 decimals
              targetUnit: "22272822",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.00017329).mul(ether(1).div(1e6))),
            },
            { // 21ADA, 6 decimals
              targetUnit: "16274778",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.00020616).mul(ether(1).div(1e6))),
            },
            { // 21SOL, 9 decimals
              targetUnit: "140580280",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.03513891).mul(ether(1).div(1e9))),
            },
            { // 21LTC, 8 decimals
              targetUnit: ZERO, // Remove from the set
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.02399340).mul(ether(1).div(1e8))),
            },
            { // 21DOT, 10 decimals
              targetUnit: "8783960596",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.00277256).mul(ether(1).div(1e10))),
            },
            { // MATIC, 18 decimals
              targetUnit: "6575386581000000000",
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.00030279)),
            },
            { // 21BCH, 8 decimals
              targetUnit: ZERO, // Remove from the set
              priceAdapterName: "ConstantPriceAdapter",
              priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.12018696).mul(ether(1).div(1e8))),
            },
          ];

          subjectShouldLockSetToken = false; // pause issuance and redemption during the rebalance
          subjectRebalanceDuration = BigNumber.from(86400); // 1 hour in seconds
          subjectPositionMultiplier = await ic21.positionMultiplier(); // grab the current position multiplier
          subjectCaller = operator;

          console.log("Parameters for startRebalance:");
          console.log("subjectQuoteAsset", subjectQuoteAsset);
          console.log("subjectOldComponents", subjectOldComponents);
          console.log("subjectNewComponents", subjectNewComponents);
          console.log("subjectNewComponentsAuctionParams", subjectNewComponentsAuctionParams);
          console.log("subjectOldComponentsAuctionParams", subjectOldComponentsAuctionParams);
          console.log("subjectShouldLockSetToken", subjectShouldLockSetToken);
          console.log("subjectRebalanceDuration", subjectRebalanceDuration.toString());
          console.log("subjectPositionMultiplier", subjectPositionMultiplier.toString());
        });

        async function subject(): Promise<ContractTransaction> {
          return await auctionRebalanceExtension.connect(subjectCaller).startRebalance(
            subjectQuoteAsset,
            subjectOldComponents,
            subjectNewComponents,
            subjectNewComponentsAuctionParams,
            subjectOldComponentsAuctionParams,
            subjectShouldLockSetToken,
            subjectRebalanceDuration,
            subjectPositionMultiplier
          );
        }

        it("should kick off the rebalance", async () => {
          const isElapsedBefore = await auctionModule.isRebalanceDurationElapsed(ic21.address);
          expect(isElapsedBefore).to.be.true;

          await subject();

          const isElapsed = await auctionModule.isRebalanceDurationElapsed(ic21.address);
          expect(isElapsed).to.be.false;
        });

        it("should set the correct 21BTC market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[0],
            subjectQuoteAsset,
            MAX_UINT_256,
            MAX_UINT_256,
            true
          );

          // 0.12408063 BTC <> 2.23008403986306 WETH
          expect(preview.receiveToken).to.eq(subjectQuoteAsset);
          expect(preview.sendToken).to.eq(subjectOldComponents[0]);
          expect(preview.quantitySentBySet).to.eq("12408063");
          expect(preview.quantityReceivedBySet).to.eq("2230084039863060000");
        });

        it("should set the correct 21BNB market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[2],
            subjectQuoteAsset,
            MAX_UINT_256,
            0,
            false
          );

          // 0.19108137796 ETH <> 1.70803562 21BNB
          expect(preview.sendToken).to.eq(subjectQuoteAsset);
          expect(preview.receiveToken).to.eq(subjectOldComponents[2]);
          expect(preview.quantitySentBySet).to.eq("191081377960996200");
          expect(preview.quantityReceivedBySet).to.eq("170803562");
        });

        it("should set the correct 21XRP market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[3],
            subjectQuoteAsset,
            MAX_UINT_256,
            0,
            false
          );

          // 2.89349384341 WETH <> 16697.408064 XRP
          expect(preview.sendToken).to.eq(subjectQuoteAsset);
          expect(preview.receiveToken).to.eq(subjectOldComponents[3]);
          expect(preview.quantitySentBySet).to.eq("2893493843410560000");
          expect(preview.quantityReceivedBySet).to.eq("16697408064");
        });

        it("should set the correct 21ADA market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[4],
            subjectQuoteAsset,
            MAX_UINT_256,
            MAX_UINT_256,
            true
          );

          // 0.74005633524 WETH <> 3589.718351 21ADA
          expect(preview.receiveToken).to.eq(subjectQuoteAsset);
          expect(preview.sendToken).to.eq(subjectOldComponents[4]);
          expect(preview.quantitySentBySet).to.eq("3589718351");
          expect(preview.quantityReceivedBySet).to.eq("740056335242160000");
        });

        it("should set the correct 21SOL market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[5],
            subjectQuoteAsset,
            MAX_UINT_256,
            MAX_UINT_256,
            true
          );

          // 6.5485911871 WETH <> 186.362957391 21SOL
          expect(preview.receiveToken).to.eq(subjectQuoteAsset);
          expect(preview.sendToken).to.eq(subjectOldComponents[5]);
          expect(preview.quantitySentBySet).to.eq("186362957391");
          expect(preview.quantityReceivedBySet).to.eq("6548591187096183810");
        });

        it("should set the correct 21LTC market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[6],
            subjectQuoteAsset,
            MAX_UINT_256,
            MAX_UINT_256,
            true
          );

          // 3.66166316692 WETH <> 152.61126672 21LTC
          expect(preview.receiveToken).to.eq(subjectQuoteAsset);
          expect(preview.sendToken).to.eq(subjectOldComponents[6]);
          expect(preview.quantitySentBySet).to.eq("15261126672");
          expect(preview.quantityReceivedBySet).to.eq("3661663166919648000");
        });

        it("should set the correct 21DOT market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[7],
            subjectQuoteAsset,
            MAX_UINT_256,
            0,
            false
          );

          // 0.47352168559 WETH <> 170.788616151 21DOT
          expect(preview.sendToken).to.eq(subjectQuoteAsset);
          expect(preview.receiveToken).to.eq(subjectOldComponents[7]);
          expect(preview.quantitySentBySet).to.eq("473521685595893816");
          expect(preview.quantityReceivedBySet).to.eq("1707886161511");
        });

        it("should set the correct 21BCH market", async () => {
          await subject();

          const preview = await auctionModule.getBidPreview(
            ic21.address,
            subjectOldComponents[9],
            subjectQuoteAsset,
            MAX_UINT_256,
            MAX_UINT_256,
            true
          );

          // 4.65454307982 WETH <> 38.72752152 21BCH
          expect(preview.receiveToken).to.eq(subjectQuoteAsset);
          expect(preview.sendToken).to.eq(subjectOldComponents[9]);
          expect(preview.quantitySentBySet).to.eq("3872752152");
          expect(preview.quantityReceivedBySet).to.eq("4654543079823379200");
        });
      });
  });
}
