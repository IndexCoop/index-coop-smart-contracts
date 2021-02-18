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
const setController = "0xa4c8d221d8BB851f83aadd0223a8900A6921A349";
const basicIssuanceModule = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D";

const deploy = async (account: any) => {
  const ExchangeIssuance = await ethers.getContractFactory("ExchangeIssuance");
  return (await ExchangeIssuance.deploy(uniFactory,
    uniRouter,
    sushiFactory,
    sushiRouter,
    setController,
    basicIssuanceModule
    )
  ).connect(account);
};

const issueSetForExactToken = async (ERC20Address: string, account: Signer, amount: Number) => {
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
  await exchangeIssuance.issueSetForExactToken(
    dpiAddress,
    ERC20Address,
    ethers.utils.parseEther(amount.toString()),
    ethers.utils.parseEther("0")
  );

  // get final DPI and ERC20 balances
  const finalDPIBalance = await dpi.balanceOf(account.getAddress());
  const finalERC20Balance = await ERC20.balanceOf(account.getAddress());

  // check if final DPI is greater than init, and if final DAI is less than init
  return finalDPIBalance.gt(initDPIBalance) && finalERC20Balance.lt(initERC20Balance);
};

const issueExactSetFromToken = async (ERC20Address: string, account: Signer, amountSetToken: Number) => {
  // get initial DPI and ERC20 balances
  const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
  const ERC20 = new ethers.Contract(ERC20Address, erc20abi, account);
  const DPIIssueAmount = ethers.utils.parseEther(amountSetToken.toString());

  const initDPIBalance = await dpi.balanceOf(account.getAddress());
  const initERC20Balance = await ERC20.balanceOf(account.getAddress());

  // deploy ExchangeIssuance.sol
  const exchangeIssuance = await deploy(account);

  await exchangeIssuance.approveSetToken(dpiAddress);

  // issue DPI with ERC20
  let amountToken = await exchangeIssuance.getAmountInToIssueExactSet(dpiAddress, ERC20Address, DPIIssueAmount);
  amountToken = amountToken.mul("2");
  await ERC20.approve(exchangeIssuance.address, amountToken);
  await exchangeIssuance.issueExactSetFromToken(
    dpiAddress,
    ERC20Address,
    ethers.utils.parseEther(amountSetToken.toString()),
    amountToken
  );

  // get final DPI and ERC20 balances
  const finalDPIBalance = await dpi.balanceOf(account.getAddress());
  const finalERC20Balance = await ERC20.balanceOf(account.getAddress());

  // check if change in DPI balance is equal to DPI amount issued, and if final DAI is less than init
  return finalDPIBalance.sub(initDPIBalance).eq(DPIIssueAmount) && finalERC20Balance.lt(initERC20Balance);
};

const redeemExactSetForERC20 = async (ERC20Address: string, account: Signer, amount: Number) => {
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
  await exchangeIssuance.redeemExactSetForToken(dpiAddress, ERC20Address, ethers.utils.parseEther(amount.toString()), ethers.utils.parseEther("0"));

  // get final DPI and ERC20 balances
  const finalDPIBalance = await dpi.balanceOf(account.getAddress());
  const finalERC20Balance = await ERC20.balanceOf(account.getAddress());

  // check if final DPI is less than init, and if final ERC20 is more than init
  return finalDPIBalance.lt(initDPIBalance) && finalERC20Balance.gt(initERC20Balance);
};

