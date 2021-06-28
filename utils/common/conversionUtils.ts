import { BigNumber } from "ethers/lib/ethers";

export const bigNumberToData = (number: BigNumber) => number.toHexString().replace("0x", "").padStart(64, "0");