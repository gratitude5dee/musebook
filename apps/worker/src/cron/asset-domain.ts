// apps/worker/src/cron/asset-domain.ts — weekly (`0 4 * * 1`) drift check:
// one eth_call each for name() and version() on X402_ASSET_ADDRESS, compared
// to X402_ASSETS[X402_NETWORK]. USDC is upgradeable and `name` is mutable
// storage; a drift raises x402.asset_domain_drift (§6.7).
import { X402_ASSETS } from "@musebook/x402";

const NAME_SIG = "0x06fdde03"; // name()
const VERSION_SIG = "0x54fd4d50"; // version()

function abiString(hexdata: string): string {
  const bytes = new Uint8Array(
    (hexdata.startsWith("0x") ? hexdata.slice(2) : hexdata)
      .match(/../g)!
      .map((b) => parseInt(b, 16)),
  );
  const view = new DataView(bytes.buffer);
  const offset = Number(view.getUint32(28)); // ABI string head: offset then length
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

/** Returns the drift description, or null when the contract still matches. */
export async function checkAssetDomain(env: Env): Promise<string | null> {
  const cfg = X402_ASSETS[env.X402_NETWORK];
  const rpc = env.X402_RPC_URL;
  if (cfg === undefined || rpc === undefined || rpc === "") {
    return `no rpc/asset config for ${env.X402_NETWORK}`;
  }
  const [name, version] = await Promise.all([
    ethCall(rpc, cfg.asset, NAME_SIG).then(abiString),
    ethCall(rpc, cfg.asset, VERSION_SIG).then(abiString),
  ]);
  return name === cfg.name && version === cfg.version
    ? null
    : `asset domain drift on ${env.X402_NETWORK}: chain says ${name}@${version}, config says ${cfg.name}@${cfg.version}`;
}

export async function assertAssetDomainCron(env: Env): Promise<void> {
  const drift = await checkAssetDomain(env);
  if (drift !== null) {
    console.warn(JSON.stringify({ metric: "x402.asset_domain_drift", detail: drift }));
  }
}
