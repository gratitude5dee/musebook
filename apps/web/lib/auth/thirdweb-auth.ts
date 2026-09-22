// apps/web/lib/auth/thirdweb-auth.ts — §5.3 verbatim.
// Server only, never imported from a client component.
import "server-only";
import { createAuth } from "thirdweb/auth";
import type {
  GenerateLoginPayloadParams,
  LoginPayload,
  VerifyLoginPayloadParams,
  VerifyLoginPayloadResult,
} from "thirdweb/auth";
import type { JWTPayload } from "thirdweb/utils";
import { createThirdwebClient } from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";

// createAuth's return type reaches VerifiedLoginPayload through
// generateJWT's parameter — thirdweb does not export that type name, so the
// exported surface is declared here with public names only (VerifiedLoginPayload
// is LoginPayload & branded, so callers stay assignable).
type ThirdwebAuth = {
  generatePayload: (params: GenerateLoginPayloadParams) => Promise<LoginPayload>;
  verifyPayload: (params: VerifyLoginPayloadParams) => Promise<VerifyLoginPayloadResult>;
  generateJWT: (params: { payload: LoginPayload; context?: unknown }) => Promise<string>;
  verifyJWT: (params: {
    jwt: string;
  }) => Promise<{ valid: true; parsedJWT: JWTPayload } | { valid: false; error: string }>;
};

// Secrets live in Vercel env, absent at `next build` page-data collection when
// route modules are merely imported — so the client/account/auth objects are
// built on first call, not at module evaluation. The Proxy keeps call sites
// (`thirdwebAuth.verifyPayload(...)`) byte-identical to §5.3.
let cached: ReturnType<typeof createAuth> | undefined;
function live() {
  if (cached === undefined) {
    const client = createThirdwebClient({
      secretKey: process.env.THIRDWEB_SECRET_KEY!,
    });
    cached = createAuth({
      domain: process.env.NEXT_PUBLIC_THIRDWEB_AUTH_DOMAIN!,
      client,
      adminAccount: privateKeyToAccount({
        client,
        privateKey: process.env.THIRDWEB_ADMIN_PRIVATE_KEY!,
      }),
      login: {
        statement: "Sign in to Musebook.",
        uri: "https://musebook.dev",
        version: "1",
        payloadExpirationTimeSeconds: 600,
      },
    });
  }
  return cached;
}

export const thirdwebAuth = new Proxy({} as ThirdwebAuth, {
  get: (_target, prop: string | symbol) =>
    (live() as unknown as Record<PropertyKey, unknown>)[prop],
});
