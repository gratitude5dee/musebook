// packages/media/src/node/video.ts — video frame extraction for §11.9 gate 3
// (frames at 0/50/90%) and §11.10's phash_frames soft binding (10/50/90%).
//
// NODE ONLY. ffmpeg runs in neither workerd nor the plain Vercel Node runtime:
// production extraction runs inside the pinned `MEDIA_SANDBOX_IMAGE` Vercel
// Sandbox (networkPolicy 'deny-all'), reached from the provenance endpoint;
// local dev/tests fall back to the system ffmpeg binary via fluent-ffmpeg.
import { perceptualHash } from "./provenance";

export interface VideoFrameEnv {
  /** Pinned sandbox image with ffmpeg baked in; unset → local ffmpeg. */
  MEDIA_SANDBOX_IMAGE?: string;
}

const EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

async function probeDurationSeconds(localPath: string): Promise<number | null> {
  const ffmpeg = (await import("fluent-ffmpeg")).default;
  return new Promise((resolve) => {
    ffmpeg.ffprobe(localPath, (err: Error | null, meta) => {
      if (err) resolve(null);
      else {
        const d = (meta as { format?: { duration?: number } }).format?.duration;
        resolve(typeof d === "number" ? d : null);
      }
    });
  });
}

async function extractFrameLocal(
  inputPath: string,
  atSeconds: number,
  outPath: string,
): Promise<void> {
  const ffmpeg = (await import("fluent-ffmpeg")).default;
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(atSeconds)
      .frames(1)
      .outputOptions("-vf", "scale=512:-1")
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (e: Error) => reject(e))
      .run();
  });
}

/**
 * Extract frames at the given fractions of duration (0< f <1), each scaled to
 * 512px wide jpeg. Returns the jpeg bytes per fraction — empty array when the
 * duration cannot be probed (a corrupt container yields no gate-3 frames).
 */
export async function extractVideoFrames(
  bytes: Buffer,
  mimeType: string,
  fractions: readonly number[],
  env: VideoFrameEnv = {},
): Promise<Buffer[]> {
  if (env.MEDIA_SANDBOX_IMAGE) {
    return extractVideoFramesSandbox(bytes, mimeType, fractions, env.MEDIA_SANDBOX_IMAGE);
  }
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "mb-media-"));
  try {
    const input = path.join(dir, `input.${EXT[mimeType] ?? "mp4"}`);
    await writeFile(input, bytes);
    const duration = await probeDurationSeconds(input);
    if (!duration) return [];
    const out: Buffer[] = [];
    for (const f of fractions) {
      const frame = path.join(dir, `frame-${f}.jpg`);
      await extractFrameLocal(input, duration * f, frame);
      out.push(await readFile(frame));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractVideoFramesSandbox(
  bytes: Buffer,
  mimeType: string,
  fractions: readonly number[],
  image: string,
): Promise<Buffer[]> {
  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.create({
    image,
    networkPolicy: "deny-all",
  });
  try {
    await sandbox.writeFiles([
      { path: `/vercel/sandbox/input.${EXT[mimeType] ?? "mp4"}`, content: bytes },
    ]);
    // Probe duration, then one ffmpeg call per fraction. deny-all means no
    // apt-get — the binary is baked into the image or the feature is off.
    const probe = await sandbox.runCommand({
      cmd: "ffprobe",
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        `/vercel/sandbox/input.${EXT[mimeType] ?? "mp4"}`,
      ],
    });
    if (probe.exitCode !== 0) return [];
    const stdout = await probe.output();
    const duration = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const out: Buffer[] = [];
    for (const f of fractions) {
      const name = `frame-${f}.jpg`;
      const run = await sandbox.runCommand({
        cmd: "ffmpeg",
        args: [
          "-y",
          "-ss",
          String(duration * f),
          "-i",
          `/vercel/sandbox/input.${EXT[mimeType] ?? "mp4"}`,
          "-frames:v",
          "1",
          "-vf",
          "scale=512:-1",
          `/vercel/sandbox/${name}`,
        ],
      });
      if (run.exitCode !== 0) continue;
      out.push(Buffer.from(await sandbox.readFile({ path: `/vercel/sandbox/${name}` })));
    }
    return out;
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

/** §11.10's soft binding: one pHash per frame → assets.phash_frames bit(64)[]. */
export async function videoPhashFrames(frames: readonly Buffer[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of frames) out.push(await perceptualHash(f));
  return out;
}
