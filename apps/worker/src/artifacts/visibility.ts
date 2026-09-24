// apps/worker/src/artifacts/visibility.ts — §11.12's visibility move.
// Bounded by 11.13's 5 MB / 64-file bundle cap and 11.15's 12 MB GLB cap, so the
// worst case is ~17 MB and 64 objects — comfortably inside one invocation.
export async function moveArtifactVisibility(
  env: Env,
  was: "public" | "private",
  now: "public" | "private",
  version: string,
  manifestPaths: string[],
): Promise<void> {
  for (const path of manifestPaths) {
    const from = `a/${was}/${version}/${path}`;
    const to = `a/${now}/${version}/${path}`;
    const obj = await env.ARTIFACTS.get(from);
    if (!obj) throw new Error(`visibility move: missing ${from}`);
    await env.ARTIFACTS.put(to, obj.body, { httpMetadata: obj.httpMetadata ?? {} });
  }
  // Delete AFTER every put succeeds. Delete is free; a half-moved artifact is not.
  await env.ARTIFACTS.delete(manifestPaths.map((p) => `a/${was}/${version}/${p}`));
}
