pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

interface IICManagerV2 {
    function methodologist() external returns(address);

    function operator() external returns(address);

    function interactModule(address _module, bytes calldata _encoded) external;
}