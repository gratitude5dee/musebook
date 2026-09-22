import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Origin only. Every public byte arrives through musebook-edge; the
  // <project>.vercel.app surface stays reachable for previews but proxy.ts
  // 404s anything lacking the x-musebook-edge header (CF-SPINE §1.4).
  poweredByHeader: false,
};

export default nextConfig;
