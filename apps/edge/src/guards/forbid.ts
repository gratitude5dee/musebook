// Half one of the §3.4 bundle guard. wrangler.jsonc's `alias` maps `viem` and
// `viem/node` here, so any import of them — direct OR transitive — evaluates
// this module and throws at bundle time. viem means fs-backed batch
// settlement and EIP-712 recovery in the edge bundle; settlement is delegated
// to the facilitator (CF-SPINE §6). The second half greps the built output:
// scripts/check-edge-bundle.mjs.
throw new Error(
  "viem is forbidden in musebook-edge (CF-SPINE §6). " +
    "Settlement is delegated to the facilitator — import '@x402/evm/exact/server', never the root barrel.",
);
