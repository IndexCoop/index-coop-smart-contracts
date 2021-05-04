import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";
import { Signer } from "ethers";
import { ether, getEthBalance, getWaffleExpect } from "@utils/index";
import { Address } from "@utils/types";
import { MAX_UINT_256, ZERO } from "@utils/constants";

const hre = require("hardhat");

const erc20abi = require("../exchangeIssuance/erc20abi");

const btcFliAddress = "0x2fa6ffC08F30866B4f6eC56f31f4E31b4bB91ADa"; // TBD Staging main address for now
const wbtcAddress = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const cWbtcAddress = "0xccf4429db6322d5c611ee964527d42e5d685dd6a";
const usdcAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const sushiFactory = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const sushiRouter = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const debtIssuanceModule = "0x338BEf3f37794dd199d6910E6109125D3eCa6048"; // TBD Staging main address for now
const dydxSolo = "0x1E0447b19BB6EcFdAe1e4AE1694b0C3659614e4e";
const indexCoopTreasury = "0x9467cfadc9de245010df95ec6a585a506a8ad5fc";

const expect = getWaffleExpect();

const deploy = async (account: any) => {
  const simpleCompoundErc20FLIArb = await ethers.getContractFactory("SimpleCompoundErc20FLIArb");
  return (
    await simpleCompoundErc20FLIArb.deploy(
      dydxSolo,
      sushiRouter,
      debtIssuanceModule,
      wethAddress,
      sushiFactory,
      indexCoopTreasury
    )
  ).connect(account);
};

describe("SimpleCompoundErc20FLIArb [ @forked-network ]", function () {

  let account: Signer;
  let simpleCompoundErc20FLIArb: any;

  before(async () => {
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9"],
    });
    account = await ethers.provider.getSigner("0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9");
    simpleCompoundErc20FLIArb = await deploy(account);
  });

  describe("approveAll", () => {
    let subjectSetToken: Address;

    beforeEach(async () => {
      subjectSetToken = btcFliAddress;
    });

    async function subject(): Promise<any> {
      return simpleCompoundErc20FLIArb.approveAll(subjectSetToken);
    }

    it("should set approvals for weth to solo", async () => {
      await subject();
      const wethInstance = new ethers.Contract(wethAddress, erc20abi, account);
      const routerWethAllowance = await wethInstance.allowance(simpleCompoundErc20FLIArb.address, dydxSolo);

      expect(routerWethAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for weth to router", async () => {
      await subject();
      const wethInstance = new ethers.Contract(wethAddress, erc20abi, account);
      const routerWethAllowance = await wethInstance.allowance(simpleCompoundErc20FLIArb.address, sushiRouter);

      expect(routerWethAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for set token to router", async () => {
      await subject();

      const btcFliInstance = new ethers.Contract(btcFliAddress, erc20abi, account);

      const routerSetTokenAllowance = await btcFliInstance.allowance(simpleCompoundErc20FLIArb.address, sushiRouter);
      expect(routerSetTokenAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for collateral to router", async () => {
      await subject();
      const wbtcInstance = new ethers.Contract(wbtcAddress, erc20abi, account);
      const routerCollateralAssetAllowance = await wbtcInstance.allowance(simpleCompoundErc20FLIArb.address, sushiRouter);
      expect(routerCollateralAssetAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for ctoken to issuance module", async () => {
      await subject();
      const cWbtcInstance = new ethers.Contract(cWbtcAddress, erc20abi, account);
      const issuanceModuleCTokenAllowance = await cWbtcInstance.allowance(simpleCompoundErc20FLIArb.address, debtIssuanceModule);
      expect(issuanceModuleCTokenAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for borrow asset to issuance module", async () => {
      await subject();

      const usdcInstance = new ethers.Contract(usdcAddress, erc20abi, account);

      const issuanceModuleBorrowAssetAllowance =
        await usdcInstance.allowance(simpleCompoundErc20FLIArb.address, debtIssuanceModule);
      expect(issuanceModuleBorrowAssetAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for borrow to router", async () => {
      await subject();
      const usdcInstance = new ethers.Contract(usdcAddress, erc20abi, account);

      const routerBorrowAssetAllowance = await usdcInstance.allowance(simpleCompoundErc20FLIArb.address, sushiRouter);
      expect(routerBorrowAssetAllowance).to.eq(MAX_UINT_256);
    });

    it("should set approvals for underlying to cToken", async () => {
      await subject();

      const wbtcInstance = new ethers.Contract(wbtcAddress, erc20abi, account);
      const cTokenUnderlyingAssetAllowance =
        await wbtcInstance.allowance(simpleCompoundErc20FLIArb.address, cWbtcAddress);

      expect(cTokenUnderlyingAssetAllowance).to.eq(MAX_UINT_256);
    });
  });

  describe("executeFlashLoanArb", () => {
    let subjectSetToken: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectLoanAmount: BigNumber;
    let subjectMaxTradeSlippage: BigNumber;
    let subjectPoolSetReserves: BigNumber;
    let subjectIsIssueArb: boolean;
    let subjectSetPoolToken: Address;

    beforeEach(async () => {
      await simpleCompoundErc20FLIArb.approveAll(btcFliAddress);

      subjectSetToken = btcFliAddress;
      subjectSetTokenQuantity = ether(0.01);
      subjectLoanAmount = ether(200);
      subjectMaxTradeSlippage = ether(0.02);
      subjectPoolSetReserves = ether(100);
      subjectIsIssueArb = false; // Redeem arb
      subjectSetPoolToken = wbtcAddress;
    });

    async function subject(): Promise<any> {
      return simpleCompoundErc20FLIArb.executeFlashLoanArb(
        subjectSetToken,
        subjectSetTokenQuantity,
        subjectLoanAmount,
        subjectMaxTradeSlippage,
        subjectPoolSetReserves,
        subjectIsIssueArb,
        subjectSetPoolToken
      );
    }

    it("should redeem arb and send ETH to correct parties", async () => {
      const previousTreasuryBalance = await getEthBalance(indexCoopTreasury);
      const previousCallerBalance = await getEthBalance("0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9");
      const previousContractBalance = await getEthBalance(simpleCompoundErc20FLIArb.address);

      await subject();

      const currentTreasuryBalance = await getEthBalance(indexCoopTreasury);
      const currentCallerBalance = await getEthBalance("0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9");
      const currentContractBalance = await getEthBalance(simpleCompoundErc20FLIArb.address);

      expect(currentTreasuryBalance).to.gte(previousTreasuryBalance);
      expect(previousCallerBalance).to.gte(currentCallerBalance);
      expect(previousContractBalance).to.eq(ZERO);
      expect(currentContractBalance).to.eq(ZERO);
    });
  });
});
