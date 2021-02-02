import "module-alias/register";
import { ethers } from "hardhat";
import { Signer } from "ethers";

const { expect } = require("chai");
const hre = require("hardhat");

const erc20abi = require("./erc20abi");

const dpiAddress = "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b";
const daiAddress = "0x6b175474e89094c44da98b954eedeac495271d0f";
const wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const uniFactory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const uniRouter = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const sushiFactory = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const sushiRouter = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const basicIssuanceModule = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D";

const deploy = async (account: any) => {
  const ExchangeIssuance = await ethers.getContractFactory("ExchangeIssuance");
  return (await ExchangeIssuance.deploy(uniFactory, uniRouter, sushiFactory, sushiRouter, basicIssuanceModule)).connect(account);
};

const issueERC20 = async (ERC20Address: string, account: Signer, amount: Number) => {
  // get initial DPI and ERC20 balances
  const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
  const initDPIBalance = await dpi.balanceOf(account.getAddress());
  const ERC20 = new ethers.Contract(ERC20Address, erc20abi, account);
  const initERC20Balance = await ERC20.balanceOf(account.getAddress());

  // deploy ExchangeIssuance.sol
  const exchangeIssuance = await deploy(account);

  // issue DPI with ERC20
  await ERC20.approve(exchangeIssuance.address, ethers.utils.parseEther(amount.toString()));
  await exchangeIssuance.approveSetToken(dpiAddress);
  await exchangeIssuance.exchangeIssue(dpiAddress, ethers.utils.parseEther(amount.toString()), false, ERC20Address, ethers.utils.parseEther("0"));

  // get final DPI and ERC20 balances
  const finalDPIBalance = await dpi.balanceOf(account.getAddress());
  const finalERC20Balance = await ERC20.balanceOf(account.getAddress());

  // check if final DPI is less than init, and if final DAI is more than init
  return finalDPIBalance.gt(initDPIBalance) && finalERC20Balance.lt(initERC20Balance);
};

const redeemERC20 = async (ERC20Address: string, account: Signer, amount: Number) => {
  // get initial DPI and ERC20 balances
  const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
  const initDPIBalance = await dpi.balanceOf(account.getAddress());
  const ERC20 = new ethers.Contract(ERC20Address, erc20abi, account);
  const initERC20Balance = await ERC20.balanceOf(account.getAddress());

  // deploy ExchangeIssuance.sol
  const exchangeIssuance = await deploy(account);

  // redeem DPI for ERC20
  await dpi.approve(exchangeIssuance.address, ethers.utils.parseEther(amount.toString()));
  await exchangeIssuance.approveSetToken(dpiAddress);
  await exchangeIssuance.exchangeRedeem(dpiAddress, ethers.utils.parseEther(amount.toString()), false, ERC20Address, ethers.utils.parseEther("0"));

  // get final DPI and ERC20 balances
  const finalDPIBalance = await dpi.balanceOf(account.getAddress());
  const finalERC20Balance = await ERC20.balanceOf(account.getAddress());

  // check if final DPI is less than init, and if final ERC20 is more than init
  return finalDPIBalance.lt(initDPIBalance) && finalERC20Balance.gt(initERC20Balance);
};

describe("ExchangeIssuance", function() {

  let account: Signer;

  before(async () => {
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9"]}
    );
    account = await ethers.provider.getSigner("0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9");
  });

  describe("Issue", () => {
    it("Should issue DPI with ETH", async function() {
      // get initial ETH and DPI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
      // console.log(signer);
      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const initETHBalance = await account.getBalance();

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // issue 10 ETH worth of DPI
      await exchangeIssuance.approveSetToken(dpiAddress);
      const overrides = {
          value: ethers.utils.parseEther("5"),
      };
      await exchangeIssuance.exchangeIssue(
        dpiAddress, ethers.utils.parseEther("5"),
        true, "0x0000000000000000000000000000000000000000",
        0, overrides
      );

      // get final ETH and DPI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalETHBalance = await account.getBalance();

      // check if final DPI is greater than init, and if final ETH is less than init (accounting for gas fees)
      expect(finalDPIBalance.gt(initDPIBalance)).to.equal(true);
      expect(finalETHBalance.add(ethers.utils.parseEther("0.2")).lt(initETHBalance)).to.equal(true);
    });

    it("Should issue DPI with an ERC20 (DAI)", async function() {
      const passed = await issueERC20(daiAddress, account, 2000);
      expect(passed).to.equal(true);
    });

    it("Should issue DPI with an ERC20 (WETH)", async function() {
      const passed = await issueERC20(wethAddress, account, 200);
      expect(passed).to.equal(true);
    });
  });

  describe("Redeem", () => {
    it("Should redeem DPI for ETH", async function() {
      // get initial ETH and DPI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const initETHBalance = await account.getBalance();

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // redeem dpi for ETH
      await dpi.approve(exchangeIssuance.address, ethers.utils.parseEther("10"));
      await exchangeIssuance.approveSetToken(dpiAddress);
      await exchangeIssuance.exchangeRedeem(dpiAddress,
        ethers.utils.parseEther("10"),
        true, "0x0000000000000000000000000000000000000000",
        ethers.utils.parseEther("1")
      );

      // get final ETH and DPI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalETHBalance = await account.getBalance();

      // check if final DPI is less than init, and if final ETH is more than init
      expect(finalDPIBalance.lt(initDPIBalance)).to.equal(true);
      expect(finalETHBalance.gt(initETHBalance)).to.equal(true);
    });

    it("Should redeem DPI for an ERC20 (DAI)", async function() {
      const passed = await redeemERC20(daiAddress, account, 10);
      expect(passed).to.equal(true);
    });

    it("Should redeem DPI for an ERC20 (WETH)", async function() {
      const passed = await redeemERC20(wethAddress, account, 10);
      expect(passed).to.equal(true);
    });
  });

  describe("Estimate Issue", () => {
    it("Should be able to get approx issue amount given an input Ether amount", async function() {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx issue amount in DPI
      const amountOut = await exchangeIssuance.getEstimatedIssueSetQuantity(dpiAddress, ethers.utils.parseEther("1"), true, "0x0000000000000000000000000000000000000000");

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("4"))).to.equal(true);
    });

    it("Should be able to get approx issue amount given an input ERC20 amount (dai)", async function() {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx issue amount in DPI
      const amountOut = await exchangeIssuance.getEstimatedIssueSetQuantity(dpiAddress, ethers.utils.parseEther("200"), false, daiAddress);

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("1"))).to.equal(true);
    });
  });

  describe("Estimate Redeem", () => {
    it("Should be able to get approx redeem amount in ETH", async function() {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx redeem amount in ETH
      const amountOut = await exchangeIssuance.getEstimatedRedeemSetQuantity(dpiAddress, ethers.utils.parseEther("1"), true, "0x0000000000000000000000000000000000000000");

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("0.15"))).to.equal(true);
    });

    it("Should be able to get approx redeem amount in an ERC20 (dai)", async function() {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx redeem amount in ETH
      const amountOut = await exchangeIssuance.getEstimatedRedeemSetQuantity(dpiAddress, ethers.utils.parseEther("1"), false, daiAddress);

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("180"))).to.equal(true);
    });

  });
});
