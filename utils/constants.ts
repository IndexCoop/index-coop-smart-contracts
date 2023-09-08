import { constants } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

const { AddressZero, MaxUint256, One, Two, Zero } = constants;

export const MODULE_STATE = {
  "NONE": 0,
  "PENDING": 1,
  "INITIALIZED": 2,
};

export const EXTENSION_STATE = {
  "NONE": 0,
  "PENDING": 1,
  "INITIALIZED": 2,
};

export const ADDRESS_ZERO = AddressZero;
export const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const EMPTY_BYTES = "0x";
export const ZERO_BYTES = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const MAX_UINT_256: BigNumber = MaxUint256;
export const MAX_UINT_96: BigNumber = BigNumber.from(2).pow(96).sub(1);
export const ONE: BigNumber = One;
export const TWO: BigNumber = Two;
export const THREE = BigNumber.from(3);
export const FOUR = BigNumber.from(4);
export const ZERO: BigNumber = Zero;
export const MAX_INT_256 = "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
export const MIN_INT_256 = "-0x8000000000000000000000000000000000000000000000000000000000000000";
export const ONE_DAY_IN_SECONDS = BigNumber.from(60 * 60 * 24);
export const ONE_HOUR_IN_SECONDS = BigNumber.from(60 * 60);
export const ONE_MONTH_IN_SECONDS = ONE_DAY_IN_SECONDS.mul(30);
export const ONE_YEAR_IN_SECONDS = BigNumber.from(31557600);

export const PRECISE_UNIT: BigNumber = constants.WeiPerEther;
