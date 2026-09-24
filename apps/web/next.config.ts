import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Origin only. Every public byte arrives through musebook-edge; the
  // <project>.vercel.app surface stays reachable for previews but proxy.ts
  // 404s anything lacking the x-musebook-edge header (CF-SPINE §1.4).
  poweredByHeader: false,
  experimental: {
    // Server Actions verify Origin against x-forwarded-host; behind
    // musebook-edge the forwarded host is always the internal origin host,
    // never the public one — allow the zone plus the local dev origin.
    serverActions: {
      allowedOrigins: ["musebook.dev", "www.musebook.dev", "127.0.0.1:8787"],
    },
  },
  transpilePackages: [
    "@musebook/distributor",
    "@musebook/ui",
    "@musebook/content",
    "@musebook/kernel",
    "@musebook/media",
    "@musebook/schema",
    "@musebook/x402",
  ],
  // Native/node binaries under @musebook/media/node (the web provenance
  // route's only import): c2pa-node ships a .node binary Turbopack cannot
  // place in ESM chunks; sharp/fluent-ffmpeg are the same class. They run
  // under node require at runtime instead.
  serverExternalPackages: ["@contentauth/c2pa-node", "sharp", "fluent-ffmpeg", "@vercel/sandbox"],
  turbopack: {
    resolveAlias: {
      // Optional Solana path in @coinbase/cdp-sdk — never imported on the
      // Base-only wallet flow; pnpm's strict layout doesn't hoist it.
      "@x402/svm/exact/client": "./stubs/empty-module.ts",
    },
  },
};

export default nextConfig;
