// ABI fragments the hot wallet calls (no viem import: the signer and the sweeper share them).

/** contracts/src/ForwarderFactory.sol. Only the sink (the hot wallet) may call it; `flush` is factory-only. */
export const FACTORY_ABI = [
  {
    type: "function",
    name: "deployAndFlush",
    stateMutability: "nonpayable",
    inputs: [
      { name: "salts", type: "bytes32[]" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
] as const;

/**
 * RailgunSmartWallet.shield(ShieldRequest[]), selector 0x044a40c3: copied from @railgun-community/engine 9.9.1
 * dist/abi/V2.1/RailgunSmartWallet.json (the ABI of the proxies in RAILGUN_PROXY).
 */
export const RAILGUN_SHIELD_ABI = [
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    inputs: [
      {
        name: "_shieldRequests",
        type: "tuple[]",
        internalType: "struct ShieldRequest[]",
        components: [
          {
            name: "preimage",
            type: "tuple",
            internalType: "struct CommitmentPreimage",
            components: [
              { name: "npk", type: "bytes32", internalType: "bytes32" },
              {
                name: "token",
                type: "tuple",
                internalType: "struct TokenData",
                components: [
                  { name: "tokenType", type: "uint8", internalType: "enum TokenType" },
                  { name: "tokenAddress", type: "address", internalType: "address" },
                  { name: "tokenSubID", type: "uint256", internalType: "uint256" },
                ],
              },
              { name: "value", type: "uint120", internalType: "uint120" },
            ],
          },
          {
            name: "ciphertext",
            type: "tuple",
            internalType: "struct ShieldCiphertext",
            components: [
              { name: "encryptedBundle", type: "bytes32[3]", internalType: "bytes32[3]" },
              { name: "shieldKey", type: "bytes32", internalType: "bytes32" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
] as const;
