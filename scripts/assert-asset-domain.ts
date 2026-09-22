// scripts/assert-asset-domain.ts — §6.7's on-chain domain check, runnable from
// the gate and CI: one eth_call each for name() and version() on the asset,
// compared to X402_ASSETS[X402_NETWORK]. Exit 0 on match, 1 on drift. USDC is
// upgradeable and `name` is mutable storage, so this runs weekly on
// musebook-worker too (apps/worker/src/cron/asset-domain.ts).
// Env: X402_NETWORK (default eip155:8453), X402_RPC_URL (default mainnet.base.org),
//      X402_ASSET_ADDRESS (optional override).
import { X402_ASSETS } from "../packages/x402/src/assets.js";

const NAME_SIG = "0x06fdde03"; // name()
const VERSION_SIG = "0x54fd4d50"; // version()

function abiString(hexdata: string): string {
  const bytes = new Uint8Array(
    (hexdata.startsWith("0x") ? hexdata.slice(2) : hexdata)
      .match(/../g)!
      .map((b) => parseInt(b, 16)),
  );
  const view = new DataView(bytes.buffer);
  const offset = Number(view.getUint32(28));
  const len = Number(view.getUint32(offset + 28));
  return new TextDecoder().decode(bytes.subarray(offset + 32, offset + 32 + len));
}

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const j = (await res.json()) as { result?: string; error?: { message: string } };
  if (j.result === undefined) throw new Error(j.error?.message ?? "eth_call failed");
  return j.result;
}

const network = process.env.X402_NETWORK ?? "eip155:8453";
const rpc =
  process.env.X402_RPC_URL ??
  (network === "eip155:84532" ? "https://sepolia.base.org" : "https://mainnet.base.org");
const cfg = X402_ASSETS[network];
const asset = process.env.X402_ASSET_ADDRESS ?? cfg?.asset;

if (cfg === undefined || asset === undefined) {
  console.error(`assert-asset-domain: no X402_ASSETS entry for ${network}`);
  process.exit(1);
}

const [name, version] = await Promise.all([
  ethCall(rpc, asset, NAME_SIG).then(abiString),
  ethCall(rpc, asset, VERSION_SIG).then(abiString),
]);

if (name !== cfg.name || version !== cfg.version) {
  console.error(
    `assert-asset-domain: DRIFT on ${network} — chain says name=${name} version=${version}, ` +
      `config says name=${cfg.name} version=${cfg.version} (asset ${asset})`,
  );
  process.exit(1);
}
console.log(`assert-asset-domain: ${network} asset ${asset} — name=${name} version=${version} OK`);
