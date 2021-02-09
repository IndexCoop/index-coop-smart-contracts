import { Signer } from "ethers";

import DeployManager from "./deployManager";
import DeployMocks from "./deployMocks";
import DeployToken from "./deployToken";
import DeploySetV2 from "./deploySetV2";
import DeployExternalContracts from "./deployExternal";

export default class DeployHelper {
  public token: DeployToken;
  public setV2: DeploySetV2;
  public manager: DeployManager;
  public mocks: DeployMocks;
  public external: DeployExternalContracts;

  constructor(deployerSigner: Signer) {
    this.token = new DeployToken(deployerSigner);
    this.setV2 = new DeploySetV2(deployerSigner);
    this.manager = new DeployManager(deployerSigner);
    this.mocks = new DeployMocks(deployerSigner);
    this.external = new DeployExternalContracts(deployerSigner);
  }
}