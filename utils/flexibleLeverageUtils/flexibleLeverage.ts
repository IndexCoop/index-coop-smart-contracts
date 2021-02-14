import { BigNumber } from "@ethersproject/bignumber";
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

export function calculateMaxBorrowForDelever(
  collateralBalance: BigNumber,
  collateralFactor: BigNumber,
  unutilizedLeveragePercentage: BigNumber,
  collateralPrice: BigNumber,
  collateralBaseUnits: BigNumber,
): BigNumber {
  const collateralValue = preciseDiv(preciseMul(collateralBalance, collateralPrice), collateralBaseUnits);
  const a = preciseMul(
    preciseMul(collateralValue, collateralFactor),
    ether(1).sub(unutilizedLeveragePercentage)
  );
  const b = preciseDiv(a, collateralPrice);

  return preciseMul(b, collateralBaseUnits);
}