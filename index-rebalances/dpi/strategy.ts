import { BigNumber } from "ethers/utils";
import { ZERO, PRECISE_UNIT } from "../constants";
import { ether } from "../common/index";
import { subtask } from 'hardhat/config';

interface RebalanceSummary {
  asset: string;
  currentUnit: string;
  newUnit: string;
  notionalInToken: string;
  notionalInUSD: string;
  tradeNumber: string;
}
const assets: string[] = [
  "YFI",
  "COMP",
  "SNX",
  "MKR",
  "REN",
  "KNC",
  "LRC",
  "BAL",
  "UNI",
  "AAVE",
];
const currentUnits: BigNumber[] = [
  new BigNumber("625739206582708"),           // YFI
  new BigNumber("82220212811401200"),         // COMP
  new BigNumber("2756798009882341004"),       // SNX
  new BigNumber("18969951502708532"),         // MKR
  new BigNumber("18379066345376004185"),      // REN
  new BigNumber("4176906777539867095"),       // KNC
  new BigNumber("24789779910000347075"),      // LRC
  new BigNumber("198530155290116056"),        // BAL
  new BigNumber("4485672407670928589"),       // UNI
  new BigNumber("242866392548201142"),        // AAVE
];
// const currentUnits: BigNumber[] = [ //Staging-Main
//   new BigNumber("641684124485039"),           // YFI
//   new BigNumber("72672163542279601"),         // COMP
//   new BigNumber("2757986405007167102"),       // SNX
//   new BigNumber("18144284650554855"),         // MKR
//   new BigNumber("20677402343481822333"),      // REN
//   new BigNumber("4209391318194803250"),       // KNC
//   new BigNumber("29430697800780875274"),      // LRC
//   new BigNumber("180846624150106454"),        // BAL
//   new BigNumber("4560907171377642828"),       // UNI
//   new BigNumber("218901216535132575"),        // AAVE
// ];
const currentPrices: BigNumber[] = [
  ether(22836.09),                    // YFI
  ether(145.68),                       // COMP
  ether(10.70),                        // SNX
  ether(674.88),                      // MKR
  ether(0.326626),                    // REN
  ether(0.816926),                    // KNC
  ether(0.372802),                    // LRC
  ether(15.38),                        // BAL
  ether(5.25),                        // UNI
  ether(108.04),                       // AAVE
];
const totalSupply: BigNumber = new BigNumber("218771324774868216006487");
const circSupply: BigNumber[] = [
  new BigNumber(30000),               // YFI
  new BigNumber(4110727),             // COMP
  new BigNumber(136491885),           // SNX
  new BigNumber(903864),              // MKR
  new BigNumber(881153018),           // REN
  new BigNumber(200420603),           // KNC
  new BigNumber(1246631890),          // LRC
  new BigNumber(10641968),             // BAL
  new BigNumber(215057920),           // UNI
  new BigNumber(12020562),            // AAVE
];

const maxTradeSize: BigNumber[] = [
  ether(5.3),                    // YFI
  ether(114),                    // COMP
  ether(7400),                   // SNX
  ether(71),                     // MKR
  ether(72000),                  // REN
  ether(5000),                   // KNC
  ether(340000),                 // LRC
  ether(7700),                   // BAL
  ether(44000),                  // UNI
  ether(671),                    // AAVE
];
// const maxTradeSize: BigNumber[] = [  // Staging-Main
//   new BigNumber("400000000000000"),                       // YFI
//   new BigNumber("100000000000000000"),                     // COMP
//   new BigNumber("1000000000000000000"),                   // SNX
//   new BigNumber("20000000000000000"),                     // MKR
//   new BigNumber("40000000000000000000"),                  // REN
//   new BigNumber("2000000000000000000"),                   // KNC
//   new BigNumber("40000000000000000000"),                  // LRC
//   new BigNumber("300000000000000000"),                    // BAL
//   new BigNumber("10000000000000000000"),                  // UNI
//   new BigNumber("450000000000000000"),                    // AAVE
// ];

const hre = require("hardhat");
const ethers = hre.ethers;

subtask("calculate-new-position:dpi", "Calculates new rebalance details for an index")
  .addParam("index", "Set to update position")
  .setAction(async ({index}, hre) => {
    console.log(index);
  });

export function calculateNewUnitsAndNotional(): any {
  const currentComponents = [];
  const currentUnits = [];
  const currentPrices = [];
  const dpiValue = calculateDpiValue();

  const divisor = circSupply.map((supply, index) => {
    return supply.mul(currentPrices[index]);
  }).reduce((a, b) => a.add(b), new BigNumber(0)).div(dpiValue);

  const rebalanceData: RebalanceSummary[] = [];
  for (let i = 0; i < assets.length; i++) {
    const newUnit = circSupply[i].mul(PRECISE_UNIT).div(divisor);
    const notionalInToken = newUnit.sub(currentUnits[i]).mul(totalSupply).div(PRECISE_UNIT);
    const tokenSummary = {
      asset: assets[i],
      currentUnit: currentUnits[i].toString(),
      newUnit: newUnit.toString(),
      notionalInToken: notionalInToken.toString(),
      notionalInUSD: notionalInToken.mul(currentPrices[i]).div(PRECISE_UNIT).div(PRECISE_UNIT).toString(),
      tradeNumber: notionalInToken.div(maxTradeSize[i]).abs().add(1).toString(),
    } as RebalanceSummary;
    rebalanceData.push(tokenSummary);
  }
  console.log(rebalanceData, dpiValue.toString());
  return rebalanceData;
}

function calculateDpiValue(): BigNumber {
  let dpiValue: BigNumber = ZERO;

  for (let i = 0; i < currentUnits.length; i++) {
    dpiValue = dpiValue.add(currentPrices[i].mul(currentUnits[i]).div(PRECISE_UNIT));
  }

  return dpiValue;
}