import { ethers } from "ethers";
import { BigNumber } from "ethers/lib/ethers";

export const ether = (amount: number): BigNumber => {
  const weiString = ethers.utils.parseEther(amount.toString());
  return BigNumber.from(weiString);
};

export const usdc = (amount: number): BigNumber => {
  const weiString = BigNumber.from("1000000").mul(amount);
  return BigNumber.from(weiString);
};

export const bitcoin = (amount: number): BigNumber => {
  const weiString = 100000000 * amount;
  return BigNumber.from(weiString);
};

export const gWei = (amount: number): BigNumber => {
  const weiString = BigNumber.from("1000000000").mul(amount);
  return BigNumber.from(weiString);
};

export const wbtc = (amount: number): BigNumber => {
  return BigNumber.from(amount).mul(BigNumber.from(10).pow(8));
};

export const UnitsUtils = { usdc, wbtc, ether, gWei };