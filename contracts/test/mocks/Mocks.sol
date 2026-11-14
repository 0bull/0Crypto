// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Test-only mocks.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
}

/// USDT-style: transfer returns nothing.
contract MockUSDT {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a; balanceOf[to] += a;
    }
}

interface IForwarderFactory {
    function deployAndFlush(bytes32[] calldata salts, address[] calldata tokens) external;
}

/// A contract sink with no receive/fallback: native sends to it fail.
contract RejectingSink {
    function sweep(address factory, bytes32[] calldata salts, address[] calldata tokens) external {
        IForwarderFactory(factory).deployAndFlush(salts, tokens);
    }
}
