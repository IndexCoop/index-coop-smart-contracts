import { ethers } from "ethers";
import { BigNumber } from "ethers/lib/ethers";

export const ether = (amount: number): BigNumber => {
  return ethers.utils.parseEther(amount.toString());
};

export const usdc = (amount: number): BigNumber => {
  return ethers.utils.parseUnits(amount.toString(), 6);
};

export const bitcoin = (amount: number): BigNumber => {
  return ethers.utils.parseUnits(amount.toString(), 8);
};

export const gWei = (amount: number): BigNumber => {
  return ethers.utils.parseUnits(amount.toString(), 9);
};

export const wbtc = (amount: number): BigNumber => {
  return ethers.utils.parseUnits(amount.toString(), 8);
};

export const UnitsUtils = { usdc, wbtc, ether, gWei };
