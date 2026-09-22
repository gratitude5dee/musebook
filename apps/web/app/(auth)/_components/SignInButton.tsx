// apps/web/app/(auth)/_components/SignInButton.tsx — §5.2 verbatim.
"use client";
import { ConnectButton } from "thirdweb/react";
import { base } from "thirdweb/chains";
import type { LoginPayload } from "thirdweb/auth";
import { client } from "@musebook/ui/thirdweb/client";
import { wallets } from "@musebook/ui/thirdweb/wallets";

export function SignInButton() {
  return (
    <ConnectButton
      client={client}
      wallets={wallets}
      chain={base}
      theme="dark"
      appMetadata={{ name: "Musebook", url: "https://musebook.dev" }}
      connectModal={{ size: "compact", showThirdwebBranding: false }}
      connectButton={{ label: "Sign in" }}
      autoConnect={{ timeout: 15_000 }}
      auth={{
        getLoginPayload: async ({ address, chainId }) => {
          const r = await fetch(`/api/auth/payload?address=${address}&chainId=${chainId}`, {
            credentials: "same-origin",
          });
          if (!r.ok) throw new Error(`payload ${r.status}`);
          return (await r.json()) as LoginPayload;
        },
        doLogin: async ({ payload, signature }) => {
          const r = await fetch("/api/auth/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payload, signature }),
          });
          if (!r.ok) throw new Error(await r.text());
        },
        isLoggedIn: async () => (await fetch("/api/auth/me", { credentials: "same-origin" })).ok,
        doLogout: async () => {
          await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
            headers: { "x-musebook-csrf": "1" },
          });
        },
      }}
    />
  );
}
