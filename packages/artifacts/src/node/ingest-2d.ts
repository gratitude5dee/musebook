// packages/artifacts/src/node/ingest-2d.ts — apps/web ONLY (11.1).
// §11.13's rejection table as pure static analysis. Ingest rejects; it never
// rewrites — every row below is a specific rule + offending path.
import { createHash } from "node:crypto";
import { artifactManifestSchema } from "../manifest";
import { ALLOWED_EXTENSIONS, BUNDLE_CAPS } from "../budgets";
import { computeVersion } from "../version";

export interface IngestFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export type RejectionCode2D =
  | "manifest_invalid"
  | "integrity_mismatch"
  | "entry_missing"
  | "entry_too_large"
  | "poster_missing"
  | "bundle_too_large"
  | "too_many_files"
  | "file_too_large"
  | "extension_not_allowed"
  | "remote_resource"
  | "absolute_path"
  | "dynamic_code"
  | "navigation_escape"
  | "path_traversal"
  | "capability_not_allowed"
  | "path_too_long";

export interface Rejection {
  readonly code: string;
  readonly path?: string;
}

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

const ext = (p: string) => {
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i).toLowerCase();
};

const REMOTE_RE =
  /<script\b[^>]*\bsrc\s*=\s*['"]https?:|<link\b[^>]*rel\s*=\s*['"]?stylesheet['"]?[^>]*\bhref\s*=\s*['"]https?:|import\s*\(\s*['"]https?:/i;
const ABSOLUTE_RE = /(?:src|href)\s*=\s*['"]\//i;
const DYNAMIC_RE = /\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(|setTimeout\s*\(\s*['"]/i;
const NAV_RE = /<form\b|<meta\b[^>]*http-equiv\s*=\s*['"]?refresh|(?:top|parent)\.location\s*=/i;

const CAPS_ALLOWED = new Set(["pointerlock", "fullscreen", "autoplay", "xr"]);

/** §11.13's table in order. Returns the first rejection, or the report. */
export async function analyze2DBundle(
  files: ReadonlyMap<string, Uint8Array>,
  visibility: "public" | "private",
): Promise<{ rejection: Rejection } | { manifest: Record<string, unknown>; version: string }> {
  // No traversal — on the declared paths themselves.
  for (const path of files.keys()) {
    if (path.startsWith("/") || path.includes(".."))
      return { rejection: { code: "path_traversal", path } };
  }

  const manifestBytes = files.get("artifact.json");
  if (manifestBytes === undefined)
    return { rejection: { code: "manifest_invalid", path: "artifact.json" } };
  let manifest: Record<string, unknown>;
  try {
    manifest = artifactManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  } catch {
    return { rejection: { code: "manifest_invalid", path: "artifact.json" } };
  }

  // Integrity complete, both directions.
  const integrity = manifest.integrity as { files: Record<string, string> };
  for (const [path, body] of files) {
    if (integrity.files[path] !== sha256Hex(body))
      return { rejection: { code: "integrity_mismatch", path } };
  }
  for (const declared of Object.keys(integrity.files)) {
    if (!files.has(declared)) return { rejection: { code: "integrity_mismatch", path: declared } };
  }

  if (files.size > BUNDLE_CAPS.maxFileCount) return { rejection: { code: "too_many_files" } };
  let total = 0;
  for (const [path, body] of files) {
    total += body.byteLength;
    const limit = ext(path) === ".wasm" ? BUNDLE_CAPS.maxWasmBytes : BUNDLE_CAPS.maxFileBytes;
    if (body.byteLength > limit) return { rejection: { code: "file_too_large", path } };
    if (!ALLOWED_EXTENSIONS.has(ext(path)))
      return { rejection: { code: "extension_not_allowed", path } };
  }
  if (total > BUNDLE_CAPS.maxBundleBytes) return { rejection: { code: "bundle_too_large" } };

  const entry = manifest.entry as string;
  const entryBytes = files.get(entry);
  if (entryBytes === undefined) return { rejection: { code: "entry_missing", path: entry } };
  if (entryBytes.byteLength > BUNDLE_CAPS.maxEntryBytes)
    return { rejection: { code: "entry_too_large", path: entry } };

  const poster = manifest.poster as string;
  const posterBytes = files.get(poster);
  if (posterBytes === undefined || posterBytes.byteLength > BUNDLE_CAPS.maxPosterBytes) {
    return { rejection: { code: "poster_missing", path: poster } };
  }

  const caps = manifest.capabilitiesRequested as string[];
  for (const c of caps) {
    if (!CAPS_ALLOWED.has(c)) return { rejection: { code: "capability_not_allowed", path: c } };
  }

  // Static smell checks over the text files.
  for (const [path, body] of files) {
    const e = ext(path);
    if (e !== ".html" && e !== ".js" && e !== ".mjs" && e !== ".css") continue;
    const text = new TextDecoder().decode(body);
    if (REMOTE_RE.test(text)) return { rejection: { code: "remote_resource", path } };
    if (ABSOLUTE_RE.test(text)) return { rejection: { code: "absolute_path", path } };
    if (DYNAMIC_RE.test(text)) return { rejection: { code: "dynamic_code", path } };
    if (NAV_RE.test(text)) return { rejection: { code: "navigation_escape", path } };
  }

  const version = await computeVersion(files);
  for (const path of files.keys()) {
    if (`a/${visibility}/${version}/${path}`.length > BUNDLE_CAPS.maxKeyBytes) {
      return { rejection: { code: "path_too_long", path } };
    }
  }

  return { manifest, version };
}

export { sha256Hex as contentSha256, CONTENT_TYPES };
