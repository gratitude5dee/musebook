// packages/connectors/src/sign.ts — §10.8.4
// Musebook signs its OWN outbound calls: RFC 9421 HTTP Message Signatures with
// Ed25519 via web-bot-auth@0.2.0, the same wire format musebook-edge verifies on
// the way in. The four parameters §10.8.4 fixes:
//   alg = ed25519 (signerFromJWK, no compat flag), tag = 'web-bot-auth' (the
//   library's fixed tag), expires = created + 60 s, covered components =
//   @authority + signature-agent (the entry keyed 'musebook').
import { generateNonce, sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import type { JsonWebKey } from "./types.js";

export const SIGNATURE_AGENT_ENTRY =
  'musebook="<https://musebook.dev/.well-known/http-message-signatures-directory>";type=directory';
const SIGNATURE_AGENT_KEY = "musebook";
const EXPIRES_MS = 60_000;

/**
 * Returns a RequestInit with the signature headers applied over init's headers.
 * guardedFetch calls this on every outbound request when a signing key is
 * configured; the signature is identification, never authorization.
 */
export async function signOutbound(
  url: URL,
  init: RequestInit,
  privateJwk: JsonWebKey,
): Promise<RequestInit> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? {});
  headers.set("signature-agent", SIGNATURE_AGENT_ENTRY);

  const now = new Date();
  const fields = await sign(
    new Request(url, {
      method,
      headers,
      // sign() only reads the method/target/headers of the descriptor.
    }),
    {
      signer: await signerFromJWK(privateJwk),
      created: now,
      expires: new Date(now.getTime() + EXPIRES_MS),
      nonce: generateNonce(),
      signatureAgentKey: SIGNATURE_AGENT_KEY,
    },
  );

  headers.set("signature", fields.signature);
  headers.set("signature-input", fields.signatureInput);
  return { ...init, method, headers };
}
