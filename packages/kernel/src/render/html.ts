// packages/kernel/src/render/html.ts — the Worker-rendered document (§6.6, §14.2.10).
// A denied render must never depend on a second system being up: this document
// inlines its ~2KB token subset, fetches no fonts, and references no fingerprinted
// /_next/static/ asset. The one script it loads is the stable public asset
// /unlock.js, which upgrades the pay link when Vercel is up and is harmless when not.
import type { AccessDecision, Resource } from "@musebook/schema";
import { markdownToHtml } from "@musebook/content";
import { jsonLdFor } from "./jsonld";
import { previewOf } from "./preview";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// §14.2.10: the ~2KB token subset — light theme, system font fallbacks only.
const STYLE = [
  ":root{",
  "--background:#FBFAF7;--foreground:#12100E;--muted-foreground:#5E584F;",
  "--card:#FFFFFF;--border-strong:#7D766B;--gate:#8A5A00;--gate-tint:#FBF2DF;",
  "--radius:0.625rem;--font-serif:ui-serif,Georgia,serif;",
  "--font-sans:ui-sans-serif,system-ui,sans-serif;}",
  "body{margin:0 auto;max-width:44rem;padding:2rem 1.25rem;background:var(--background);",
  "color:var(--foreground);font-family:var(--font-serif);font-size:1.0625rem;line-height:1.7;}",
  "h1{font-size:2rem;line-height:1.2;}",
  "a{color:var(--gate);}",
  ".musebook-paywall{margin-top:2.5rem;padding:1.5rem;border:1px solid var(--border-strong);",
  "border-radius:var(--radius);background:var(--gate-tint);font-family:var(--font-sans);}",
  ".musebook-paywall .unlock{display:inline-block;margin-top:0.75rem;padding:0.625rem 1.25rem;",
  "border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--card);",
  "color:var(--foreground);text-decoration:none;font-weight:600;}",
  ".musebook-paywall .how{color:var(--muted-foreground);font-size:0.875rem;}",
].join("");

function head(resource: Resource, origin: string, ld: Record<string, unknown>): string {
  const url = `${origin}/p/${resource.slug}`;
  const canonical = resource.canonicalUrl ?? url;
  const title = resource.title ?? resource.summary ?? resource.slug;
  return [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(`${title} — Musebook`)}</title>`,
    `<meta name="description" content="${esc(resource.summary ?? "")}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:description" content="${esc(resource.summary ?? "")}">`,
    `<meta property="article:published_time" content="${esc(resource.publishedAt ?? "")}">`,
    `<meta property="article:author" content="${esc(`${origin}/@${resource.authorHandle}`)}">`,
    `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    `<style>${STYLE}</style>`,
  ].join("\n");
}

export function renderHtml(
  resource: Resource,
  decision: AccessDecision,
  origin: string,
  previewChars: number,
): string {
  const ld = jsonLdFor(resource, decision, origin);
  const title = resource.title ?? resource.summary ?? resource.slug;

  if (decision.bodyKind === "empty") {
    return [
      `<!doctype html>`,
      `<html lang="${esc(resource.languageCode)}">`,
      `<head>`,
      `<meta charset="utf-8">`,
      `<title>${esc(String(decision.httpStatus))} — Musebook</title>`,
      `</head>`,
      `<body>`,
      `<p>${esc(decision.allow ? "" : decision.reason)}</p>`,
      `</body>`,
      `</html>`,
    ].join("\n");
  }

  if (decision.bodyKind === "preview") {
    // The sentinel is a markdown-level marker; strip it before HTML so it never
    // renders as visible text in the teaser document.
    const teaser = previewOf(resource.canonicalMarkdown, previewChars).replace(
      /\n*<!-- musebook:paywall -->\s*$/,
      "",
    );
    const price = `$${resource.priceUsd ?? "0.00"}`;
    return [
      `<!doctype html>`,
      `<html lang="${esc(resource.languageCode)}">`,
      `<head>`,
      head(resource, origin, ld),
      `</head>`,
      `<body>`,
      `<article>${markdownToHtml(teaser)}</article>`,
      `<div class="musebook-paywall">`,
      `<p><strong>This one is paid.</strong></p>`,
      `<p>Unlock the rest for ${esc(price)}. @${esc(resource.authorHandle)} gets the creator share.</p>`,
      `<p><a class="unlock" href="${esc(`${origin}/pay/${resource.postId}`)}">Unlock · ${esc(price)}</a></p>`,
      `<p><a class="how" href="${esc(`${origin}/publishing-modes#x402`)}">How x402 works</a></p>`,
      `</div>`,
      `<script type="module" defer src="/unlock.js"></script>`,
      `</body>`,
      `</html>`,
    ].join("\n");
  }

  return [
    `<!doctype html>`,
    `<html lang="${esc(resource.languageCode)}">`,
    `<head>`,
    head(resource, origin, ld),
    `</head>`,
    `<body>`,
    `<article>`,
    `<h1>${esc(title)}</h1>`,
    markdownToHtml(resource.canonicalMarkdown),
    `</article>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}
