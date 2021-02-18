pragma solidity 0.6.10;


/**
 * @title ICompoundPriceOracle
 *
 * Interface for interacting with Compound price oracle
 */
interface ICompoundPriceOracle {

    function getUnderlyingPrice(address _asset) external view returns(uint256);
}