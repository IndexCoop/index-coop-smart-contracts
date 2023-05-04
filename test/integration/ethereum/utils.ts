import { ethers, network } from "hardhat";
import { BigNumber } from "ethers";
import { INotionalProxy, IWrappedfCashComplete, IWrappedfCashFactory } from "@typechain/index";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { IERC20 } from "@typechain/IERC20";
import { ICErc20 } from "@typechain/ICErc20";

const NOTIONAL_PROXY_ADDRESS = "0x1344A36A1B56144C3Bc62E7757377D288fDE0369";

const cEthAddress = "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5";

export async function impersonateAccount(address: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return ethers.provider.getSigner(address);
}


export async function getCurrencyIdAndMaturity(underlyingAddress: string, maturityIndex: number) {
  const notionalProxy = (await ethers.getContractAt(
    "INotionalProxy",
    NOTIONAL_PROXY_ADDRESS,
  )) as INotionalProxy;
  const currencyId = await notionalProxy.getCurrencyId(underlyingAddress);
  const activeMarkets = await notionalProxy.getActiveMarkets(currencyId);
  const maturity = activeMarkets[maturityIndex].maturity;
  return { currencyId, maturity };
}

export async function deployWrappedfCashInstance(
  wrappedfCashFactory: IWrappedfCashFactory,
  currencyId: number,
  maturity: BigNumber,
) {
  const wrappeFCashAddress = await wrappedfCashFactory.callStatic.deployWrapper(
    currencyId,
    maturity,
  );
  await wrappedfCashFactory.deployWrapper(currencyId, maturity);
  const wrappedFCashInstance = (await ethers.getContractAt(
    "IWrappedfCashComplete",
    wrappeFCashAddress,
  )) as IWrappedfCashComplete;
  return wrappedFCashInstance;
}

export async function mintWrappedFCash(
  signer: SignerWithAddress,
  underlyingToken: IERC20,
  underlyingTokenAmount: BigNumber,
  fCashAmount: BigNumber,
  assetToken: ICErc20,
  wrappedFCashInstance: IWrappedfCashComplete,
  useUnderlying: boolean = false,
  receiver: string | undefined = undefined,
  minImpliedRate: number | BigNumber = 0,
) {
  let inputToken: IERC20;
  let depositAmountExternal: BigNumber;
  receiver = receiver ?? signer.address;

  if (useUnderlying) {
    inputToken = underlyingToken;
    depositAmountExternal = underlyingTokenAmount;
  } else {
    const assetTokenBalanceBefore = await assetToken.balanceOf(signer.address);
    if (assetToken.address != cEthAddress) {
      assetToken = assetToken as ICErc20;
      await underlyingToken.connect(signer).approve(assetToken.address, underlyingTokenAmount);
      await assetToken.connect(signer).mint(underlyingTokenAmount);
    }
    const assetTokenBalanceAfter = await assetToken.balanceOf(signer.address);
    depositAmountExternal = assetTokenBalanceAfter.sub(assetTokenBalanceBefore);
    inputToken = assetToken;
  }

  await inputToken.connect(signer).approve(wrappedFCashInstance.address, depositAmountExternal);
  const inputTokenBalanceBefore = await inputToken.balanceOf(signer.address);
  const wrappedFCashBalanceBefore = await wrappedFCashInstance.balanceOf(signer.address);
  let txReceipt;
  if (useUnderlying) {
    txReceipt = await wrappedFCashInstance
      .connect(signer)
      .mintViaUnderlying(depositAmountExternal, fCashAmount, receiver, minImpliedRate);
  } else {
    txReceipt = await wrappedFCashInstance
      .connect(signer)
      .mintViaAsset(depositAmountExternal, fCashAmount, receiver, minImpliedRate);
  }
  const wrappedFCashBalanceAfter = await wrappedFCashInstance.balanceOf(signer.address);
  const inputTokenBalanceAfter = await inputToken.balanceOf(signer.address);
  const inputTokenSpent = inputTokenBalanceAfter.sub(inputTokenBalanceBefore);
  const wrappedFCashReceived = wrappedFCashBalanceAfter.sub(wrappedFCashBalanceBefore);
  return {
    wrappedFCashReceived,
    depositAmountExternal,
    inputTokenSpent,
    txReceipt,
    inputToken,
  };
}
