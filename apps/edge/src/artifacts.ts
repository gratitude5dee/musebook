// apps/edge/src/artifacts.ts — §11.11/§11.18: the artifacts.musebook.dev read
// path. Deliberately carries NO database access: /a/ maps only to a/public/
// keys and /t/{ticket}/ maps only to a/private/ keys after an Ed25519 verify,
// so neither arm can read Postgres — visibility is a key prefix, not a check.
// The five §2.8 headers are set here in Worker code on every response, because
// R2 stores httpMetadata and not security headers.
import {
  artifactKey,
  importTicketPublicKey,
  verifyTicket,
  VERSION_RE,
} from "@musebook/artifacts";
import { bound } from "./db/client.js";
import { passthrough } from "./http.js";

const ARTIFACT_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; " +
  "frame-ancestors https://musebook.dev https://www.musebook.dev; " +
  "base-uri 'none'; form-action 'none'";

/** §2.8's canonical header table — every artifact response, including 404s. */
function withArtifactHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", ARTIFACT_CSP);
  headers.set("cross-origin-resource-policy", "same-site");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), xr-spatial-tracking=()",
  );
  return new Response(res.body, { status: res.status, headers });
}

const notFound = () => withArtifactHeaders(new Response(null, { status: 404 }));

/** Hostname guard is upstream. `/a/{id}/{v}/{path}` is public and cacheable;
 *  `/t/{ticket}/a/{id}/{v}/{path}` is private behind a 300-second ticket. */
export async function serveArtifact(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((s) => s.length > 0);

  if (parts[0] === "a" && parts.length >= 4) {
    const [, artifactId, version, ...rest] = parts;
    return publicArtifact(request, env, ctx, artifactId, version, rest);
  }
  if (parts[0] === "t" && parts.length >= 6 && parts[2] === "a") {
    const [, ticket, , artifactId, version, ...rest] = parts;
    return privateArtifact(request, env, ticket, artifactId, version, rest);
  }
  return notFound();
}

/** The free arm: straight to the cacheable PaidMedia entrypoint with the
 *  request URL rewritten onto the a/public/{version}/{path} key. No ticket,
 *  no kernel call, no database read. */
async function publicArtifact(
  request: Request,
  _env: Env,
  ctx: ExecutionContext,
  artifactId: string | undefined,
  version: string | undefined,
  rest: string[],
): Promise<Response> {
  if (artifactId === undefined || version === undefined || rest.length === 0) {
    return notFound();
  }
  let key: string;
  try {
    key = artifactKey("public", version, rest.join("/"));
  } catch {
    return notFound();
  }

  const url = new URL(request.url);
  url.pathname = `/${key}`;
  const upstream = new Request(url.toString(), {
    method: request.method,
    headers: passthrough(request.headers),
  });
  const res = await (ctx.exports.PaidMedia as Fetcher).fetch(upstream);
  // Range (206) and conditional (304) answers pass through with the §2.8
  // headers stamped on top — the bucket prefix is what scopes this arm.
  return withArtifactHeaders(
    new Response(res.body, { status: res.status, headers: res.headers }),
  );
}

/** The paid arm: the ticket certifies the decision mintTicket's caller already
 *  made. claims.a and claims.v pin the (artifactId, version) pair; on any
 *  mismatch the answer is a bare 404 — the ticket's validity stays an oracle. */
async function privateArtifact(
  request: Request,
  env: Env,
  ticket: string | undefined,
  artifactId: string | undefined,
  version: string | undefined,
  rest: string[],
): Promise<Response> {
  if (
    ticket === undefined ||
    artifactId === undefined ||
    version === undefined ||
    rest.length === 0 ||
    version.match(VERSION_RE) === null
  ) {
    return notFound();
  }
  let key: string;
  try {
    key = artifactKey("private", version, rest.join("/"));
  } catch {
    return notFound();
  }

  const pem = env.ARTIFACT_TICKET_PUBLIC_KEY;
  if (pem === undefined || pem === "") return notFound();
  const publicKey = await importTicketPublicKey(pem);
  const claims = await verifyTicket(publicKey, ticket);
  if (claims === null || claims.a !== artifactId || claims.v !== version) {
    return notFound();
  }

  const bucket = bound(env.ARTIFACTS, "ARTIFACTS");
  // Range/conditional headers are forwarded only when present: workerd treats
  // a passed-but-empty Headers as a range request and would answer 206.
  const ranged = request.headers.has("range") || request.headers.has("if-none-match");
  const object = ranged
    ? await bucket.get(key, { range: request.headers, onlyIf: request.headers })
    : await bucket.get(key);
  if (object === null || !("body" in object)) {
    const status = request.headers.has("if-none-match") ? 304 : 412;
    return withArtifactHeaders(new Response(null, { status }));
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  // The entry document is re-checkable per activation; a .glb riding the same
  // ticket may be cached for the ticket's remaining life and no longer.
  headers.set(
    "cache-control",
    rest.join("/") === "index.html" ? "private, no-store" : "private, max-age=240",
  );
  headers.set("etag", object.httpEtag);

  // 206 only when the caller actually asked for a range — some local R2
  // shapes report a range field on a plain get.
  const status = request.headers.has("range") && object.range !== undefined ? 206 : 200;
  return withArtifactHeaders(
    new Response(request.method === "HEAD" ? null : object.body, { status, headers }),
  );
}
