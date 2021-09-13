import { BigNumber } from "@ethersproject/bignumber";
import { AaveV2AToken } from "@typechain/AaveV2AToken";
import { CEther } from "@typechain/CEther";
import { SetToken } from "@typechain/SetToken";
import { ether, preciseMul, preciseDiv } from "../common";

export function calculateNewLeverageRatio(
  currentLeverageRatio: BigNumber,
  targetLeverageRatio: BigNumber,
  minLeverageRatio: BigNumber,
  maxLeverageRatio: BigNumber,
  recenteringSpeed: BigNumber
): BigNumber {
  const a = preciseMul(targetLeverageRatio, recenteringSpeed);
  const b = preciseMul(ether(1).sub(recenteringSpeed), currentLeverageRatio);
  const c = a.add(b);
  const d = c.lt(maxLeverageRatio) ? c : maxLeverageRatio;
  return minLeverageRatio.gte(d) ? minLeverageRatio : d;
}

export function calculateCollateralRebalanceUnits(
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber,
  collateralBalance: BigNumber,
  totalSupply: BigNumber
): BigNumber {
  const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  const c = preciseMul(b, collateralBalance);

  return preciseDiv(c, totalSupply);
}

export async function calculateTotalRebalanceNotionalCompound(
  setToken: SetToken,
  cEther: CEther,
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber
): Promise<BigNumber> {

  const collateralCTokenExchangeRate = await cEther.exchangeRateStored();
  const collateralCTokenBalance = await cEther.balanceOf(setToken.address);
  const collateralBalance = preciseMul(collateralCTokenBalance, collateralCTokenExchangeRate);
  const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  return preciseMul(b, collateralBalance);
}

export async function calculateTotalRebalanceNotionalAave(
  setToken: SetToken,
  aToken: AaveV2AToken,
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber
): Promise<BigNumber> {

  const collateralBalance = await aToken.balanceOf(setToken.address);
  const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  return preciseMul(b, collateralBalance);
}

export function calculateMaxBorrowForDelever(
  collateralBalance: BigNumber,
  collateralFactor: BigNumber,
  unutilizedLeveragePercentage: BigNumber,
  collateralPrice: BigNumber,
  borrowPrice: BigNumber,
  borrowBalance: BigNumber,
): BigNumber {
  const collateralValue = preciseMul(collateralBalance, collateralPrice);
  const borrowValue = preciseMul(borrowBalance, borrowPrice);
  const netBorrowLimit = preciseMul(
    preciseMul(collateralValue, collateralFactor),
    ether(1).sub(unutilizedLeveragePercentage)
  );
  const a = preciseMul(collateralBalance, netBorrowLimit.sub(borrowValue));

  return preciseDiv(a, netBorrowLimit);
}

export function calculateMaxRedeemForDeleverToZero(
  currentLeverageRatio: BigNumber,
  newLeverageRatio: BigNumber,
  collateralBalance: BigNumber,
  totalSupply: BigNumber,
  slippageTolerance: BigNumber
): BigNumber {
  const a = currentLeverageRatio.gt(newLeverageRatio) ? currentLeverageRatio.sub(newLeverageRatio) : newLeverageRatio.sub(currentLeverageRatio);
  const b = preciseDiv(a, currentLeverageRatio);
  const rebalanceNotional = preciseMul(b, collateralBalance);
  const notionalRedeemQuantity = preciseMul(rebalanceNotional, ether(1).add(slippageTolerance));

  return preciseDiv(notionalRedeemQuantity, totalSupply);
}