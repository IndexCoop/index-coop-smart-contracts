import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function({ getNamedAccounts, deployments }) {
  const { deployer } = await getNamedAccounts();
  const { deploy } = deployments;
  // Mainnet addresses
  const wethAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const controllerAddress = "0xa4c8d221d8bb851f83aadd0223a8900a6921a349";
  const issuanceModuleAddress = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D";
  const zeroExProxyAddress = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF";

  const exchangeIssuanceZeroEx = await deploy("ExchangeIssuanceZeroEx", {
    from: deployer,
    args: [wethAddress, controllerAddress, issuanceModuleAddress, zeroExProxyAddress],
    log: true,
  });
  await exchangeIssuanceZeroEx.approveSetToken("");
};
export default func;
