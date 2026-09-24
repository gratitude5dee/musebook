// packages/artifacts/src/node/sandbox.ts — imported by apps/web ONLY (11.1).
import { Sandbox } from "@vercel/sandbox";

export interface IngestReportFile {
  readonly path: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly bytes: string; // base64 — returned, never written on Vercel
}

export interface IngestReport {
  readonly ok: boolean;
  readonly rejection?: {
    readonly code: string;
    readonly path?: string;
    readonly measured?: number;
    readonly limit?: number;
  };
  readonly version?: string;
  readonly manifest?: unknown;
  readonly files?: readonly IngestReportFile[];
  readonly entryPath?: string;
  readonly poster?: IngestReportFile;
  readonly totalBytes?: number;
  readonly fileCount?: number;
  readonly gzipBytes?: number;
  readonly triangleCount?: number;
  readonly textureBytes?: number;
  readonly drawCallEstimate?: number;
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

// Written into the sandbox at /work/ingest.mjs — the unpacker + rules of
// 11.13/11.15 as a self-contained Node script (no imports beyond node:*).
const INGEST_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const bundlePath = process.argv[2];
const work = '/work/unpacked';
mkdirSync(work, { recursive: true });
execFileSync('tar', ['-xzf', bundlePath, '-C', work, '--no-same-owner', '--no-same-permissions']);

const files = [];
(function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    const r = rel ? rel + '/' + name : name;
    if (st.isDirectory()) walk(abs, r);
    else if (st.isSymbolicLink()) { console.log(JSON.stringify({ ok: false, rejection: { code: 'path_traversal', path: r } })); process.exit(0); }
    else files.push({ abs, rel: r, size: st.size });
  }
})(work, '');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifestBytes = files.find((f) => f.rel === 'artifact.json');
const manifest = manifestBytes ? JSON.parse(readFileSync(manifestBytes.abs, 'utf8')) : null;
if (!manifest) { console.log(JSON.stringify({ ok: false, rejection: { code: 'manifest_invalid', path: 'artifact.json' } })); process.exit(0); }

const lines = files.map((f) => f.rel + '\\0' + sha(readFileSync(f.abs))).sort();
const version = createHash('sha256').update(lines.join('\\n'), 'utf8').digest('hex').slice(0, 16);
const out = {
  ok: true,
  version,
  manifest,
  files: files.map((f) => ({
    path: f.rel,
    sha256: sha(readFileSync(f.abs)),
    bytes: readFileSync(f.abs).toString('base64'),
  })),
  totalBytes: files.reduce((s, f) => s + f.size, 0),
  fileCount: files.length,
};
console.log(JSON.stringify(out));
`;

export async function runIngest(
  tarballBytes: Uint8Array,
  artifactId: string,
): Promise<IngestReport> {
  await using sandbox = await Sandbox.create({
    // `runtime` is deprecated in @vercel/sandbox@3.x; use a VCR image.
    image: process.env.MEDIA_SANDBOX_IMAGE ?? "vercel/sandbox/node:24",
    timeout: 120_000,
    resources: { vcpus: 2 },
    // camelCase in the TypeScript SDK; the snake_case spelling is the Python SDK's.
    networkPolicy: "deny-all",
    env: { ARTIFACT_ID: artifactId },
  });

  await sandbox.writeFiles([
    { path: "/work/ingest.mjs", content: INGEST_SCRIPT },
    { path: "/work/bundle.tar.gz", content: Buffer.from(tarballBytes) }, // WRITTEN IN, not downloaded
  ]);
  const result = await sandbox.runCommand({
    cmd: "node",
    args: ["/work/ingest.mjs", "/work/bundle.tar.gz"],
    cwd: "/work",
  });
  if (result.exitCode !== 0) throw new IngestError(await result.stderr());
  return JSON.parse(await result.stdout()) as IngestReport;
}
