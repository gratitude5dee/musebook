// packages/media/test/provenance.test.ts — NODE ONLY (sharp + c2pa-node +
// openssl live in the Vercel function, §11.9.6). The gate's M19.7 provenance
// round-trip: sign → c2patool-equivalent read → manifest present, phash
// non-null. The unsigned path (signing disabled) must still succeed with a
// null sidecar — provenance is additive, never a finalize-blocker.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { perceptualHash, readProvenance, signAsset } from "../src/node/index.js";

const INPUT = {
  bytes: Buffer.alloc(0),
  mimeType: "image/png",
  title: "M19 provenance test",
  modelId: "fal-ai/test",
  backend: "fal",
  promptSha256: "ab".repeat(32),
  authorKind: "agent",
  authorWallet: "0x0000000000000000000000000000000000000001",
  authorDisplayName: "tester",
  connectorSlug: null,
  delegationId: "11111111-1111-4111-8111-000000000003",
  postUrl: null,
};

describe("M19: provenance round-trip", () => {
  let certPem: string;
  let keyPem: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "m19-cert-"));
    // A root CA + a leaf signed by it — the c2pa SDK rejects a SELF-SIGNED
    // end-entity but accepts a leaf that chains to a (self-signed) root CA.
    // §11.9.6's dev fallback; prod carries a real CA-issued cert.
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", join(dir, "ca-key.pem"), "-out", join(dir, "ca-cert.pem"),
      "-nodes", "-subj", "/CN=Musebook Test Root CA", "-days", "1",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    execFileSync("openssl", [
      "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-keyout", join(dir, "leaf-key.pem"), "-out", join(dir, "leaf.csr"),
      "-nodes", "-subj", "/CN=Musebook Test Signer",
    ]);
    writeFileSync(
      join(dir, "leaf-ext.cnf"),
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=emailProtection\n",
    );
    execFileSync("openssl", [
      "x509", "-req", "-in", join(dir, "leaf.csr"),
      "-CA", join(dir, "ca-cert.pem"), "-CAkey", join(dir, "ca-key.pem"),
      "-CAcreateserial", "-days", "1", "-extfile", join(dir, "leaf-ext.cnf"),
      "-out", join(dir, "leaf-cert.pem"),
    ]);
    // Signing cert = leaf + CA bundle so the chain resolves.
    certPem =
      execFileSync("cat", [join(dir, "leaf-cert.pem")], { encoding: "utf8" }) +
      execFileSync("cat", [join(dir, "ca-cert.pem")], { encoding: "utf8" });
    keyPem = execFileSync("cat", [join(dir, "leaf-key.pem")], { encoding: "utf8" });
    INPUT.bytes = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 120, b: 200 } },
    }).png().toBuffer();
  });

  it("signs (real manifest) and reads it back; phash is a 64-bit hexable string", async () => {
    process.env.C2PA_SIGNING_CERT_PEM = certPem;
    process.env.C2PA_SIGNING_KEY_PEM = keyPem;
    delete process.env.C2PA_TSA_URL;
    const out = await signAsset(INPUT);
    expect(out.signed).toBeTypeOf("object");
    expect(out.signed!.byteLength).toBeGreaterThan(INPUT.bytes.byteLength);
    expect(out.sidecar).toBeTypeOf("object");

    // The round-trip read sees the manifest — the same check `c2patool
    // --info` performs on the object body.
    const manifest = await readProvenance(out.signed!, "image/png");
    expect(manifest).not.toBeNull();

    const phash = await perceptualHash(out.signed!);
    expect(phash).not.toBeNull();
    expect(phash).toMatch(/^[01]{64}$/);
  });

  it("unsigned read on raw bytes returns no manifest", async () => {
    // The finalize path stores the raw bytes when signing is off; reading
    // provenance from them yields no manifest and never throws.
    expect(await readProvenance(INPUT.bytes, "image/png")).toBeNull();
  });
});
