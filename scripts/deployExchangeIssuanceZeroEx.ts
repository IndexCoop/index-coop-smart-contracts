import { ethers } from "hardhat";

async function main() {
  const ExchangeIssuanceZeroEx = await ethers.getContractFactory("ExchangeIssuanceZeroEx");
  // Mainnet addresses
  const wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const controllerAddress = "0xa4c8d221d8bb851f83aadd0223a8900a6921a349";
  const issuanceModuleAddress = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D";
  const zeroExProxyAddress = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

  const dpiAddress = "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b";

  const exchangeIssuanceZeroEx = await ExchangeIssuanceZeroEx.deploy(
    wethAddress,
    controllerAddress,
    issuanceModuleAddress,
    zeroExProxyAddress,
  );
  console.log("Exchange Issuacne deployed to", exchangeIssuanceZeroEx.address);
  await exchangeIssuanceZeroEx.approveSetToken(dpiAddress);
    console.log("Approved dpi token");
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
