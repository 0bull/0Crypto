// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// EIP-1167 clone target. Holds no storage: `sink` and `factory` are immutables in this implementation's code,
/// which every clone reads through delegatecall. Only the factory may flush; funds only ever go to `sink`.
contract Forwarder {
    using SafeERC20 for IERC20;

    event Flushed(address indexed forwarder, address indexed token, uint256 amount);

    address public immutable sink;
    address public immutable factory;

    constructor(address sink_) {
        require(sink_ != address(0), "zero sink");
        sink = sink_;
        factory = msg.sender;
    }

    receive() external payable {}

    function flush(address[] calldata tokens) external {
        require(msg.sender == factory, "only factory");
        address to = sink;
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            require(ok, "native send failed");
            emit Flushed(address(this), address(0), bal);
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20 t = IERC20(tokens[i]);
            uint256 b = t.balanceOf(address(this));
            if (b > 0) {
                t.safeTransfer(to, b);
                emit Flushed(address(this), tokens[i], b);
            }
        }
    }
}
