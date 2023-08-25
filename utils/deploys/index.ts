import { Signer } from "ethers";

import DeployManager from "./deployManager";
import DeployManagerCore from "./deployManagerCore";
import DeployGlobalExtensions from "./deployGlobalExtensions";
import DeployFactories from "./deployFactories";
import DeployMocks from "./deployMocks";
import DeployToken from "./deployToken";
import DeploySetV2 from "./deploySetV2";
import DeployExtensions from "./deployExtensions";
import DeployExternalContracts from "./deployExternal";
import DeployHooks from "./deployHooks";
import DeployStaking from "./deployStaking";
import DeployViewers from "./deployViewers";
import DeployKeepers from "./deployKeepers";

export default class DeployHelper {
  public token: DeployToken;
  public setV2: DeploySetV2;
  public manager: DeployManager;
  public managerCore: DeployManagerCore;
  public globalExtensions: DeployGlobalExtensions;
  public factories: DeployFactories;
  public mocks: DeployMocks;
  public extensions: DeployExtensions;
  public external: DeployExternalContracts;
  public hooks: DeployHooks;
  public staking: DeployStaking;
  public viewers: DeployViewers;
  public keepers: DeployKeepers;

  constructor(deployerSigner: Signer) {
    this.token = new DeployToken(deployerSigner);
    this.setV2 = new DeploySetV2(deployerSigner);
    this.manager = new DeployManager(deployerSigner);
    this.mocks = new DeployMocks(deployerSigner);
    this.extensions = new DeployExtensions(deployerSigner);
    this.external = new DeployExternalContracts(deployerSigner);
    this.hooks = new DeployHooks(deployerSigner);
    this.staking = new DeployStaking(deployerSigner);
    this.viewers = new DeployViewers(deployerSigner);
    this.keepers = new DeployKeepers(deployerSigner);
    this.managerCore = new DeployManagerCore(deployerSigner);
    this.globalExtensions = new DeployGlobalExtensions(deployerSigner);
    this.factories = new DeployFactories(deployerSigner);
  }
}
