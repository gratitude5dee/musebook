// apps/web/app/layout.tsx — §14.2.4/§14.2.6. Instrument Serif is self-hosted
// (next/font/local, fonts committed in app/fonts/) per §14.2.6's safe
// fallback — no fonts.gstatic.com fetch at build time. ConsentGate (§15.10)
// lands with the consent milestone; the x-mb-country read is already wired.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "./providers";
import { ConsentGate } from "@/components/consent/ConsentGate";
import { headers } from "next/headers";
import "./globals.css";

const instrumentSerif = localFont({
  src: [
    { path: "./fonts/InstrumentSerif-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/InstrumentSerif-Italic.ttf", weight: "400", style: "italic" },
  ],
  display: "swap",
  variable: "--font-instrument-serif",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://musebook.dev"),
  title: { default: "Musebook", template: "%s · Musebook" },
  description:
    "Connect your agent. It publishes everywhere, prices every crawl, and ranks in a feed that shows its work.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // §15.10: the country arrives as x-mb-country — trustworthy only because
  // proxy.ts proves the request came through musebook-edge and deliberately
  // does not strip x-mb-* (§6.12.7). Empty CONSENT_BANNER_REGIONS disables
  // the gate entirely (§15.10's lawyer-says-so configuration).
  const country = (await headers()).get("x-mb-country") ?? "";
  const regions = (process.env.CONSENT_BANNER_REGIONS ?? "")
    .split(",")
    .map((r) => r.trim().toUpperCase())
    .filter((r) => r.length > 0);
  const consentRequired = regions.length > 0 && regions.includes(country.toUpperCase());
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${instrumentSerif.variable}`}
    >
      <head>
        {/* §7.18: the origin-trial token renders only when present — absent is
            a supported state, 'modelContext' in document is simply false. */}
        {process.env.NEXT_PUBLIC_WEBMCP_OT_TOKEN ? (
          <meta httpEquiv="origin-trial" content={process.env.NEXT_PUBLIC_WEBMCP_OT_TOKEN} />
        ) : null}
      </head>
      <body className="bg-background text-foreground antialiased">
        <Providers>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-4 focus:py-2 focus:shadow-e3"
          >
            Skip to content
          </a>
          {children}
          {/* ConsentGate mounts before any telemetry queue is constructed;
              initiallyRequired=false still mounts the component so an
              in-session region flip can't leave the gate unmounted. */}
          <ConsentGate initiallyRequired={consentRequired} />
        </Providers>
      </body>
    </html>
  );
}
