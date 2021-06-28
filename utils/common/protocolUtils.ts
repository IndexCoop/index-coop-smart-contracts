import { JsonRpcProvider, Web3Provider } from "@ethersproject/providers";

import { ethers } from "ethers";

export class ProtocolUtils {
  public _provider: Web3Provider | JsonRpcProvider;

  constructor(_provider: Web3Provider | JsonRpcProvider) {
    this._provider = _provider;
  }

  public async getCreatedSetTokenAddress (txnHash: string | undefined): Promise<string> {
    if (!txnHash) {
      throw new Error("Invalid transaction hash");
    }

    const abi = ["event SetTokenCreated(address indexed _setToken, address _manager, string _name, string _symbol)"];
    const iface = new ethers.utils.Interface(abi);

    const topic = ethers.utils.id("SetTokenCreated(address,address,string,string)");
    const logs = await this._provider.getLogs({
      fromBlock: "latest",
      toBlock: "latest",
      topics: [topic],
    });

    const parsed = iface.parseLog(logs[logs.length - 1]);
    return parsed.args._setToken;
  }
}