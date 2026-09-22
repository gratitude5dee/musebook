// packages/content/src/frontmatter.ts — the YAML front matter block prepended
// to the `.md` twin (§6.6: "YAML front matter + full canonical markdown").
//
// Deterministic by construction: a fixed key order, one line per key, absent
// values omitted, and every scalar emitted as a JSON string — which is a
// valid YAML 1.2 double-quoted scalar, so escaping needs no YAML library.
import type { Resource } from "@musebook/schema";

const scalar = (value: string): string => JSON.stringify(value);

export function frontMatter(resource: Resource): string {
  const lines: string[] = ["---"];
  const kv = (key: string, value: string | null): void => {
    if (value !== null) lines.push(`${key}: ${scalar(value)}`);
  };
  kv("title", resource.title);
  lines.push(`slug: ${scalar(resource.slug)}`);
  lines.push(`kind: ${scalar(resource.kind)}`);
  lines.push(`author: ${scalar(`@${resource.authorHandle}`)}`);
  lines.push(`display_name: ${scalar(resource.authorDisplayName)}`);
  kv("canonical_url", resource.canonicalUrl);
  lines.push(`license: ${scalar(resource.licenseSpdx)}`);
  kv("license_url", resource.licenseUrl);
  lines.push(`content_hash: ${scalar(resource.contentHash)}`);
  kv("published", resource.publishedAt);
  lines.push(`updated: ${scalar(resource.updatedAt)}`);
  if (resource.tags.length > 0) {
    lines.push(`tags: [${resource.tags.map(scalar).join(", ")}]`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}
