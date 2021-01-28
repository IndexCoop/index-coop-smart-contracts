import "module-alias/register";
import { ethers } from "hardhat";
import { Signer } from "ethers";

const { expect } = require("chai");
const hre = require("hardhat");

const erc20abi = require("./erc20abi");

const dpiAddress = "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b";
const daiAddress = "0x6b175474e89094c44da98b954eedeac495271d0f";

const uniFactory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const uniRouter = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const sushiFactory = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const sushiRouter = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const basicIssuanceModule = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D";

const deploy = async (account: any) => {
  const ExchangeIssuance = await ethers.getContractFactory("ExchangeIssuance");
  return (await ExchangeIssuance.deploy(uniFactory, uniRouter, sushiFactory, sushiRouter, basicIssuanceModule)).connect(account);
};

describe("ExchangeIssuance", function() {

  let account: Signer;

  before(async () => {
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8"]}
    );
    account = await ethers.provider.getSigner("0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8");
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
      await exchangeIssuance.initApprovals(dpiAddress);
      const overrides = {
          value: ethers.utils.parseEther("20"),
      };
      await exchangeIssuance.exchangeIssue(
        dpiAddress, ethers.utils.parseEther("20"),
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
      // get initial DPI and DAI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const dai = new ethers.Contract(daiAddress, erc20abi, account);
      const initDAIBalance = await dai.balanceOf(account.getAddress());

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // issue DPI with DAI
      await dai.approve(exchangeIssuance.address, ethers.utils.parseEther("10000"));
      await exchangeIssuance.initApprovals(dpiAddress);
      await exchangeIssuance.exchangeIssue(dpiAddress, ethers.utils.parseEther("1900"), false, daiAddress, ethers.utils.parseEther("4"));

      // get final DPI and DAI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalDAIBalance = await dai.balanceOf(account.getAddress());

      // check if final DPI is less than init, and if final DAI is more than init
      expect(finalDPIBalance.gt(initDPIBalance)).to.equal(true);
      expect(finalDAIBalance.lt(initDAIBalance)).to.equal(true);
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
      await exchangeIssuance.initApprovals(dpiAddress);
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
      // get initial DPI and DAI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const dai = new ethers.Contract(daiAddress, erc20abi, account);
      const initDAIBalance = await dai.balanceOf(account.getAddress());

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // redeem DPI for DAI
      await dpi.approve(exchangeIssuance.address, ethers.utils.parseEther("10"));
      await exchangeIssuance.initApprovals(dpiAddress);
      await exchangeIssuance.exchangeRedeem(dpiAddress, ethers.utils.parseEther("10"), false, daiAddress, ethers.utils.parseEther("1000"));

      // get final DPI and DAI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalDAIBalance = await dai.balanceOf(account.getAddress());

      // check if final DPI is less than init, and if final DAI is more than init
      expect(finalDPIBalance.lt(initDPIBalance)).to.equal(true);
      expect(finalDAIBalance.gt(initDAIBalance)).to.equal(true);
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
