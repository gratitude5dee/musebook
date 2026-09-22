// packages/x402/src/cdp-jwt.ts — the CDP facilitator's request auth, signed in
// WebCrypto so neither @coinbase/cdp-sdk nor viem enters the bundle (§6.7.5).
// Supports both key generations: a 64-byte base64 Ed25519 secret (EdDSA) and a
// PEM EC P-256 secret (ES256). JWT uris claim names `METHOD host/path`, per
// CDP's request signing scheme.

const te = new TextEncoder();

const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const hex = (n: Uint8Array): string =>
  Array.from(n, (b) => b.toString(16).padStart(2, "0")).join("");

async function ed25519Key(secretB64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  // PKCS8-der prefix for Ed25519 + the 32-byte seed half of CDP's 64-byte blob.
  const pkcs8Prefix = Uint8Array.from(atob("MC4CAQAwBQYDK2VwBCIEIA=="), (c) => c.charCodeAt(0));
  const der = new Uint8Array(pkcs8Prefix.length + 32);
  der.set(pkcs8Prefix);
  der.set(raw.subarray(0, 32), pkcs8Prefix.length);
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

async function ecKey(pem: string): Promise<CryptoKey> {
  const body = pem.replaceAll(/-----[A-Z ]+-----/g, "").replaceAll(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

export async function signCdpJwt(
  keyId: string,
  keySecret: string,
  uri: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const isPem = keySecret.includes("BEGIN");
  const alg = isPem ? "ES256" : "EdDSA";
  const header = b64u(
    te.encode(
      JSON.stringify({
        alg,
        kid: keyId,
        nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
        typ: "JWT",
      }),
    ),
  );
  const payload = b64u(
    te.encode(
      JSON.stringify({
        sub: keyId,
        iss: "cdp",
        nbf: nowSeconds,
        exp: nowSeconds + 120,
        uris: [uri],
      }),
    ),
  );
  const data = te.encode(`${header}.${payload}`);
  const sig = isPem
    ? await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await ecKey(keySecret), data)
    : await crypto.subtle.sign({ name: "Ed25519" }, await ed25519Key(keySecret), data);
  return `${header}.${payload}.${b64u(sig)}`;
}

/** FacilitatorConfig.authHeaders factory for the CDP facilitator. */
export function makeCdpAuthHeaders(
  keyId: string,
  keySecret: string,
  host = "api.cdp.coinbase.com",
  basePath = "/platform/v2/x402",
): (path: "verify" | "settle" | "supported") => Promise<Record<string, string>> {
  return async (path) => {
    const method = path === "supported" ? "GET" : "POST";
    const jwt = await signCdpJwt(keyId, keySecret, `${method} ${host}${basePath}/${path}`);
    return { Authorization: `Bearer ${jwt}` };
  };
}
