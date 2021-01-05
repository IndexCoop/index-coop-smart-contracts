import { BigNumber } from "@ethersproject/bignumber";
import BalanceTree from "./balanceTree";
import { ZERO } from "../constants";
import { DistributionFormat, MerkleDistributorInfo } from "../types";


export function parseBalanceMap(balances: DistributionFormat[]): MerkleDistributorInfo {
  const dataByAddress = balances.reduce<{
    [address: string]: { amount: BigNumber; }
  }>((memo, { address, earnings }) => {
    if (memo[address]) throw new Error(`Duplicate address: ${address}`);
    if (earnings.lte(0)) throw new Error(`Invalid amount for account: ${address}`);

    memo[address] = {amount: earnings};
    return memo;
  }, {});

  const sortedAddresses = Object.keys(dataByAddress).sort();

  // construct a tree
  const tree = new BalanceTree(
    sortedAddresses.map(address => ({ account: address, amount: dataByAddress[address].amount }))
  );

  // generate claims
  const claims = sortedAddresses.reduce<{
    [address: string]: { amount: string; index: number; proof: string[]; }
  }>((memo, address, index) => {
    const { amount } = dataByAddress[address];
    memo[address] = {
      index,
      amount: amount.toHexString(),
      proof: tree.getProof(index, address, amount),
    };
    return memo;
  }, {});

  const tokenTotal: BigNumber = sortedAddresses.reduce<BigNumber>(
    (memo, key) => memo.add(dataByAddress[key].amount),
    ZERO
  );

  return {
    merkleRoot: tree.getHexRoot(),
    tokenTotal: tokenTotal.toHexString(),
    claims,
  };
}