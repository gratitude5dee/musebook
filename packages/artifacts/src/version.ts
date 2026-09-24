// packages/artifacts/src/version.ts — pure, and therefore runs in both runtimes.
export async function computeVersion(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const lines: string[] = [];
  for (const [path, body] of files) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
    lines.push(`${path}\0${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  }
  lines.sort();
  const root = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.join("\n"))),
  );
  return [...root]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
