import { BigNumber } from "ethers";
import { ether } from "@utils/index";
import { MAX_UINT_256 } from "@utils/constants";
import { SetToken } from "@utils/contracts/setV2";
import { StandardTokenMock, UniswapV2Router02, WETH9 } from "@utils/contracts/index";

export const getAllowances = async (tokens: StandardTokenMock[], owner: string, spenders: string[]) => {
    const allowances: BigNumber[] = [];
    tokens.forEach(async token => {
        allowances.push(...await Promise.all(spenders.map(async address => await token.allowance(owner, address))));
    });
    return allowances;
};

export const getIssueSetForExactETH = async (setToken: SetToken, ethInput: BigNumber, uniswapRouter: UniswapV2Router02, weth: string) => {
    let sumEth = BigNumber.from(0);
    const amountEthForComponents = [];
    const components = await setToken.getComponents();
    for (let i = 0; i < components.length; i++) {
        const component = components[i];
        const unit = await setToken.getDefaultPositionRealUnit(component);
        let amountEthForComponent = ether(0);
        if (component === weth) {
            sumEth = sumEth.add(unit);
            amountEthForComponent = unit;
        } else {
            sumEth = sumEth.add((await uniswapRouter.getAmountsIn(unit, [weth, component]))[0]);
            amountEthForComponent = (await uniswapRouter.getAmountsIn(unit, [weth, component]))[0];
        }
        amountEthForComponents.push(amountEthForComponent);
    }

    let expectedOutput: BigNumber = MAX_UINT_256;
    for (let i = 0; i < components.length; i++) {
        const component = components[i];
        const unit = await setToken.getDefaultPositionRealUnit(component);
        const scaledEth = amountEthForComponents[i].mul(ethInput).div(sumEth);

        const amountComponentOut = component === weth
            ? scaledEth
            : (await uniswapRouter.getAmountsOut(scaledEth, [weth, component]))[1];

        const potentialSetTokenOut = amountComponentOut.mul(ether(1)).div(unit);
        if (potentialSetTokenOut.lt(expectedOutput)) {
            expectedOutput = potentialSetTokenOut;
        }
    }
    return expectedOutput;
};

export const getIssueSetForExactToken = async (setToken: SetToken, inputToken: string, inputAmount: BigNumber,
    uniswapRouter: UniswapV2Router02, weth: string) => {

    // get eth amount that can be aquired with inputToken
    const ethInput = inputToken !== weth ? (await uniswapRouter.getAmountsOut(inputAmount, [inputToken, weth]))[1] : inputAmount;
    return await getIssueSetForExactETH(setToken, ethInput, uniswapRouter, weth);
};

export const getIssueExactSetFromETH = async (setToken: SetToken, amountSet: BigNumber, uniswapRouter: UniswapV2Router02, weth: string) => {
    const components = await setToken.getComponents();
    let sumEth = BigNumber.from(0);
    for (let i = 0; i < components.length; i++) {
        const componentAmount = amountSet.mul(await setToken.getDefaultPositionRealUnit(components[i])).div(ether(1));
        const ethAmount = components[i] === weth
            ? componentAmount
            : (await uniswapRouter.getAmountsIn(componentAmount, [weth, components[i]]))[0];
        sumEth = sumEth.add(ethAmount);
    }
    return sumEth;
};

export const getIssueExactSetFromToken = async (setToken: SetToken, inputToken: StandardTokenMock | WETH9,
    amountSet: BigNumber, uniswapRouter: UniswapV2Router02, weth: string) => {

    const ethCost = await getIssueExactSetFromETH(setToken, amountSet, uniswapRouter, weth);
    if (inputToken.address === weth) return ethCost;

    const tokenCost = (await uniswapRouter.getAmountsIn(ethCost, [inputToken.address, weth]))[0];
    return tokenCost;
};

export const getIssueExactSetFromTokenRefund = async (setToken: SetToken, inputToken: StandardTokenMock, inputAmount: BigNumber,
    amountSet: BigNumber, uniswapRouter: UniswapV2Router02, weth: string) => {

    const ethCost = await getIssueExactSetFromETH(setToken, amountSet, uniswapRouter, weth);
    const inputEthValue = (await uniswapRouter.getAmountsOut(inputAmount, [inputToken.address, weth]))[1];
    const refundAmount = inputEthValue.sub(ethCost);

    return refundAmount;
};

export const getRedeemExactSetForETH = async (setToken: SetToken, amountSet: BigNumber, uniswapRouter: UniswapV2Router02, weth: string) => {
    const components = await setToken.getComponents();
    let sumEth = BigNumber.from(0);
    for (let i = 0; i < components.length; i++) {
        const componentAmount = amountSet.mul(await setToken.getDefaultPositionRealUnit(components[i])).div(ether(1));
        const ethAmount = components[i] === weth
            ? componentAmount
            : (await uniswapRouter.getAmountsOut(componentAmount, [components[i], weth]))[1];
        sumEth = sumEth.add(ethAmount);
    }
    return sumEth;
};

export const getRedeemExactSetForToken = async (setToken: SetToken, outputToken: StandardTokenMock | WETH9,
    amountSet: BigNumber, uniswapRouter: UniswapV2Router02, weth: string) => {

    const ethOut = await getRedeemExactSetForETH(setToken, amountSet, uniswapRouter, weth);
    if (outputToken.address === weth) return ethOut;

    const tokenOut = (await uniswapRouter.getAmountsOut(ethOut, [weth, outputToken.address]))[1];
    return tokenOut;
};