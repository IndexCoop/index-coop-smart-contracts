import "module-alias/register";
import { getAccounts } from "@utils/index";
import { Account } from "@utils/types";
const { expect } = require("chai");
const { ethers } = require("hardhat");

const erc20abi = require("./erc20abi");

const dpiAddress = "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b";

describe("IssueRedeem", function() {

  let account: Account;

  before(async () => {
    [account] = await getAccounts();
  });

  it("Should issue DPI with ETH", async function() {
    // get initial ETH and DPI balances
    const dpi = new ethers.Contract(dpiAddress, erc20abi, account.wallet);
    // console.log(signer);
    const initDPIBalance = await dpi.balanceOf(account.wallet.address);
    const initETHBalance = await account.wallet.getBalance();

    // deploy IssueRedeem.sol
    const IssueRedeem = await ethers.getContractFactory("IssueRedeem");
    const issueRedeem = (await IssueRedeem.deploy()).connect(account.wallet);

    // issue 10 DPI using ETH
    await issueRedeem.initApprovals(dpiAddress);
    const overrides = {
        value: ethers.utils.parseEther("5"),
    };
    await issueRedeem.issue(dpiAddress, ethers.utils.parseEther("10"), overrides);

    // get final ETH and DPI balances
    const finalDPIBalance = await dpi.balanceOf(account.wallet.address);
    const finalETHBalance = await account.wallet.getBalance();

    // check if final DPI is greater than init, and if final ETH is less than init (accounting for gas fees)
    expect(finalDPIBalance.gt(initDPIBalance)).to.equal(true);
    expect(finalETHBalance.add(ethers.utils.parseEther("0.2")).lt(initETHBalance)).to.equal(true);
  });

  it("Should redeem DPI for ETH", async function() {
    // get initial ETH and DPI balances
    const dpi = new ethers.Contract(dpiAddress, erc20abi, account.wallet);
    const initDPIBalance = await dpi.balanceOf(account.wallet.address);
    const initETHBalance = await account.wallet.getBalance();

    // deploy IssueRedeem.sol
    const IssueRedeem = await ethers.getContractFactory("IssueRedeem");
    const issueRedeem = (await IssueRedeem.deploy()).connect(account.wallet);

    // redeem dpi for ETH
    await dpi.approve(issueRedeem.address, ethers.utils.parseEther("10"));
    await issueRedeem.initApprovals(dpiAddress);
    await issueRedeem.redeem(dpiAddress, ethers.utils.parseEther("10"));

    // get final ETH and DPI balances
    const finalDPIBalance = await dpi.balanceOf(account.wallet.address);
    const finalETHBalance = await account.wallet.getBalance();

    // check if final DPI is less than init, and if final ETH is more than init
    expect(finalDPIBalance.lt(initDPIBalance)).to.equal(true);
    expect(finalETHBalance.gt(initETHBalance)).to.equal(true);
  });
});