describe("ExchangeIssuance", function () {

  let account: Signer;

  before(async () => {
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9"],
    }
    );
    account = await ethers.provider.getSigner("0x56178a0d5F301bAf6CF3e1Cd53d9863437345Bf9");
  });

  describe("Issue (Exact input)", () => {
    it("Should issue DPI with ETH", async () => {
      // get initial ETH and DPI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const initETHBalance = await account.getBalance();

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // issue 5 ETH worth of DPI
      await exchangeIssuance.approveSetToken(dpiAddress);
      const overrides = {
        value: ethers.utils.parseEther("5"),
      };
      await exchangeIssuance.issueSetForExactETH(dpiAddress, 0, overrides);

      // get final ETH and DPI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalETHBalance = await account.getBalance();

      // check if final DPI is greater than init, and if final ETH is less than init (accounting for gas fees)
      expect(finalDPIBalance.gt(initDPIBalance)).to.equal(true);
      expect(finalETHBalance.add(ethers.utils.parseEther("0.2")).lt(initETHBalance)).to.equal(true);
    });

    it("Should issue DPI with an ERC20 (DAI)", async () => {
      const passed = await issueSetForExactToken(daiAddress, account, 2000);
      expect(passed).to.equal(true);
    });

    it("Should issue DPI with an ERC20 (WETH)", async () => {
      const passed = await issueSetForExactToken(wethAddress, account, 200);
      expect(passed).to.equal(true);
    });
  });

  describe("Issue (Exact output)", () => {
    it("Should issue DPI with ETH", async () => {
      // get initial ETH and DPI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);

      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const initETHBalance = await account.getBalance();

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // issue 5 DPI
      await exchangeIssuance.approveSetToken(dpiAddress);
      const DPIIssueAmount = ethers.utils.parseEther("5");
      const ETHAmountIn = await exchangeIssuance.getAmountInToIssueExactSet(dpiAddress, wethAddress, DPIIssueAmount);
      await exchangeIssuance.issueExactSetFromETH(dpiAddress, DPIIssueAmount, {value: ETHAmountIn});

      // get final ETH and DPI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalETHBalance = await account.getBalance();

      // check if change in DPI balance is equal to DPI amount issued
      expect(finalDPIBalance.sub(initDPIBalance)).to.equal(DPIIssueAmount);
      expect(finalETHBalance.add(ethers.utils.parseEther("0.2")).lt(initETHBalance)).to.equal(true);
    });

    it("Should issue DPI with an ERC20 (DAI)", async () => {
      const passed = await issueExactSetFromToken(daiAddress, account, 20);
      expect(passed).to.equal(true);
    });

    it("Should issue DPI with an ERC20 (WETH)", async () => {
      const passed = await issueExactSetFromToken(wethAddress, account, 20);
      expect(passed).to.equal(true);
    });
  });

  describe("Redeem (Exact input)", () => {
    it("Should redeem DPI for ETH", async () => {
      // get initial ETH and DPI balances
      const dpi = new ethers.Contract(dpiAddress, erc20abi, account);
      const initDPIBalance = await dpi.balanceOf(account.getAddress());
      const initETHBalance = await account.getBalance();

      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // redeem dpi for ETH
      await dpi.approve(exchangeIssuance.address, ethers.utils.parseEther("10"));
      await exchangeIssuance.approveSetToken(dpiAddress);
      await exchangeIssuance.redeemExactSetForETH(dpiAddress,
        ethers.utils.parseEther("10"),
        ethers.utils.parseEther("1")
      );

      // get final ETH and DPI balances
      const finalDPIBalance = await dpi.balanceOf(account.getAddress());
      const finalETHBalance = await account.getBalance();

      // check if final DPI is less than init, and if final ETH is more than init
      expect(finalDPIBalance.lt(initDPIBalance)).to.equal(true);
      expect(finalETHBalance.gt(initETHBalance)).to.equal(true);
    });

    it("Should redeem DPI for an ERC20 (DAI)", async () => {
      const passed = await redeemExactSetForERC20(daiAddress, account, 10);
      expect(passed).to.equal(true);
    });

    it("Should redeem DPI for an ERC20 (WETH)", async () => {
      const passed = await redeemExactSetForERC20(wethAddress, account, 10);
      expect(passed).to.equal(true);
    });
  });

  describe("Estimate Issue (Fixed Input)", () => {
    it("Should be able to get approx issue amount given an input ERC20 amount (WETH)", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx issue amount in DPI
      const amountOut = await exchangeIssuance.getEstimatedIssueSetAmount(dpiAddress, wethAddress, ethers.utils.parseEther("200"));

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("4"))).to.equal(true);
    });

    it("Should be able to get approx issue amount given an input ERC20 amount (DAI)", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx issue amount in DPI
      const amountOut = await exchangeIssuance.getEstimatedIssueSetAmount(dpiAddress, daiAddress, ethers.utils.parseEther("200"));

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("1"))).to.equal(true);
    });
  });

  describe("Estimate Issue (Fixed Output)", () => {
    it("Should be able to get approx input ERC20 (WETH) amount given a DPI amount", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      const DPIIssueAmount = ethers.utils.parseEther("5");
      const ETHAmountIn = await exchangeIssuance.getAmountInToIssueExactSet(dpiAddress, wethAddress, DPIIssueAmount);

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(ETHAmountIn.lt(ethers.utils.parseEther("0.89"))).to.equal(true);
      expect(ETHAmountIn.gt(ethers.utils.parseEther("0.86"))).to.equal(true);
    });

    it("Should be able to get approx input ERC20 (DAI) amount given a amount", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      const DPIIssueAmount = ethers.utils.parseEther("5");
      const DAIAmountIn = await exchangeIssuance.getAmountInToIssueExactSet(dpiAddress, daiAddress, DPIIssueAmount);

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(DAIAmountIn.lt(ethers.utils.parseEther("200").mul(5))).to.equal(true);
      expect(DAIAmountIn.gt(ethers.utils.parseEther("190").mul(5))).to.equal(true);
    });
  });

  describe("Estimate Redeem (Fixed input)", () => {
    it("Should be able to get approx redeem amount in ETH given an input set amount", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx redeem amount in ETH
      const amountOut = await exchangeIssuance.getEstimatedRedeemSetAmount(dpiAddress, wethAddress, ethers.utils.parseEther("1"));

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("0.15"))).to.equal(true);
    });

    it("Should be able to get approx redeem amount in an ERC20 (dai) given an input set amount", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // get approx redeem amount in ETH
      const amountOut = await exchangeIssuance.getEstimatedRedeemSetAmount(dpiAddress, daiAddress, ethers.utils.parseEther("1"));

      // check if output is correct (this may break if you change the block number of the hardhat fork)
      expect(amountOut.gt(ethers.utils.parseEther("180"))).to.equal(true);
    });
  });

  describe("isSetToken modifier", () => {
    it("Should revert when SetToken is not conform to ISetToken", async () => {
      // deploy ExchangeIssuance.sol
      const exchangeIssuance = await deploy(account);

      // aprove dai
      const dai = new ethers.Contract(daiAddress, erc20abi, account);
      await dai.approve(exchangeIssuance.address, ethers.utils.parseEther("10"));

      // redeem dpi for ETH
      const result = exchangeIssuance.redeemExactSetForETH(daiAddress,
        ethers.utils.parseEther("10"),
        ethers.utils.parseEther("1")
      );

      await expect(result).to.be.revertedWith("INVALID SET");
    });
  });
});
