import { BigNumber } from "ethers/lib/ethers";
import base58 from "bs58";

export const bigNumberToData = (number: BigNumber) => number.toHexString().replace("0x", "").padStart(64, "0");

export const bufferToHex = (buffer: Uint8Array) => {
  let hexStr = "";

  for (let i = 0; i < buffer.length; i++) {
    const hex = (buffer[i] & 0xff).toString(16);
    hexStr += hex.length === 1 ? "0" + hex : hex;
  }

  return hexStr;
};

// Base58 decoding function (make sure you have a proper Base58 decoding function)
export const base58ToHexString = (base58String: string)  => {
  const bytes = base58.decode(base58String); // Decode base58 to a buffer
  const hexString = bufferToHex(bytes.slice(2)); // Convert buffer to hex, excluding the first 2 bytes
  return "0x" + hexString;
};
