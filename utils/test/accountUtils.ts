import { ethers, network } from "hardhat";
import { BigNumber } from "ethers";
import { Account, Address, ForkedTokens } from "../types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import dependencies from "../deploys/dependencies";
import { IERC20__factory } from "../../typechain";
import { ether } from "../common";

const provider = ethers.provider;

interface EthersBigNumberLike {
  toHexString(): string;
}

interface BNLike {
  toNumber(): number;
  toString(base?: number): string;
}

export type NumberLike =
  | number
  | bigint
  | string
  | EthersBigNumberLike
  | BNLike;

export const getAccounts = async (): Promise<Account[]> => {
  const accounts: Account[] = [];

  const wallets = await getWallets();
  for (let i = 0; i < wallets.length; i++) {
    accounts.push({
      wallet: wallets[i],
      address: await wallets[i].getAddress(),
    });
  }

  return accounts;
};

// Use the last wallet to ensure it has Ether
export const getRandomAccount = async (): Promise<Account> => {
  const accounts = await getAccounts();
  return accounts[accounts.length - 1];
};

export const getRandomAddress = async (): Promise<Address> => {
  const wallet = ethers.Wallet.createRandom().connect(provider);
  return await wallet.getAddress();
};

export const getEthBalance = async (account: Address): Promise<BigNumber> => {
  return await provider.getBalance(account);
};

// NOTE ethers.signers may be a buidler specific function
export const getWallets = async (): Promise<SignerWithAddress[]> => {
  return (await ethers.getSigners()) as SignerWithAddress[];
};

const getForkedDependencyAddresses = (): any => {
  return {
    whales: [
      dependencies.DAI_WHALE,
      dependencies.WETH_WHALE,
      dependencies.WBTC_WHALE,
      dependencies.USDC_WHALE,
      dependencies.STETH_WHALE,
    ],

    tokens: [
      dependencies.DAI[1],
      dependencies.WETH[1],
      dependencies.WBTC[1],
      dependencies.USDC[1],
      dependencies.STETH[1],
    ],
  };
};

// Mainnet token instances connected their impersonated
// top holders to enable approval / transfer etc.
export const getForkedTokens = (): ForkedTokens => {

  const enum ids { DAI, WETH, WBTC, USDC, STETH }
  const { whales, tokens } = getForkedDependencyAddresses();

  const forkedTokens = {
    dai: IERC20__factory.connect(tokens[ids.DAI], provider.getSigner(whales[ids.DAI])),
    weth: IERC20__factory.connect(tokens[ids.WETH], provider.getSigner(whales[ids.WETH])),
    wbtc: IERC20__factory.connect(tokens[ids.WBTC], provider.getSigner(whales[ids.WBTC])),
    usdc: IERC20__factory.connect(tokens[ids.USDC], provider.getSigner(whales[ids.USDC])),
    steth: IERC20__factory.connect(tokens[ids.STETH], provider.getSigner(whales[ids.STETH])),
  };

  return forkedTokens;
};

<<<<<<< HEAD
function toRpcQuantity(x: NumberLike): string {
  let hex: string;
  if (typeof x === "number" || typeof x === "bigint") {
    // TODO: check that number is safe
    hex = `0x${x.toString(16)}`;
  } else if (typeof x === "string") {
    if (!x.startsWith("0x")) {
      throw new Error(
        "Only 0x-prefixed hex-encoded strings are accepted"
      );
    }
    hex = x;
  } else if ("toHexString" in x) {
    hex = x.toHexString();
  } else if ("toString" in x) {
    hex = x.toString(16);
  } else {
    throw new Error(
      `${x as any} cannot be converted to an RPC quantity`
    );
  }

  if (hex === "0x0") return hex;

  return hex.startsWith("0x") ? hex.replace(/0x0+/, "0x") : `0x${hex}`;
}

/**
 * Sets the balance for the given address.
 *
 * @param address The address whose balance will be edited.
 * @param balance The new balance to set for the given address, in wei.
 */
export async function setEthBalance(
  address: string,
  balance: NumberLike
): Promise<void> {
  const provider = network.provider;
  const balanceHex = toRpcQuantity(balance);
  await provider.request({
    method: "hardhat_setBalance",
    params: [address, balanceHex],
  });
}

export const initializeForkedTokens = async () => {
  const { whales } = getForkedDependencyAddresses();

  for (const whale of whales) {
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [whale],
    });

    const gasBudget = ether(100);
    await setEthBalance(whale, gasBudget);
  }
};
