import "module-alias/register";

import { Address, Account } from "@utils/types";
import { setBlockNumber } from "@utils/test/testingUtils";
import { ZERO } from "@utils/constants";
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

      priceAdapter = ConstantPriceAdapter__factory.connect(
        "0x13c33656570092555Bf27Bdf53Ce24482B85D992",
        owner.wallet,
      );

      auctionModule = AuctionRebalanceModuleV1__factory.connect(
        "0x59D55D53a715b3B4581c52098BCb4075C2941DBa",
        owner.wallet,
      );

      ic21 = SetToken__factory.connect(
        "0x1B5E16C5b20Fb5EE87C61fE9Afe735Cca3B21A65",
        owner.wallet
      );

      baseManager = BaseManagerV2__factory.connect(
        "0x402d19089b797D60c366Bc38a8Cff0712D2F4947",
        owner.wallet
      );
      operator = await impersonateAccount("0x6904110f17feD2162a11B5FA66B188d801443Ea4");
      baseManager = baseManager.connect(operator);

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

        beforeEach(async () => {
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
          subjectNewComponents = [
            "0x514910771AF9Ca656af840dff83E8264,EcF986CA", // LINK
          ];

          // Must match order of subjectNewComponents
          subjectNewComponentsAuctionParams = [
            { // link, 18 decimals
                targetUnit: "100000000000000000",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.007468)),
              },
          ];

          // Must match order of subjectOldComponents
          subjectOldComponentsAuctionParams = [
            { // 21BTC, 8 decimals
                targetUnit: "150000",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(18.52).mul(ether(1).div(1e8))),
              },
              { // WETH, 18 decimals, this price curve won't be used because it's the quote asset
                targetUnit: "1000000000000000000",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(1)),
              },
              { // 21BNB, 8 decimals
                targetUnit: "2013293",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.13).mul(ether(1).div(1e8))),
              },
              { // xrp, 6 decimals
                targetUnit: "10000000",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(1).mul(ether(0.00022).div(1e6))),
              },
              { // ada, 6 decimals
                targetUnit: "10639431",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(1).mul(ether(0.0002).div(1e6))),
              },
              { // sol, 9 decimals
                targetUnit: "111427278",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.04).mul(ether(1).div(1e9))),
              },
              { // ltc, 8 decimals
                targetUnit: ZERO, // remove from the set
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.03).mul(ether(1).div(1e8))),
              },
              { // dot, 10 decimals
                targetUnit: "5134697410",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.0029).mul(ether(1).div(1e10))),
              },
              { // matic, 18 decimals
                targetUnit: "5000000000000000000",
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.0003457)),
              },
              { // bch, 8 decimals
                targetUnit: ZERO, // remove from the set
                priceAdapterName: "ConstantPriceAdapter",
                priceAdapterConfigData: await priceAdapter.getEncodedData(ether(0.1).mul(ether(1).div(1e8))),
              },
          ];

          subjectShouldLockSetToken = true; // pause issuance and redemption during the rebalance
          subjectRebalanceDuration = BigNumber.from(86400); // 1 day in seconds
          subjectPositionMultiplier = await ic21.positionMultiplier(); // grab the current position multiplier
          subjectCaller = operator;
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
      });
  });
}
